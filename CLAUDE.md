# CLAUDE.md

This project's architecture, engine APIs, the narration model, and "how to add X" recipes live in
**[AGENTS.md](AGENTS.md)**. Read it before editing.

Quick reminders:
- Vanilla HTML/CSS/JS, **no build step**. Serve over HTTP (`python3 -m http.server`), since `fetch()` of
  audio timings won't work from `file://`.
- When you change narrated text, the **on-screen text must match the manifest `text`**, and the number of
  narratable elements per card must equal the manifest block count. Then regenerate that card's audio.
- Relative paths only (served as a GitHub Pages project site).
