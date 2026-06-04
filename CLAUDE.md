# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**RIP Translator** — a Chrome Extension (Manifest V3) that auto-translates subtitles on online course platforms in real-time, overlaying the translation directly on the video. No build step; pure vanilla JS.

## Installing / Reloading

```
chrome://extensions → Enable Developer mode → Load unpacked → select this folder
```

After editing any file, click the **reload** icon on the extension card. After adding **new files**, you must **Remove** and **Load unpacked** again — Chrome won't pick up new files on a simple reload.

After reloading the extension, **close and reopen** any affected tabs (tab refresh alone won't inject the new content script).

## Architecture

Each supported platform has its own isolated content script. They share no code.

| Script | Platform | Player | Subtitle selector |
|---|---|---|---|
| `content.js` | Udemy (`www.udemy.com`) | Custom | `[data-purpose="captions-cue-text"]` |
| `gamedev.js` | gamedev.tv + `iframe.mediadelivery.net` | Plyr (in cross-origin BunnyCDN iframe) | `.plyr__caption` |
| `domestika.js` | Domestika (`www.domestika.org`) | Video.js | `.vjs-text-track-cue` |

`popup.html` / `popup.js` — settings UI (font size, text color, bg opacity, target language, subtitle collector). Communicates with the active tab's content script via `chrome.tabs.sendMessage`.

## Key Patterns (shared across all content scripts)

**Subtitle detection** — `setInterval` poll every 200ms reading the player's caption DOM element. `content.js` also adds a `MutationObserver` as a secondary trigger.

**Translation** — Google Translate unofficial API (`translate.googleapis.com/translate_a/single`). Results are cached in a `Map` (key = `"lang|text"`). Cache is capped at 400–600 entries (LRU eviction via `cache.keys().next()`).

**Overlay** — a `position: fixed; z-index: 2147483647` div appended to `document.body` (or to `document.fullscreenElement` when in fullscreen). Draggable by mouse/touch; position stored as viewport ratios `{ rx, ry }` so it survives resize. Double-click resets to auto-position. Resize and fullscreenchange events always reset `dragPos = null` and reposition.

**Settings** — persisted in `chrome.storage.sync` as `{ enabled, settings }`. Content scripts listen via `chrome.storage.onChanged` for live updates without page reload.

**SPA navigation** — a `setInterval` watches `location.href`; on change it destroys the overlay, stops watchers, and calls `waitForPlayer()` again after 1.5 s.

## Adding a New Site

1. Identify the subtitle DOM element (right-click subtitle text → Inspect).
2. Check if the player is in a **cross-origin iframe** (`document.querySelectorAll('iframe').forEach(f => console.log(f.src))`). If yes, add `"all_frames": true` and add the iframe domain to both `matches` and `host_permissions`.
3. Create a new `<site>.js` modelled on `gamedev.js` or `domestika.js`.
4. Add entries in `manifest.json` under `content_scripts` and `host_permissions`.
5. Remove + Load unpacked the extension.

## Subtitle Collector (Udemy only)

`content.js` maintains a `subtitleLog` array. The popup sends `startCollect` / `stopCollect` / `getLog` / `clearLog` messages. Collected lines can be saved as a UTF-8 BOM `.txt` file via `chrome.downloads`.

## Known Platform Specifics

- **gamedev.tv**: video player is inside a **cross-origin iframe** from `iframe.mediadelivery.net` (BunnyCDN Stream). The `all_frames: true` flag is required. The iframe URL pattern is `https://iframe.mediadelivery.net/embed/{libraryId}/{videoId}`.
- **Domestika**: Video.js player is directly on the page (no iframe). Multiple `.vjs-text-track-cue` elements may exist simultaneously (multiple videos per page); the poll takes the first non-empty one and uses `.closest('.video-js')` for overlay positioning.
- **Udemy**: original captions are hidden via an injected `<style>` tag (`visibility: hidden`) rather than `display: none` so the DOM text remains readable by the polling code.
