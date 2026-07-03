#!/usr/bin/env python3
"""
Generate narration audio + sentence timings from a narration manifest, using the
ElevenLabs Text-to-Speech "with-timestamps" endpoint.

Default granularity is PER CARD (one continuous, seamless take per card; the player
highlights sentences from the timestamps). Use --granularity block to split a single
finicky card into per-block clips later — without redoing anything else.

Each unit writes (into clips/):
  <id>.mp3              audio                 (card: s2-card01.mp3 | block: s2-c01-14.mp3)
  <id>.alignment.json   raw char timestamps from ElevenLabs
  <id>.timing.json      blocks + sentence start/end times (drives highlighting)
  <id>.settings.json    voice/model/seed + exact text (reproducibility)

Corrections: fix a word via a pronunciation-dictionary entry (durable) or edit the
block's `tts` in the manifest, then regenerate just that unit. Idempotent + seed-locked.

Usage:
  python3 module/audio/generate.py --list
  python3 module/audio/generate.py                              # all cards
  python3 module/audio/generate.py --cards s2-card02            # one card
  python3 module/audio/generate.py --cards s2-card07 --force    # redo one card
  python3 module/audio/generate.py --granularity block --cards s2-card07   # split that card
"""
import os, sys, re, json, base64, argparse, urllib.request, urllib.error
from pathlib import Path
from collections import OrderedDict

HERE = Path(__file__).resolve().parent
DEFAULT_MANIFEST = HERE / "narration-section2.json"
CLIPS_DIR = HERE / "clips"

VOICE_SETTINGS = {"stability": 0.4, "similarity_boost": 0.75, "style": 0.3, "use_speaker_boost": True}
OUTPUT_FORMAT = "mp3_44100_128"


def load_env():
    vals = {}
    for parent in [HERE, *HERE.parents]:
        envf = parent / ".env"
        if envf.exists():
            for line in envf.read_text().splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    vals[k.strip()] = v.strip()
            break
    get = lambda k, d=None: os.environ.get(k) or vals.get(k, d)
    return {"key": get("ELEVENLABS_API_KEY"), "voice": get("ELEVENLABS_VOICE_ID"),
            "model": get("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2"),
            "seed": int(get("ELEVENLABS_SEED", "12345"))}


def section_of(bid): return bid.split("-", 1)[0]
def card_of(bid):
    m = re.match(r"([a-z0-9]+)-c(\d+)-\d+", bid)
    return f"{m.group(1)}-card{m.group(2)}"


def sentence_spans(text):
    spans, start = [], 0
    for m in re.finditer(r'[.!?]+["”\'\)\]]*(?=\s|$)', text):
        spans.append((start, m.end()))
        start = m.end()
        while start < len(text) and text[start].isspace():
            start += 1
    if start < len(text):
        spans.append((start, len(text)))
    return [(s, e) for (s, e) in spans if text[s:e].strip()]


def build_timing(unit_blocks, full_text, alignment):
    """Map char timestamps -> per-block, per-sentence start/end seconds within this clip."""
    chars = alignment.get("characters", [])
    starts = alignment.get("character_start_times_seconds", [])
    ends = alignment.get("character_end_times_seconds", [])
    if not (len(chars) == len(starts) == len(ends)) or "".join(chars) != full_text:
        return None
    def ts(i): return starts[max(0, min(i, len(starts) - 1))]
    def te(i): return ends[max(0, min(i, len(ends) - 1))]
    out, cursor = [], 0
    for b in unit_blocks:
        seg = b["tts"]
        bs = full_text.index(seg, cursor); be = bs + len(seg); cursor = be
        sents = [{"i": si, "start": round(ts(bs + s), 3), "end": round(te(bs + e - 1), 3),
                  "tts": seg[s:e].strip()} for si, (s, e) in enumerate(sentence_spans(seg))]
        out.append({"id": b["id"], "start": round(ts(bs), 3), "end": round(te(be - 1), 3),
                    "sentences": sents})
    return {"duration": round(te(len(ends) - 1), 3), "blocks": out}


def tts_request(cfg, text, prev_text, next_text):
    url = (f"https://api.elevenlabs.io/v1/text-to-speech/{cfg['voice']}"
           f"/with-timestamps?output_format={OUTPUT_FORMAT}")
    payload = {"text": text, "model_id": cfg["model"], "voice_settings": VOICE_SETTINGS, "seed": cfg["seed"]}
    if prev_text: payload["previous_text"] = prev_text
    if next_text: payload["next_text"] = next_text
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST", headers={
        "xi-api-key": cfg["key"], "Content-Type": "application/json", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode())


