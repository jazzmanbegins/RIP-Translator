# AGENTS.md

RIP Translator — Chrome Extension (Manifest V3), vanilla JS, **no build step, no tests, no linter, no typecheck**. See `CLAUDE.md` for the architecture overview and `GEMINI.md` for the product overview; this file only covers what an agent will get wrong by default.

## Dev cycle (the only workflow that exists)

1. Edit a file.
2. `chrome://extensions` → click the **reload icon** on the extension card.
3. **Close and reopen** any tab on a supported site (tab refresh alone does NOT re-inject the content script).
4. After **adding a brand-new file** (e.g. a new `site.js`), you must **Remove** the extension and **Load unpacked** again — Chrome ignores new files on a plain reload.

There is no `npm`/`package.json`/`build` step. Do not introduce one.

## Repository layout

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest. `content_scripts` + `host_permissions` are the source of truth for which scripts run where. |
| `content.js` | Udemy (`www.udemy.com`). Custom player. Selector: `[data-purpose="captions-cue-text"]`. Also hosts the Subtitle Collector (`subtitleLog` array). |
| `gamedev.js` | gamedev.tv + the cross-origin `iframe.mediadelivery.net` (BunnyCDN). Plyr player. Selector: `.plyr__caption`. |
| `domestika.js` | Domestika. Video.js. Selector: `.vjs-text-track-cue`. |
| `popup.html`, `popup.js`, `styles.css` | Toolbar popup — settings UI. Talks to the active tab's content script via `chrome.tabs.sendMessage`. |
| `icons/`, `Icon.png` | Toolbar / store icons. |

The three content scripts are **intentionally independent** — no shared modules, no imports. If you need a util in a new script, copy the existing pattern (see `gamedev.js` and `domestika.js`, which are near-clones of each other).

## Shared patterns (don't reinvent)

- **200 ms `setInterval` poll** reads the player's caption element. `content.js` layers a `MutationObserver` on top as a faster trigger.
- **Translation** uses the unofficial Google endpoint `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=…&dt=t&q=…`. This domain must be in `host_permissions`. Response is a deeply nested array; the convention is `data[0].filter(i => i?.[0]).map(i => i[0]).join('')`.
- **Cache**: `const cache = new Map()` keyed by `${targetLang}|${text}`. LRU eviction via `cache.delete(cache.keys().next().value)` when size hits the cap. Caps differ per script — `content.js` = 600, `gamedev.js` = 400, `domestika.js` = 300-ish. When the target language changes, **clear the cache** and reset `currentText` to force a re-translate.
- **Overlay**: `position: fixed; z-index: 2147483647` div appended to `document.body`, or to `document.fullscreenElement` when in fullscreen. On `fullscreenchange`, reparent it.
- **Drag**: store position as viewport ratios `{ rx, ry }`, not pixels — survives resize. Always reset `dragPos = null` on `resize` and `fullscreenchange`, and reposition. **Double-click** the overlay to reset to auto-position.
- **Hide the original captions** with an injected `<style>` tag using `visibility: hidden` (not `display: none`) — the polling code still needs the DOM text to be readable.
- **Settings persistence**: `chrome.storage.sync` with shape `{ enabled: boolean, settings: { fontSize, textColor, bgColor, showOriginal, targetLang } }`. Listen via `chrome.storage.onChanged` for live updates — no page reload needed.
- **SPA nav**: a `setInterval` watches `location.href` every 1 s; on change, `destroyOverlay()` + `clearInterval(pollInterval)` and `setTimeout(waitForPlayer, 1500)`.
- **Font**: each script injects a Google Fonts `<link>` for `Noto Sans Thai` (idempotent — check for an existing element first).

## Adding a new site (the iframe check is the gotcha)

1. Identify the subtitle element (right-click the subtitle text → Inspect).
2. `document.querySelectorAll('iframe').forEach(f => console.log(f.src))` — if the player is in a **cross-origin iframe**, you need:
   - `"all_frames": true` on the content script entry
   - the iframe domain in BOTH `matches` and `host_permissions`
   See `gamedev.js` / `iframe.mediadelivery.net` for the working example.
3. Copy `gamedev.js` or `domestika.js` as a starting template; rename the cache id, the overlay id, the wait-for-player selector, and the caption selector.
4. Edit `manifest.json` — add a `content_scripts` entry and update `host_permissions`.
5. **Remove + Load unpacked** the extension (plain reload won't pick up the new file).

## Subtitle Collector (Udemy only)

`content.js` keeps a `subtitleLog` array. The popup sends messages with `type` of `getLog` / `startCollect` / `stopCollect` / `clearLog`; the handler returns `{ ok: true }` or `{ log, count, collecting }` and must `return true` to keep the message channel open. Saved file is a UTF-8 **BOM** `.txt` via `chrome.downloads`. If you add collector support to another platform, copy this whole block verbatim — it doesn't exist in `gamedev.js` or `domestika.js` yet.

## Common mistakes to avoid

- Don't refactor the three content scripts into a shared module — the duplication is deliberate, keeps each one self-contained for Chrome's isolated content-script world.
- Don't switch the hidden-captions style from `visibility: hidden` to `display: none` — polling breaks.
- Don't translate when the source text is already in the target script — `content.js` short-circuits with a regex check for Thai; mirror that if you add a similar check.
- Don't store drag position in pixels — use viewport ratios or the overlay jumps on resize.
- Don't forget to add a new `host_permissions` entry for any new origin the script `fetch`es.
- The Google Translate endpoint is unofficial and rate-limited; the per-script cache is the main defense. Don't add features that bypass it.
