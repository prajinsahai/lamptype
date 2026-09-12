# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

LampType is a typing test: static HTML/CSS/JS, no build step, no dependencies, no
network calls. `README.md` is the design document — it explains *why* the lamp,
the race model, 1-word mode and the results guard behave as they do. Read the
relevant section before changing any of them.

## Commands

```bash
# Run it — that is the whole setup.
start index.html            # or: python -m http.server 8000 --directory .

# Tests: open tests.html in a browser. Every row should say PASS.
start tests.html

# Before deploying, find every unfilled placeholder:
grep -rn "TODO-\|lamptype.example\|pub-0000000000000000" .
```

There is no npm, no runner, no lint step. A "single test" is one `check('name', ...)`
block inside the inline `<script>` in `tests.html`; comment out the others or read
its row.

## Architecture

Classic scripts (no ES modules, so `file://` works) each attach to one shared
`window.TT` namespace inside an IIFE. **Load order is dependency order** and is
declared twice — at the bottom of `index.html` and again in `tests.html`. Adding
or renaming a module means editing both, or the tests silently stop covering it.

Exports: `TT.words`, `TT.stats`, `TT.config` / `TT.storage`, `TT.chart` /
`TT.chartMath`, `TT.reveal`, `TT.createLamp` / `TT.lampMath`, `TT.createPetals` /
`TT.petalMath`, `TT.race`, `TT.createEngine`, `TT.createRenderer`, `TT.createUI` /
`TT.createGuard` / `TT.format`.

The flow is: `main.js` boots, grabs the DOM, and wires an engine to a renderer and
a ui. `engine.js` is a state machine that emits `rebuild | append | start | key |
paint | tick | finish`; `main.js` subscribes and pushes the result into `render.js`,
`ui.js`, `lamp.js`, `petals.js` and `race.js`. Nothing calls back into the engine
except through its own methods.

### Rules the code depends on

- **DOM-free core.** `words.js`, `stats.js`, `engine.js`, `race.js` and the
  `*Math` exports touch no DOM. That is the only reason `tests.html` can drive
  them directly. Keep new arithmetic on that side of the line.
- **Wall clock, never frame accumulation.** Elapsed time is always recomputed as
  `now - startTime`; the lamp blobs, the petals and the AI opponent's position are
  closed-form functions of elapsed time. A dropped frame must change nothing. Do
  not refactor any of these into per-frame deltas — for the race it is a fairness
  bug, not a style preference.
- **`textContent` only.** No `innerHTML` with dynamic data anywhere in `js/`. The
  shipped CSP allows `'unsafe-inline'` for AdSense and is only defensible because
  of this. Re-audit `_headers` / `vercel.json` if it changes.
- **Offline and `file://` must keep working.** No webfonts, no CDNs, no fetch, no
  dependencies. Font stacks name preferred faces first and fall back to OS fonts.
- **`prefers-reduced-motion` and `visibilitychange`.** Both canvas modules
  (`lamp.js`, `petals.js`) start/stop on tab visibility and on theme change, and
  render a single still frame under reduced motion. Any new animation follows suit.

### Where things are configured

`TT.config` in `js/storage.js` is the single source of truth for modes, mode
lengths, themes and colour modes; `storage.js` validates persisted settings
against it on load. A new mode is one entry in the `MODES` table plus its values
array — not a new branch in `main.js`.

Themes are CSS-variable blocks in `css/themes.css`, selected by `data-theme` on
`<html>` via `ui.applyTheme()`. Two greys, deliberately: `--sub` is untyped text
and stays dim; `--label` is UI chrome and clears WCAG AA in every theme. Don't
merge them, and don't reach for `opacity` to quieten a label - that is what put
the chrome at 2.17:1 before. Sakura is the exception: a full skin with its own
`css/sakura.css` and `js/petals.js`, with light/dark variants driven by `data-mode`.

### Deployment

Static-host config is duplicated by necessity: `_headers` (Netlify, Cloudflare
Pages) and `vercel.json` carry the same security/caching policy and must not
drift. `netlify.toml` sets `publish = "."` so no build config is needed. GitHub
Pages cannot set headers and is not a good host here. `ads.txt` gates AdSense
revenue and fails silently.