def build_units(blocks, granularity):
    """Return ordered list of (unit_id, [blocks]) and a flat index for neighbour context."""
    if granularity == "block":
        return [(b["id"], [b]) for b in blocks]
    cards = OrderedDict()
    for b in blocks:
        cards.setdefault(card_of(b["id"]), []).append(b)
    return list(cards.items())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    ap.add_argument("--granularity", choices=["card", "block"], default="card")
    ap.add_argument("--cards", help="comma-separated card ids to limit to")
    ap.add_argument("--blocks", help="comma-separated block ids to limit to (forces block granularity)")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--flat", action="store_true", help="manifest is a flat [{id,tts}] list (one standalone clip each, no timing)")
    args = ap.parse_args()

    if args.flat:
        entries = json.load(open(args.manifest, encoding="utf-8"))
        if args.list:
            for e in entries:
                print(f"  {e['id']:<16} {len(e['tts'])} chars")
            print(f"\n{len(entries)} clips · {sum(len(e['tts']) for e in entries)} chars")
            return
        cfg = load_env()
        if not cfg["key"]:
            sys.exit("ELEVENLABS_API_KEY is empty — add it to .env and retry.")
        CLIPS_DIR.mkdir(exist_ok=True)
        for e in entries:
            mp3 = CLIPS_DIR / f"{e['id']}.mp3"
            if mp3.exists() and not args.force:
                print(f"· skip {e['id']} (exists)"); continue
            print(f"→ {e['id']}  ({len(e['tts'])} chars) …", flush=True)
            try:
                resp = tts_request(cfg, e["tts"], None, None)
            except urllib.error.HTTPError as ex:
                print(f"  ✗ HTTP {ex.code}: {ex.read().decode()[:200]}"); continue
            except urllib.error.URLError as ex:
                print(f"  ✗ network error: {ex}"); continue
            mp3.write_bytes(base64.b64decode(resp["audio_base64"]))
            (CLIPS_DIR / f"{e['id']}.settings.json").write_text(json.dumps({
                "voice_id": cfg["voice"], "model_id": cfg["model"], "seed": cfg["seed"],
                "voice_settings": VOICE_SETTINGS, "output_format": OUTPUT_FORMAT, "text": e["tts"],
            }, indent=1, ensure_ascii=False))
            print(f"  ✓ {mp3.name}")
        print("done.")
        return

    blocks = json.load(open(args.manifest, encoding="utf-8"))
    gran = "block" if args.blocks else args.granularity
    units = build_units(blocks, gran)

    if args.blocks:
        want = {x.strip() for x in args.blocks.split(",")}
        units = [(uid, ub) for uid, ub in units if uid in want]
    elif args.cards:
        want = {x.strip() for x in args.cards.split(",")}
        units = [(uid, ub) for uid, ub in units if (uid if gran == "card" else card_of(uid)) in want]

    if args.list:
        total = 0
        for uid, ub in units:
            text = "\n\n".join(b["tts"] for b in ub)
            total += len(text)
            print(f"  {uid:<12} {len(ub):>2} blk  {len(text):>5} chars")
        print(f"\n{len(units)} {gran}s · {total} chars")
        return

    cfg = load_env()
    if not cfg["key"]:
        sys.exit("ELEVENLABS_API_KEY is empty — add it to .env and retry.")
    CLIPS_DIR.mkdir(exist_ok=True)

    first = {ub[0]["id"]: k for k, (_, ub) in enumerate(units)}  # for neighbour lookup
    idx = {b["id"]: i for i, b in enumerate(blocks)}
    for uid, ub in units:
        mp3 = CLIPS_DIR / f"{uid}.mp3"
        if mp3.exists() and not args.force:
            print(f"· skip {uid} (exists)"); continue
        text = "\n\n".join(b["tts"] for b in ub)
        # neighbour context = block just before/after this unit, same section only
        i0, i1 = idx[ub[0]["id"]], idx[ub[-1]["id"]]
        prev_text = blocks[i0 - 1]["tts"] if i0 > 0 and section_of(blocks[i0 - 1]["id"]) == section_of(uid) else None
        next_text = blocks[i1 + 1]["tts"] if i1 + 1 < len(blocks) and section_of(blocks[i1 + 1]["id"]) == section_of(uid) else None
        print(f"→ {uid}  ({len(text)} chars) …", flush=True)
        try:
            resp = tts_request(cfg, text, prev_text, next_text)
        except urllib.error.HTTPError as e:
            print(f"  ✗ HTTP {e.code}: {e.read().decode()[:300]}"); continue
        except urllib.error.URLError as e:
            print(f"  ✗ network error: {e}"); continue

        mp3.write_bytes(base64.b64decode(resp["audio_base64"]))
        alignment = resp.get("alignment") or {}
        (CLIPS_DIR / f"{uid}.alignment.json").write_text(json.dumps(alignment))
        timing = build_timing(ub, text, alignment)
        if timing:
            (CLIPS_DIR / f"{uid}.timing.json").write_text(json.dumps(timing, indent=1, ensure_ascii=False))
        else:
            print("  ! alignment didn't match text — skipped timing.json (audio is fine)")
        (CLIPS_DIR / f"{uid}.settings.json").write_text(json.dumps({
            "voice_id": cfg["voice"], "model_id": cfg["model"], "seed": cfg["seed"],
            "voice_settings": VOICE_SETTINGS, "output_format": OUTPUT_FORMAT,
            "granularity": gran, "text": text, "previous_text": prev_text, "next_text": next_text,
        }, indent=1, ensure_ascii=False))
        print(f"  ✓ {mp3.name}  ({timing['duration'] if timing else '?'}s)")

    print("done.")


if __name__ == "__main__":
    main()
