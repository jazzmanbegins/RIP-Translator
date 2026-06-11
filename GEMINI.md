# RIP Translator

RIP Translator is a Chrome Extension (Manifest V3) designed to provide real-time subtitle translation for online course platforms, specifically targeting Thai learners but supporting multiple languages. It extracts subtitles from the video player's DOM and overlays translations directly on the video.

## Project Overview

*   **Main Purpose:** Real-time subtitle translation for online courses.
*   **Technologies:** JavaScript (ES6+), HTML, CSS, Chrome Extension APIs (Manifest V3).
*   **Key Features:**
    *   **Real-time Translation:** Extracts subtitles from supported platforms and overlays translations.
    *   **Extensive Language Support:** Supports a wide range of target languages, including Thai, Indonesian, Chinese, Japanese, Korean, Hindi, Arabic, and many European and African languages.
    *   **Subtitle Collection:** Allows users to "record" subtitles during a session and export them as a `.txt` file for later review.
    *   **Customizable UI:** Users can adjust font size, text color, and background opacity via the extension popup.
*   **Architecture:**
    *   **Content Scripts:** Site-specific logic for detecting and overlaying subtitles (`content.js` for Udemy, `gamedev.js` for gamedev.tv, `domestika.js` for Domestika).
    *   **Popup UI:** `popup.html` and `popup.js` provide a settings interface for customizing the translation experience.
    *   **Storage:** Uses `chrome.storage.sync` to persist user settings and enabled status across sessions.
    *   **Styling:** `styles.css` handles the look and feel of the extension's UI components.

## Supported Platforms

*   **Udemy:** Subtitles are detected using `[data-purpose="captions-cue-text"]`.
*   **gamedev.tv:** Uses the Plyr player; subtitles are detected in `span.plyr__caption`.
*   **Domestika:** Uses the Video.js player; subtitles are detected in `.vjs-text-track-cue`.

## Building and Running

This project does not require a build step as it uses vanilla JavaScript and CSS.

### To Run Locally:
1.  Open Chrome/Edge and navigate to `chrome://extensions/`.
2.  Enable **Developer mode** (toggle in the top right).
3.  Click **Load unpacked** and select the root directory of this project.
4.  The "RIP Translator" extension should now be visible and active on supported sites.

## Development Conventions

*   **Vanilla JS:** Use modern vanilla JavaScript (ES6+) without external libraries where possible.
*   **Extension APIs:** Prefer `chrome.storage.sync` for settings and `chrome.runtime.onMessage` for communication between components.
*   **DOM Interaction:** Use `MutationObserver` or `setInterval` polling (as a fallback) to detect dynamic changes in video players for subtitle extraction.
*   **Localization:** The extension injects "Noto Sans Thai" for optimal Thai character rendering.
*   **Performance:** A caching mechanism (`const cache = new Map()`) is used in content scripts to avoid redundant translation requests.
