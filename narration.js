/* ──────────────────────────────────────────────────────────────────────────
   narration.js — listen-along audio player for the training deck.

   One continuous MP3 per card (audio/clips/<section>-card<NN>.mp3) plus a timing
   JSON (blocks -> sentences -> start/end seconds, from ElevenLabs with-timestamps).
   Sentences are wrapped in <span class="nsent"> at runtime and highlighted as the
   audio plays. Tap a sentence to play from it; tap the playing sentence to pause.

   A slim strip docks under the header: ‹ (prev sentence) · play/pause ·
   › (next sentence) · title · time · speed. Prev/next step sentence-by-sentence
   and roll into the adjacent card at the edges (section nav stays on the bottom bar).

   Usage (after LUC.partNav):
     const nav = LUC.partNav({ ..., onCardChange: (i,t) => Narration.setCard(i) });
     Narration.init({ deck, section: 's2', clipsBase: 'audio/clips/', goto: nav.goto });
     Narration.setCard(0);
   ────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // Narratable elements, in document order (count per card must match the manifest block count).
  const NARRATABLE = ['h1', 'h2', 'h3', 'h4', 'p', 'li', 'blockquote', 'figcaption'].join(',');
  const SKIP_WITHIN = '[aria-hidden="true"],button,svg,a,.no-narrate,.qcheck-answer,.rep-cols,.scenario-feedback,.part-nav,.spot-reveal,.spot-complete,.video-hint,.hero-fineprint,.listen-hint,.wiz,.illus-badge,.smatrix-caption,.specmx-cap';
  const VIDEO_LINES = '.walkthrough-bubble, .callout.with-video .callout-body p';   // tap-to-play, not TTS
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const RATES = [1, 1.25, 1.5];
  const ICON_PLAY = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M7 5h3.4v14H7zM13.6 5H17v14h-3.4z"/></svg>';
  // media skip-track glyphs (distinct from the page-nav arrows)
  const ICON_PREV = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="currentColor"><path d="M7 6h2.2v12H7zM18 6 9.5 12 18 18z"/></svg>';
  const ICON_NEXT = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="currentColor"><path d="M14.8 6H17v12h-2.2zM6 6l8.5 6L6 18z"/></svg>';

  let cfg = null;
  let bar, audio, playBtn, speedBtn, timeEl;
  let cards = [];            // per index: {state:'ready'|'none', flat:[], src, title}
  let activeIdx = -1;
  let activeUnit = -1;
  let playing = false;
  let autoContinue = false;
  let listenIntent = false;  // user has actively chosen to listen; carries across card nav until they pause
  let pendingStart = null;   // 'first' | 'last' — where to begin after a roll-over
  let rateIdx = 0;
  let ready = false;         // bar built (after the header has rendered)
  let pendingCard = null;    // setCard() called before the bar existed
  let coachShown = false;    // first-load "prefer to listen?" tip
  let clipAudio = null, clipEl = null;   // one-off clips (scenario feedback, spot reveals)
  const wiredVideos = new Set();   // cards whose video-paired lines are wired
  let resumeAfterVideo = null;     // video we auto-played mid-narration; resume narration when it ends
  let activeVideoLine = null;      // the caption/bubble highlighted while its clip plays in sequence
  const firedVideos = new Set();   // in-sequence videos already played this card visit (no re-fire)
  const companion = {};            // cardIdx -> media element that plays IN SYNC with narration (not instead of it)

  // ── sentence helpers ──────────────────────────────────────────────────────
  function sentenceSpans(t) {
    const spans = []; let start = 0;
    // Two alternatives so the on-screen sentence count matches the TTS:
    //  1. a normal terminator (period not part of an acronym), followed by space/end.
    //  2. an acronym-final period (e.g. the last dot of C.A.L.M./B.S./U.S.) ONLY when
    //     it actually ends a sentence — i.e. followed by space + a capital. Mid-phrase
    //     uses ("C.A.L.M. method", "C.A.L.M. —") are left intact. This mirrors the TTS
    //     normaliser, which keeps a period after CALM/B-S only at a sentence boundary.
    const re = /(?<!\.[A-Za-z])[.!?]+["”')\]]*(?=\s|$)|(?<=\.[A-Za-z])[.!?]+["”')\]]*(?=\s+[A-Z]|$)/g; let m;
    while ((m = re.exec(t))) {
      const end = m.index + m[0].length;
      spans.push([start, end]); start = end;
      while (start < t.length && /\s/.test(t[start])) start++;
    }
    if (start < t.length) spans.push([start, t.length]);
    return spans.filter(([s, e]) => t.slice(s, e).trim().length);
  }

  function blockEls(card) {
    return Array.from(card.querySelectorAll(NARRATABLE))
      .filter(el => !el.closest(SKIP_WITHIN))
      .filter(el => !(el.tagName === 'P' && el.closest('.callout.with-video')));  // video-paired quote
  }

  function wrapRanges(el, ranges, flatStart) {
    const txt = el.textContent;
    const owner = new Int16Array(txt.length).fill(-1);
    ranges.forEach((r, k) => { for (let i = r[0]; i < r[1]; i++) owner[i] = k; });
    const byRange = ranges.map(() => []);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    const nodes = []; let n; while ((n = walker.nextNode())) nodes.push(n);
    let g = 0;
    nodes.forEach(node => {
      const t = node.nodeValue, parent = node.parentNode;
      const frag = document.createDocumentFragment();
      let i = 0;
      while (i < t.length) {
        const o = owner[g + i];
        let j = i + 1; while (j < t.length && owner[g + j] === o) j++;
        const piece = t.slice(i, j);
        if (o >= 0) {
          const span = document.createElement('span');
          span.className = 'nsent'; span.dataset.ni = String(flatStart + o);
          span.textContent = piece;
          frag.appendChild(span); byRange[o].push(span);
        } else {
          frag.appendChild(document.createTextNode(piece));
        }
        i = j;
      }
      g += t.length;
      parent.replaceChild(frag, node);
    });
    return byRange;
  }

  // ── card preparation ──────────────────────────────────────────────────────
  function cardId(i) { return cfg.section + '-card' + String(i + 1).padStart(2, '0'); }
  // Deck pages: one entry per .card-slide. Single pages (intro/outro): the whole container is one card.
  function cardEls() { return cfg.container ? [cfg.container] : cfg.deckEl.querySelectorAll('.card-slide'); }

  function prepareCard(i) {
    if (cards[i]) return Promise.resolve(cards[i]);
    const id = cardId(i);
    return fetch(cfg.clipsBase + id + '.timing.json')
      .then(r => { if (!r.ok) throw new Error('no timing'); return r.json(); })
      .then(timing => {
        const card = cardEls()[i];
        const els = blockEls(card);
        const flat = [];
        const blockStarts = [];          // flat index where each SECTION begins (heading-delimited)
        const blockLastUnit = [];        // flat index of the LAST sentence of each block
        if (els.length !== timing.blocks.length)
          console.warn(`[narration] ${id}: DOM blocks (${els.length}) ≠ timing blocks (${timing.blocks.length}); block-level highlight.`);
        els.forEach((el, bi) => {
          const tb = timing.blocks[bi]; if (!tb) return;
          const isHeading = /^H[1-4]$/.test(el.tagName);
          if (isHeading || blockStarts.length === 0) blockStarts.push(flat.length);  // new section at each heading
          const onscreen = sentenceSpans(el.textContent);
          let ranges, times;
          if (onscreen.length === tb.sentences.length) {
            ranges = onscreen; times = tb.sentences.map(s => [s.start, s.end]);
          } else {
            ranges = [[0, el.textContent.length]]; times = [[tb.start, tb.end]];
          }
          const byRange = wrapRanges(el, ranges, flat.length);
          ranges.forEach((_, k) => flat.push({ start: times[k][0], end: times[k][1], spans: byRange[k] }));
          blockLastUnit[bi] = flat.length - 1;
        });
        // Make the first span of each sentence a focusable seek target (keyboard parity with tap-to-seek).
        flat.forEach(u => { const s = u.spans && u.spans[0]; if (s) { s.tabIndex = 0; s.setAttribute('role', 'button'); } });
        // Anchor each demo video (walkthrough steps + with-video callouts) to the LAST
        // narrated unit of its group, so continuous-listen plays the clip in sequence
        // and then resumes into the next block. Keyed by flat-unit index.
        const videoAfter = {};
        card.querySelectorAll('.walkthrough-step, .callout.with-video').forEach(group => {
          const video = group.querySelector('video');
          if (!video) return;
          let lastBi = -1;
          els.forEach((el, bi) => { if (blockLastUnit[bi] != null && group.contains(el)) lastBi = bi; });
          if (lastBi >= 0) videoAfter[blockLastUnit[lastBi]] = video;
        });
        const heading = card.querySelector('h2,h3');
        cards[i] = { state: 'ready', flat, blockStarts, videoAfter, src: cfg.clipsBase + id + '.mp3',
                     title: heading ? heading.textContent.trim() : 'Listen' };
        // Load the clip as an in-memory blob so seeking is reliable even when the host
        // doesn't honor HTTP byte-range requests (e.g. `python3 -m http.server`), which
        // otherwise leaves audio.seekable empty and drops every forward seek back to 0:00.
        // A blob: URL is fully seekable regardless of the server.
        return fetch(cards[i].src)
          .then(r => (r.ok ? r.blob() : null))
          .then(blob => { if (blob) cards[i].src = URL.createObjectURL(blob); return cards[i]; })
          .catch(() => cards[i]);
      })
      .catch(() => { cards[i] = { state: 'none' }; return cards[i]; });
  }

  // ── playback / highlight ───────────────────────────────────────────────────
  function fmt(s) { s = Math.max(0, s | 0); return (s / 60 | 0) + ':' + String(s % 60).padStart(2, '0'); }

  // One-off clips for tap-to-hear feedback (scenario feedback, spot reveals).
  function stopClip() {
    if (clipAudio && !clipAudio.paused) clipAudio.pause();
    if (clipEl) clipEl.classList.remove('nclip-playing');
    clipEl = null;
  }
  function playClip(src, el) {
    if (!clipAudio) {
      clipAudio = new Audio();
      clipAudio.addEventListener('ended', () => { if (clipEl) clipEl.classList.remove('nclip-playing'); clipEl = null; });
    }
    if (clipEl === el && !clipAudio.paused) { stopClip(); return; }   // tap again to pause
    pause();                                                          // stop main narration
    if (clipEl && clipEl !== el) clipEl.classList.remove('nclip-playing');
    if (!clipAudio.src.endsWith(src)) clipAudio.src = src;
    clipAudio.currentTime = 0;
    clipAudio.play().then(() => { clipEl = el; el.classList.add('nclip-playing'); }).catch(() => {});
  }

  function play() {
    const c = cards[activeIdx]; if (!c || c.state !== 'ready') return;
    stopClip();
    if (!audio.src.endsWith(c.src)) audio.src = c.src;
    audio.playbackRate = RATES[rateIdx];
    audio.play().then(() => {
      playing = true; listenIntent = true; try { sessionStorage.setItem('lucListen', '1'); } catch (e) {} playBtn.innerHTML = ICON_PAUSE; playBtn.setAttribute('aria-label', 'Pause');
      const m = companion[activeIdx];
      if (m) { m.muted = true; try { m.playbackRate = RATES[rateIdx]; } catch (e) {} m.play().catch(() => {}); }
    }).catch(() => {});
  }
  // Generic pause — used both by the user (pause button / tap) and programmatically
  // (card switch, video/clip tap). It does NOT touch listenIntent; callers that
  // represent a deliberate user stop clear listenIntent themselves.
  function pause() { audio.pause(); playing = false; playBtn.innerHTML = ICON_PLAY; playBtn.setAttribute('aria-label', 'Play'); const m = companion[activeIdx]; if (m && !m.paused) m.pause(); }
  function toggle() { if (playing) { listenIntent = false; try { sessionStorage.removeItem('lucListen'); } catch (e) {} pause(); } else play(); }

  function setActiveUnit(k, scroll) {
    if (k === activeUnit) return;
    const c = cards[activeIdx]; if (!c || c.state !== 'ready') return;
    if (activeUnit >= 0 && c.flat[activeUnit]) c.flat[activeUnit].spans.forEach(s => s.classList.remove('is-active'));
    activeUnit = k;
    if (k < 0 || !c.flat[k]) return;
    const spans = c.flat[k].spans;
    spans.forEach(s => s.classList.add('is-active'));
    if (scroll && spans[0]) {
      const r = spans[0].getBoundingClientRect();
      const top = ((document.querySelector('.topbar') || {}).offsetHeight || 0) + 12;
      const bottomSafe = window.innerHeight - 90;
      if (r.top < top || r.bottom > bottomSafe)
        spans[0].scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
    }
  }

  function seekToUnit(k, autoplay) {
    const c = cards[activeIdx]; if (!c || c.state !== 'ready' || !c.flat[k]) return;
    if (!audio.src.endsWith(c.src)) { audio.src = c.src; }
    setActiveUnit(k, true);
    const target = c.flat[k].start + 0.001;
    // Apply the seek now if the element can take it; otherwise wait for metadata.
    // Setting currentTime before HAVE_METADATA is silently dropped (the clip then
    // plays from 0:00), which is what made "start from anywhere" fail right after
    // a card switch (setCard calls audio.load(), resetting readyState to 0).
    // A forward seek only "sticks" once the target time is seekable — its byte range
    // is fetchable (range-capable host) or already downloaded. Seeking before then is
    // dropped by the browser and playback falls back to 0:00 (which then re-highlights
    // the top line). So gate the seek on seekability, buffering until it's reachable.
    // Reachable if the target sits inside a seekable OR a buffered range. Some hosts —
    // and the local `python3 -m http.server` dev server — don't honor byte-range requests,
    // so `audio.seekable` comes back EMPTY even at readyState 4 (whole clip downloaded).
    // `audio.buffered` still reflects the downloaded data we can seek into, so check both.
    const covers = (ranges) => { if (!ranges) return false; for (let i = 0; i < ranges.length; i++) { if (ranges.end(i) >= target - 0.05) return true; } return false; };
    const seekable = () => covers(audio.seekable) || covers(audio.buffered);
    const applySeek = () => {
      if (activeUnit !== k) return;   // a later tap superseded this one
      audio.currentTime = target;
      if (audio.duration) timeEl.textContent = fmt(audio.currentTime) + ' / ' + fmt(audio.duration);
      const m = companion[activeIdx];   // keep the synced video at the same point as the narration
      if (m && m.duration && audio.duration) { try { m.currentTime = Math.min(m.duration, target * (m.duration / audio.duration)); } catch (e) {} }
      if (autoplay) play();
    };
    if (audio.readyState >= 1 && seekable()) {
      applySeek();
    } else {
      audio.preload = 'auto';
      const EV = ['loadedmetadata', 'durationchange', 'progress', 'canplay', 'canplaythrough'];
      function onReady() {
        if (activeUnit !== k) { detach(); return; }   // a later tap superseded this one
        if (audio.readyState >= 1 && seekable()) { detach(); applySeek(); }
      }
      const detach = () => EV.forEach(ev => audio.removeEventListener(ev, onReady));
      EV.forEach(ev => audio.addEventListener(ev, onReady));
      if (audio.readyState === 0) audio.load();
    }
  }

  function onTime() {
    const c = cards[activeIdx]; if (!c || c.state !== 'ready') return;
    const t = audio.currentTime;
    if (audio.duration) timeEl.textContent = fmt(t) + ' / ' + fmt(audio.duration);
    if (!playing) return;   // don't move/show the highlight when paused (e.g. a stray timeupdate on load)
    let idx = -1;
    for (let k = 0; k < c.flat.length; k++) { if (t >= c.flat[k].start - 0.02 && t < c.flat[k].end) { idx = k; break; } }
    if (idx !== activeUnit) {
      // Continuous-listen finished narrating a step that has a demo video (anchored
      // to activeUnit) and is moving forward — into the next block OR the silent gap
      // before it (idx === -1). Play the clip in sequence, then resume. The
      // t >= end check confirms we actually finished it (guards against backward seeks).
      if (playing && activeUnit >= 0 && c.videoAfter && c.videoAfter[activeUnit]
          && t >= c.flat[activeUnit].end - 0.05
          && (idx === -1 || idx > activeUnit)
          && !firedVideos.has(activeIdx + ':' + activeUnit)) {
        firedVideos.add(activeIdx + ':' + activeUnit);
        fireVideo(c.videoAfter[activeUnit]);
        return;
      }
      setActiveUnit(idx, playing);
    }
  }

  // Pause narration, play a step's demo video, and queue narration to resume after it.
  function fireVideo(video) {
    setActiveUnit(-1);                                // drop the sentence highlight (don't jump to the next header)
    // No seek: audio is already paused right at the block boundary, so resuming flows
    // straight into the next block. Seeking here would fire timeupdate and re-highlight
    // the upcoming header while the video plays.
    pause();                                          // programmatic — leaves listenIntent intact
    resumeAfterVideo = video;
    // Highlight the caption/bubble this clip delivers while it plays.
    const line = video.closest('.walkthrough-step, .callout.with-video');
    activeVideoLine = line ? line.querySelector(VIDEO_LINES) : null;
    if (activeVideoLine) activeVideoLine.classList.add('is-playing');
    const target = activeVideoLine || video;
    try { video.currentTime = 0; } catch (e) {}
    target.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
    video.play().catch(() => { resumeAfterVideo = null; clearVideoLine(); });
  }

  function clearVideoLine() {
    if (activeVideoLine) { activeVideoLine.classList.remove('is-playing'); activeVideoLine = null; }
  }

  function onEnded() { pause(); }   // stop at the end of a card — no auto-advance; user taps Next / ›

  // ── section (block) skip — ‹ › step block-to-block within the single clip,
  //    rolling into the adjacent card at the edges. Highlight stays sentence-level.

  // activeUnit is -1 in the silent gaps between blocks; fall back to the audio
  // position so skip doesn't think we're "before block 0" and loop on the header.
  function effectiveUnit() {
    if (activeUnit >= 0) return activeUnit;
    const c = cards[activeIdx]; if (!c || !c.flat) return -1;
    const t = audio.currentTime; let u = -1;
    for (let k = 0; k < c.flat.length; k++) { if (c.flat[k].start <= t + 0.05) u = k; else break; }
    return u;
  }
  function curBlock() {
    const bs = cards[activeIdx].blockStarts; const u = effectiveUnit(); let b = -1;
    for (let i = 0; i < bs.length; i++) { if (bs[i] <= u) b = i; else break; }
    return b;
  }
  // ‹ › step sentence-by-sentence (these demo cards have one heading each, so
  // section-level stepping would just jump whole cards). Roll into the adjacent
  // card at the edges.
  function nextSection() {
    const c = cards[activeIdx]; if (!c || c.state !== 'ready') return;
    const u = effectiveUnit();
    if (u + 1 < c.flat.length) { seekToUnit(u + 1, true); return; }
    // At the last narrated unit: if this card has an un-revealed reveal (quick-check),
    // open it — that plays its answer clip in sequence — instead of rolling straight to
    // the next card and skipping the playable answer. A second › then advances.
    if (cfg.revealSelector) {
      const card = cardEls()[activeIdx];
      const rev = card && card.querySelector(cfg.revealSelector);
      if (rev) { rev.click(); return; }
    }
    if (activeIdx < cardEls().length - 1) { autoContinue = true; pendingStart = 'first'; cfg.goto(activeIdx + 1); }
  }
  function prevSection() {
    const c = cards[activeIdx]; if (!c || c.state !== 'ready') return;
    const u = effectiveUnit();
    if (u > 0) seekToUnit(u - 1, true);
    else if (activeIdx > 0) { autoContinue = true; pendingStart = 'last'; cfg.goto(activeIdx - 1); }
  }

  // Wire video-paired lines: tap to play the clip (and pause narration).
  function wireVideos(i) {
    if (wiredVideos.has(i)) return; wiredVideos.add(i);
    const card = cardEls()[i]; if (!card) return;
    card.querySelectorAll('video').forEach(v => {
      // Companion videos play WITH narration; only standalone demo videos pause it.
      if (companion[i] !== v) v.addEventListener('play', pause);
      // If we auto-played this clip mid-narration, resume the narration when it ends.
      v.addEventListener('ended', () => {
        if (resumeAfterVideo === v) { resumeAfterVideo = null; clearVideoLine(); play(); }
      });
    });
    card.querySelectorAll(VIDEO_LINES).forEach(el => {
      const cont = el.closest('.walkthrough-step, .callout.with-video');
      const video = cont && cont.querySelector('video');
      if (!video) return;
      el.classList.add('nvideo');
      el.title = 'Play the clip';
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', 'Play clip: ' + el.textContent.trim().replace(/^["'“”]+|["'“”]+$/g, '').slice(0, 80));
      const trigger = () => {
        if (!video.paused) { video.pause(); return; }   // tap again to pause the clip
        pause();                                          // stop narration, then play the clip
        video.play().catch(() => {});
      };
      el.addEventListener('click', trigger);
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); trigger(); } });
    });
  }

  // ── card switching ──────────────────────────────────────────────────────────
  function setCard(i) {
    if (!ready) { pendingCard = i; return; }   // header not rendered yet; apply once built
    if (i === activeIdx) return;
    pause(); stopClip(); activeUnit = -1;   // also stop a one-off feedback/reveal clip on card change
    // Stop any companion video that isn't on the destination card (covers every nav path).
    for (const k in companion) { if (+k !== i && companion[k] && !companion[k].paused) { try { companion[k].pause(); } catch (e) {} } }
    // Leaving a card: stop any in-sequence video and clear per-card video state.
    if (resumeAfterVideo) { try { resumeAfterVideo.pause(); } catch (e) {} resumeAfterVideo = null; }
    clearVideoLine();
    firedVideos.clear();
    activeIdx = i;
    wireVideos(i);
    const wasContinuing = autoContinue; autoContinue = false;
    const start = pendingStart; pendingStart = null;
    prepareCard(i).then(c => {
      if (i !== activeIdx) return;
      if (c.state === 'ready') {
        audio.src = c.src; audio.load();
        timeEl.textContent = '0:00';
        setEnabled(true);
        maybeCoach();
        if (wasContinuing) seekToUnit(start === 'last' ? c.flat.length - 1 : 0, true);
        else if (listenIntent) play();   // user was listening; keep narrating the new card automatically
      } else {
        setEnabled(false);
        timeEl.textContent = '0:00';
      }
    });
  }

  // ── tap-to-jump / tap-to-pause ──────────────────────────────────────────────
  function onDeckClick(e) {
    if (cfg.deckEl) {  // deck pages: only the active card is interactive
      const card = e.target.closest('.card-slide');
      if (!card || !card.classList.contains('active')) return;
    }
    const c = cards[activeIdx];
    if (!c || !c.flat.length) return;
    // A sentence span IS the seek target (it carries role="button" for keyboard parity),
    // so check it FIRST — before any interactive-control guard, which would otherwise
    // swallow the click on the span itself.
    let sp = e.target.closest('.nsent');
    if (!sp) {
      // Clicked off a sentence. Don't hijack real controls (they carry their own click
      // behavior) or an active text selection — otherwise seek to the nearest sentence
      // (2D distance to each sentence's box; 0 when the point is inside it).
      if (e.target.closest('button,a,input,select,textarea,label,summary,[role="button"],.qcheck-answer,.scenario-feedback')) return;
      try { if (String(window.getSelection && window.getSelection()).trim()) return; } catch (e2) {}
      const scope = cfg.deckEl ? document.querySelector('.card-slide.active') : (cfg.container || document);
      const spans = scope ? scope.querySelectorAll('.nsent') : [];
      let best = null, bestD = Infinity;
      for (let i = 0; i < spans.length; i++) {
        const r = spans[i].getBoundingClientRect();
        if (!r.width && !r.height) continue;
        const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right);
        const dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = spans[i]; }
      }
      sp = best;
      if (!sp) return;
    }
    const ni = +sp.dataset.ni;
    if (!c.flat[ni]) return;
    if (ni === activeUnit && playing) { listenIntent = false; try { sessionStorage.removeItem('lucListen'); } catch (e3) {} pause(); return; }
    seekToUnit(ni, true);
  }

  // Keyboard activation of a focused sentence (Enter / Space).
  function onDeckKey(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const sp = e.target.closest && e.target.closest('.nsent'); if (!sp) return;
    e.preventDefault();
    onDeckClick({ target: sp });
  }

  // ── bar UI (merged into the header) ──────────────────────────────────────────
  function setEnabled(on) { bar.classList.toggle('is-disabled', !on); }

  // First-load coachmark: points at the play button, shown once (localStorage).
  function maybeCoach() {
    if (coachShown) return;
    coachShown = true;
    try { if (localStorage.getItem('lucNarrationCoach2')) return; } catch (e) {}
    const tip = document.createElement('div');
    tip.className = 'nb-coach';
    tip.innerHTML =
      '<div class="nb-coach-arrow"></div>' +
      '<p>🎧 <strong>Prefer to listen?</strong> Tap play to hear this read aloud — or tap any line to jump there.</p>' +
      '<button type="button" class="nb-coach-ok">Got it</button>';
    document.body.appendChild(tip);
    const r = playBtn.getBoundingClientRect();
    const w = Math.min(290, window.innerWidth - 24);
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - w - 12));
    tip.style.width = w + 'px';
    tip.style.left = left + 'px';
    const arrow = tip.querySelector('.nb-coach-arrow');
    arrow.style.left = (r.left + r.width / 2 - left - 7) + 'px';
    // The nav bar sits at the bottom of the screen, so place the tip ABOVE the button
    // when it's in the lower half of the viewport (otherwise it lands off-screen).
    if (r.top < window.innerHeight / 2) {
      tip.style.top = (r.bottom + 12) + 'px';
      arrow.style.top = '-6px'; arrow.style.bottom = 'auto';
    } else {
      tip.style.top = (r.top - tip.offsetHeight - 12) + 'px';
      arrow.style.top = 'auto'; arrow.style.bottom = '-6px';
    }
    playBtn.classList.add('nb-pulse');
    function dismiss() {
      tip.remove(); playBtn.classList.remove('nb-pulse');
      document.removeEventListener('click', onDoc, true);
      try { localStorage.setItem('lucNarrationCoach2', '1'); } catch (e) {}
    }
    function onDoc(e) { if (!tip.contains(e.target)) dismiss(); }
    tip.querySelector('.nb-coach-ok').addEventListener('click', dismiss);
    setTimeout(() => document.addEventListener('click', onDoc, true), 60);
  }

  function buildBar() {
    const host = document.querySelector('.part-nav [data-role="audio"]') || document.body;
    bar = document.createElement('div');
    bar.className = 'nb-controls is-disabled';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Narration controls');
    bar.innerHTML =
      '<button class="nb-btn" data-r="prev" aria-label="Previous section">' + ICON_PREV + '</button>' +
      '<button class="nb-play" data-r="play" aria-label="Play" title="Play / Pause (Space)" aria-keyshortcuts="Space">' + ICON_PLAY + '</button>' +
      '<button class="nb-btn" data-r="next" aria-label="Next section">' + ICON_NEXT + '</button>' +
      '<button class="nb-btn nb-speed" data-r="speed" aria-label="Playback speed" title="Playback speed (S)" aria-keyshortcuts="S">1×</button>' +
      '<span class="nb-time" aria-hidden="true">0:00</span>';
    host.appendChild(bar);
    playBtn = bar.querySelector('[data-r="play"]');
    speedBtn = bar.querySelector('[data-r="speed"]');
    timeEl = bar.querySelector('.nb-time');

    playBtn.addEventListener('click', toggle);
    bar.querySelector('[data-r="prev"]').addEventListener('click', prevSection);
    bar.querySelector('[data-r="next"]').addEventListener('click', nextSection);
    function cycleSpeed() {
      rateIdx = (rateIdx + 1) % RATES.length;
      audio.playbackRate = RATES[rateIdx];
      speedBtn.textContent = RATES[rateIdx] + '×';
    }
    speedBtn.addEventListener('click', cycleSpeed);

    // Keyboard shortcuts: Space = play/pause, S = cycle playback speed. Both no-op when
    // this card has no clip (bar disabled), and both stay out of the way when focus is on a
    // field or control (so Space still activates buttons / types, and "s" can be typed).
    document.addEventListener('keydown', (e) => {
      const t = e.target;
      const inField = t && t.closest && t.closest('input, textarea, select, [role="combobox"], [contenteditable="true"]');
      // An overlay menu / modal is open — let it own the keyboard (don't steal Space or S).
      if (document.querySelector('[aria-modal="true"], .lightbox-overlay, .wiz-modal.open, .m6-toc:not([hidden]), .pa-toc, .pa-search.expanded')) return;
      if (e.key === ' ' || e.code === 'Space') {
        if (inField || (t && t.closest && t.closest('button, a, [role="button"], .wiz-modal.open, .lightbox-overlay, [role="dialog"]'))) return;
        if (!bar || bar.classList.contains('is-disabled')) return;
        e.preventDefault();   // stop the page from scrolling
        toggle();
      } else if (e.key === 's' || e.key === 'S') {
        if (inField) return;
        if (!bar || bar.classList.contains('is-disabled')) return;
        e.preventDefault();
        cycleSpeed();
      }
    });
  }

  function init(opts) {
    cfg = { deckEl: opts.deck || null, container: opts.container || null, section: opts.section,
            clipsBase: opts.clipsBase || 'audio/clips/', goto: opts.goto,
            revealSelector: opts.revealSelector || null };
    // Carry "listening" intent across page loads so narration resumes on the next page
    // (subject to the browser's autoplay policy — silently no-ops if blocked).
    try { if (sessionStorage.getItem('lucListen')) listenIntent = true; } catch (e) {}
    cards = [];
    // 'auto' (not 'metadata') so the whole short clip buffers — this makes seeking
    // to any sentence reliable. With 'metadata' the audio data isn't fetched, so a
    // seek to an unbuffered point gets dropped and playback falls back to 0:00.
    audio = new Audio(); audio.preload = 'auto';
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('ended', onEnded);
    // Build AFTER shared.js renderTopbar() (DOMContentLoaded) so our controls aren't wiped.
    const start = function () {
      buildBar();
      const surface = cfg.container || cfg.deckEl;
      surface.addEventListener('click', onDeckClick);
      surface.addEventListener('keydown', onDeckKey);
      ready = true;
      if (pendingCard != null) { const p = pendingCard; pendingCard = null; setCard(p); }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }

  function bindMedia(idx, el) { if (el) companion[idx] = el; }

  // Hard stop — narration + every companion video. Called by lightbox/quick-ref so playback
  // never keeps running behind an overlay, and won't auto-resume (clears listen intent).
  function pauseAll() {
    listenIntent = false;
    try { sessionStorage.removeItem('lucListen'); } catch (e) {}
    pause();
    for (const k in companion) { try { if (companion[k] && !companion[k].paused) companion[k].pause(); } catch (e) {} }
  }

  // True when the learner is actively listening (playing now, or chose to listen and hasn't
  // paused). Callers use this to decide whether to AUTO-play a feedback/answer clip — so a
  // silent reader is never surprised by audio; they can still tap "Listen" on demand.
  function listening() { return listenIntent || playing; }
  function isPlaying() { return playing; }   // actively playing right now (not just intending to)

  window.Narration = { init, setCard, playClip, bindMedia, pauseAll, listening, isPlaying, next: nextSection, prev: prevSection };
})();
