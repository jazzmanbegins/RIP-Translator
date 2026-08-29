# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**RIP Translator** — a Chrome Extension (Manifest V3) that auto-translates subtitles on online course platforms in real-time, overlaying the translation directly on the video. No build step; pure vanilla JS, no `package.json`, no tests, no linter.

## Dev Workflow

There is no build/test/lint command — this is the entire workflow:

```
chrome://extensions → Enable Developer mode → Load unpacked → select this folder
```

- After editing any existing file, click the **reload** icon on the extension card.
- After **adding a new file**, a plain reload isn't enough — you must **Remove** the extension and **Load unpacked** again.
- After reloading, **close and reopen** any tab on a supported site — a tab refresh alone will not re-inject the content script.
- `.claude/launch.json` defines a `popup-preview` config (`npx serve -p 3747 .`) for previewing `popup.html` standalone in a browser tab, without going through the extension reload cycle.
- Git remote: `origin` → `https://github.com/jazzmanbegins/RIP-Translator` (branch `main`). No CI configured.

## Architecture

Each supported platform has its own **isolated, independent** content script — they intentionally share no code/imports (Chrome's isolated-world model per content script; `gamedev.js` and `domestika.js` are near-clones of each other by design, not an oversight). If you need a change in shared logic, apply it to all three files individually.

| Script | Platform | Player | Subtitle selector |
|---|---|---|---|
| `content.js` | Udemy (`www.udemy.com`) | Custom | `[data-purpose="captions-cue-text"]` |
| `gamedev.js` | gamedev.tv + `iframe.mediadelivery.net` | Plyr (in cross-origin BunnyCDN iframe) | `.plyr__caption` |
| `domestika.js` | Domestika (`www.domestika.org`) | Video.js | `.vjs-text-track-cue` |

`popup.html` / `popup.js` — settings UI (font size, text color, bg opacity, target language, subtitle collector). Communicates with the active tab's content script via `chrome.tabs.sendMessage`.

`manifest.json`'s `content_scripts` + `host_permissions` are the source of truth for which scripts run where, and which origins each script is allowed to `fetch()`. Any new fetch target (new translation provider, new platform) must be added to `host_permissions` or the request silently fails.

## Key Patterns (shared across all content scripts)

**Subtitle detection** — `setInterval` poll every 200ms reading the player's caption DOM element. `content.js` also adds a `MutationObserver` as a secondary trigger.

**Translation pipeline** — primary provider is the unofficial Google Translate endpoint (`translate.googleapis.com/translate_a/single?client=gtx&sl=…&tl=…&dt=t&q=…`); response is a deeply nested array, parsed via `data[0].filter(i => i?.[0]).map(i => i[0]).join('')`. Because this endpoint is blocked outright on some ISPs/networks, every script also has a `fetchTranslation()` wrapper that:
- falls back to the MyMemory API (`api.mymemory.translated.net/get?q=…&langpair=sl|tl`, source `auto` mapped to `en` since MyMemory needs a concrete code) when Google's fetch throws;
- once Google fails, sets `googleDownUntil = Date.now() + 5min` and skips retrying it until then, so a blocked endpoint isn't retried (and logged) on every single caption line;
- shows the **original text** in the overlay if both providers fail, rather than leaving it empty;
- logs failures via `console.info` (not `.warn`/`.error`) — Chrome's `chrome://extensions` error panel surfaces `.warn`/`.error` as red runtime errors, which is wrong for an expected/handled fallback path.

Results are cached in a `Map` keyed `` `${sourceLang}|${targetLang}|${text}` ``. Cache is capped (`content.js` = 600, `gamedev.js`/`domestika.js` = 400) with LRU eviction via `cache.keys().next().value`. When the target/source language changes, clear the cache and reset `currentText` to force a re-translate. The cache is also the main defense against rate-limiting on the unofficial Google endpoint — don't add features that bypass it.

**MyMemory quirk** — its free endpoint returns HTTP 200 even when rate-limited/out of quota, putting an English warning string (e.g. `"MYMEMORY WARNING: ..."`) in `responseData.translatedText` and the real error in `responseStatus`. All three scripts' MyMemory call must check `responseStatus === 200` and reject `MYMEMORY WARNING` text before accepting the result — otherwise the warning gets cached and shown as if it were a real translation.

**Skip-if-already-translated** — `content.js` short-circuits `translateText()` with a Thai-Unicode-range regex (`/[฀-๿]/`) when `targetLang === 'th'` and the caption already contains Thai, showing it as-is instead of round-tripping it through a translation API. `gamedev.js`/`domestika.js` don't have this check yet — mirror it there if porting.

**Fonts** — each script injects a Google Fonts `<link>` for `Noto Sans Thai` into `document.head` (idempotent — checks for an existing `<link>` element by id first, since the injection runs on every content-script load).

**Overlay** — a `position: fixed; z-index: 2147483647` div appended to `document.body` (or to `document.fullscreenElement` when in fullscreen). Draggable by mouse/touch; position stored as viewport ratios `{ rx, ry }` (not pixels) so it survives resize. Double-click resets to auto-position. Resize and fullscreenchange events always reset `dragPos = null` and reposition.

**Settings** — persisted in `chrome.storage.sync` as `{ enabled, settings: { fontSize, textColor, bgColor, showOriginal, targetLang, sourceLang } }`. Content scripts listen via `chrome.storage.onChanged` for live updates without page reload.

**SPA navigation** — a `setInterval` watches `location.href`; on change it destroys the overlay, stops watchers, and calls `waitForPlayer()` again after 1.5 s.

**Hiding original captions** — done via an injected `<style>` tag using `visibility: hidden` (not `display: none`) — the polling code still reads `.textContent` off the (hidden) original caption element, and some platforms stop updating cue text if the container is fully removed from layout.

## Adding a New Site

1. Identify the subtitle DOM element (right-click subtitle text → Inspect).
2. Check if the player is in a **cross-origin iframe** (`document.querySelectorAll('iframe').forEach(f => console.log(f.src))`). If yes, add `"all_frames": true` and add the iframe domain to both `matches` and `host_permissions` (see `gamedev.js` / `iframe.mediadelivery.net` for the working example).
3. Copy `gamedev.js` or `domestika.js` as a starting template (rename cache id, overlay id, wait-for-player selector, caption selector).
4. Add entries in `manifest.json` under `content_scripts` and `host_permissions`.
5. Remove + Load unpacked the extension.

## Subtitle Collector (Udemy only)

`content.js` maintains a `subtitleLog` array. The popup sends `startCollect` / `stopCollect` / `getLog` / `clearLog` messages; the `chrome.runtime.onMessage` handler responds with `{ ok: true }` or `{ log, count, collecting }` and must `return true` to keep the async message channel open. Collected lines can be saved as a UTF-8 BOM `.txt` file via `chrome.downloads`. This feature doesn't exist in `gamedev.js`/`domestika.js` yet — copy the block verbatim if porting it.

## Known Platform Specifics

- **gamedev.tv**: video player is inside a **cross-origin iframe** from `iframe.mediadelivery.net` (BunnyCDN Stream). The `all_frames: true` flag is required. The iframe URL pattern is `https://iframe.mediadelivery.net/embed/{libraryId}/{videoId}`.
- **Domestika**: Video.js player is directly on the page (no iframe). Multiple `.vjs-text-track-cue` elements may exist simultaneously (multiple videos per page); the poll takes the first non-empty one and uses `.closest('.video-js')` for overlay positioning.
- **Udemy**: original captions are hidden via an injected `<style>` tag (`visibility: hidden`) rather than `display: none` so the DOM text remains readable by the polling code. Udemy has migrated the caption DOM to CSS-module class names (e.g. `captions-display-module--captions-cue-text--XXXXX`), but still keeps `data-purpose="captions-cue-text"` on the cue element — match on that attribute, not on class name, since the hashed class suffix changes.
