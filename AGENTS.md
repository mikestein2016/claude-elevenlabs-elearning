# Agent & architecture guide

Orientation for an AI coding agent (Claude, Cursor, etc.) — or a human — extending this repo. It covers
what's built, why, and how to add to it safely. You can change anything; this just keeps you from breaking
the two things that are easy to break (narration text↔audio sync, and per-card element counts).

## The big picture

A static, no-build e-learning module: **vanilla HTML/CSS/JS**, three pages, one reusable engine.

- `index.html` — home/hero, narrated in **container mode**.
- `section1.html` — the lesson: a **card deck** (4 `.card-slide`s) with gating, a synced video, and a
  knowledge check.
- `complete.html` — closer, narrated in container mode.
- `shared.js` → `window.LUC` — navigation, gating, progress, lightbox.
- `narration.js` → `window.Narration` — the listen-along audio system.
- `theme.css` — all styling + design tokens (`--brand-*`, `--ink`, `--muted`, etc.).
- `audio/` — the narration **manifests** (the script), `generate.py`, and generated `clips/`.

There is no framework and no bundler. Edit a file, serve the folder over HTTP, refresh.

## Engine APIs

### `LUC.partNav(cfg)` → `{ goto(i) }`  (shared.js)
Builds the top progress bar + bottom nav, and (in deck mode) drives card switching.
- `deck` *(element)* — presence enables **deck mode** (uses `.card-slide` children). Omit for a single-page.
- `sectionLabel` *(string)* — shown centered in the top bar.
- `prevHref`/`prevLabel`, `nextHref`/`nextLabel` — page links (single-page, or deck edges).
- `canAdvance(currentIndex)` → return `true` to allow, or a **string** to block and show that as a toast.
  Runs on every forward move **and on the final exit** (so a last-card check can't be skipped).
- `onGate(currentIndex, blockReason)` *(optional)* → the "open the gate" hook. Called when a blocked
  advance happens (button, swipe, **or** arrow key, so all three inherit the behavior). Return `true` if you
  handled it (suppresses the toast), or `false` to fall through to the toast. Convention: a *reveal* gate
  opens the answer in place and returns `true`; a *video/MC* gate you can't auto-satisfy calls
  `LUC.gatePulse(el)` to scroll + ring the target and returns `false` (the toast still supplies wording).
- `onCardChange(index, total)` — fired on each card move (wire `Narration.setCard` here).

Returns `{ goto(i), jump(i), refreshGate() }`. `goto`/`jump` move to a card (`jump` bypasses the forward
gate, for TOC/search); `refreshGate()` re-checks the current card's gate and grays/un-grays Next.

### `LUC.progress`  (shared.js)
- `markSectionComplete(id)` / `all()` — completion state in `localStorage` (drives the home page's
  locked/Complete states).

### `LUC.lightbox.open(src, alt, opener)`  (shared.js)
- Opens a full-screen image overlay. **Auto-calls `Narration.pauseAll()`** so audio never runs behind it.

### `LUC.gatePulse(el)`  (shared.js)
- Scrolls `el` into view and briefly rings it (a pulse animation, static ring under
  `prefers-reduced-motion`). Use it from `onGate` to point at a gate you won't auto-satisfy.

### `window.Narration`  (narration.js)
- `init({ deck | container, section, clipsBase, goto })` — builds the audio transport into the nav bar's
  `[data-role="audio"]` slot. `deck` = a `.card-slide` deck; `container` = a single element treated as one
  card. `section` = filename prefix for clips (`<section>-cardNN`). `goto` = `partNav().goto` (for rolling
  into the next/prev card at the edges).
- `setCard(i)` — switch the active card (call from `onCardChange`).
- `bindMedia(cardIdx, videoEl)` — register a **companion** `<video>` that plays/pauses/**seeks in sync**
  with that card's narration (not instead of it).
- `playClip(src, el)` — play a **standalone** clip (e.g. quiz feedback) and highlight `el`; tap again to
  pause. Pauses the main narration first.
- `pauseAll()` — hard stop: narration + every companion video, and clears listen-intent.
- `isPlaying()` / `listening()` — `isPlaying` is true only while audio is actively playing; `listening`
  is the softer "intends to listen" state (survives a pause). The arrow-key handler keys off `isPlaying`
  so paused-at-0:00 doesn't hijack the arrows (see the engine-features note below).
- `next()` / `prev()` — step the narration to the next/previous sentence, rolling into the adjacent card
  at the edges. The engine calls these when arrows are pressed *while actively playing*.

## Built-in engine features (free on every page)

These live in `shared.js` / `narration.js` / `theme.css`, so any page that calls `partNav` inherits them
with no per-page code. This engine is the hardened build shared with the production CG IVM modules; the
only per-project differences here are the brand tokens and the top-bar branding.

- **Keyboard.** ← / → page the deck (or step narration while it's actively playing); Space = play/pause,
  S = cycle speed. Guarded so they never hijack a form field, a focused control, or an open menu/lightbox.
  Play/Speed/Back/Next carry `title` tooltips + `aria-keyshortcuts`.
- **Touch.** Swipe left/right = next/back, on touch devices only (`pointer: coarse`), routed through the
  real Back/Next so gating still applies. Won't fire on a control or a horizontally-scrollable widget.
- **Gating UX.** The `onGate` hook (above) turns blocked advances into "open the reveal" or "point at the
  video/question," instead of a dead-end toast. Button, swipe, and arrows all inherit it.
- **Adaptive progress.** Dots when they fit; a continuous fill bar + "X / Y" counter when they'd clip
  (many cards, narrow screen). Forced to the bar at ≤640px. The section title collapses to its short form
  (text before the first colon) under 760px.
- **Accessibility baseline.** An injected `.sr-only` orientation block describes the real controls (and
  only mentions narration when a player exists); a polite live region announces card changes; menus are
  keyboard-operable; `prefers-reduced-motion` is honored in CSS and JS.
- **"More below" cue.** A bobbing chevron appears when a card runs past the fold and fades near the end
  (non-interactive; native scroll does the work).
- **Reliable audio seek.** Clips load as in-memory blobs and seekability checks `buffered` as well as
  `seekable`, so forward seeks work even on hosts that ignore byte-range requests.

## The narration model (read this before touching audio)

1. **Manifests** (`audio/narration-*.json`) are the script. Each block:
   ```json
   { "id": "s1-c04-02", "card": 4, "tag": "p",
     "text": "On-screen text, must match the DOM exactly.",
     "tts":  "What ElevenLabs actually says (may differ slightly)." }
   ```
   - `id` format: `<section>-c<NN>-<MM>` (card NN, block MM).
   - `text` must match the on-screen element's text **character-for-character** (it's what gets split into
     highlightable sentences). `tts` is the spoken version — tweak it for pacing/pronunciation (add a
     comma, expand an acronym) without changing what's shown.
2. **`generate.py`** groups blocks by card and calls the ElevenLabs *with-timestamps* endpoint, writing
   `clips/<section>-cardNN.mp3` + `.timing.json` (per-sentence start/end). It's **seed-locked** and skips
   existing clips (use `--force` to redo one). `--flat` mode = one standalone clip per entry, no timing
   (for feedback).
3. **At runtime**, `narration.js` collects narratable elements **in document order**, wraps each sentence
   in `<span class="nsent">`, and highlights by the timing JSON.

### Two rules that keep it working
- **Per card, the number of narratable elements must equal the number of manifest blocks for that card.**
  Narratable tags: `h1–h4, p, li, blockquote, figcaption` (+ a few classes). Elements inside `SKIP_WITHIN`
  are ignored: `[aria-hidden], button, svg, a, .scenario-feedback, .part-nav, .video-hint,
  .hero-fineprint, .listen-hint`. If counts mismatch, it falls back to block-level highlight (still plays,
  just no per-sentence highlight) and logs a console warning.
- **On-screen `text` must match the manifest `text`** (same sentence count) for per-sentence highlighting.

## How to add things

- **A new card** (in a deck): add `<section class="card-slide"><div class="card">…</div></section>`, add
  matching `card: N` blocks to the manifest (text == DOM), then
  `python3 audio/generate.py --manifest <manifest> --cards <section>-card0N --force`.
- **A new section page**: copy `section1.html`; set `partNav({ deck, sectionLabel, nextHref })` and
  `Narration.init({ deck, section: 's2', clipsBase, goto })`; create `audio/narration-section2.json` with
  `s2-cNN-MM` ids; generate.
- **A gate**: in `canAdvance(i)`, find the card (`deck.querySelectorAll('.card-slide')[i]`), and return
  `true` or a message string when the requirement isn't met (see the video + knowledge-check gates in
  `section1.html`). For the "open the gate" UX, also add an `onGate(i)` that surfaces what's needed:
  `LUC.gatePulse(theTargetEl); return false;` (pulse it, keep the toast), or open a reveal in place and
  `return true`.
- **A companion video**: muted `<video>` with no native controls; `Narration.bindMedia(videoCardIdx, vid)`;
  optionally make clicking it trigger `.nb-play`.
- **Tap-to-hear feedback**: add the line to a `--flat` manifest, generate it, and call
  `Narration.playClip('audio/clips/<id>.mp3', triggerEl)`.
- **Exclude an element from narration**: give it a class already in `SKIP_WITHIN`, or add a new class to
  that list in `narration.js`.

## Conventions & gotchas

- **Relative paths only** — this is served as a GitHub Pages *project* site (under `/<repo>/`).
- **No build step.** Don't add one unless you really mean to.
- **draw.io SVGs are forced to light mode** in the export pipeline so the lines stay black on a dark-mode
  OS. `assets/fold-diagrams.drawio` is the editable source for the six fold steps + the quick-reference.
- **Reskin from one place.** The whole palette comes from the `--brand-*` tokens in `theme.css` `:root`
  (primary/accent/tint + the gradients). Change those values to rebrand a build; don't hardcode colors in
  markup. The top-bar branding (logo + "Quick reference" link) lives in `renderTopbar()` in `shared.js`.
- **Keep the accessibility patterns**: focusable `.nsent` (role=button, tabindex 0 + Enter/Space),
  `sr-only` section headings, ≥4.5:1 text contrast, and state shown by **shape + color** (e.g. the ✓/✗ on
  answers), never color alone. Custom menus need focus management + in-menu arrow/Home/End/Esc handling
  (see the section menu in `section1.html`); the engine's keyboard/menu guards already respect these.
- **TTS is a slot machine across seeds** — same seed/text/voice is identical; bump `ELEVENLABS_SEED` (or
  pass it inline) for a different take of the same line.
- **`fetch()` needs HTTP** (timings won't load from `file://`); **autoplay across page loads is
  browser-gated** (the demo carries listen-intent in `sessionStorage` as best-effort).
