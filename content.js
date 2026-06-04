// Udemy Thai Subtitle Translator
// Confirmed selectors (from live DOM inspection):
//   [data-purpose="captions-cue-text"]  — subtitle text element
//   [class*="captions-container"]       — Udemy's caption display (we hide this)
//   [class*="video-container"]          — video wrapper for overlay positioning

const CAPTION_SELECTOR = '[data-purpose="captions-cue-text"]';
const CAPTION_CONTAINER_SELECTOR = '[class*="captions-container"]';
const VIDEO_CONTAINER_SELECTOR = '[class*="video-container"]';

const cache = new Map();
let overlay = null;
let isEnabled = true;
let observer = null;
let pollInterval = null;
let currentText = '';
let translateTimeout = null;
// Custom drag position (null = use auto-position from video container)
let dragPos = null;
let settings = {
  fontSize: 22,
  textColor: '#ffffff',
  bgColor: 'rgba(0,0,0,0.78)',
  showOriginal: false,
  targetLang: 'th',
};

// ─── Load Noto Sans Thai from Google Fonts into the page ─────────────────────
// Content scripts cannot use @font-face directly, so we inject a <link> tag.
// Noto Sans Thai covers Thai + Latin perfectly and is not pre-installed on Windows.
(function injectFont() {
  const id = 'udemy-thai-gfont';
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;600&display=swap';
  document.head.appendChild(link);
})();

// ─── Init ─────────────────────────────────────────────────────────────────────

chrome.storage.sync.get(['enabled', 'settings'], (result) => {
  if (result.enabled !== undefined) isEnabled = result.enabled;
  if (result.settings) settings = { ...settings, ...result.settings };
  waitForPlayer();
});

// ─── Real-time subtitle log (collected as you watch) ─────────────────────────
const subtitleLog = [];
let lastLogged    = '';
let isCollecting  = false; // user must press Start to begin collecting

// Handle popup requests
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'getLog') {
    sendResponse({ log: subtitleLog, count: subtitleLog.length, collecting: isCollecting });
  }
  if (msg.type === 'startCollect') {
    subtitleLog.length = 0;
    lastLogged = '';
    isCollecting = true;
    sendResponse({ ok: true });
  }
  if (msg.type === 'stopCollect') {
    isCollecting = false;
    sendResponse({ ok: true });
  }
  if (msg.type === 'clearLog') {
    subtitleLog.length = 0;
    lastLogged = '';
    sendResponse({ ok: true });
  }
  return true;
});

// Listen for storage changes — reliable regardless of message-passing state
chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled) {
    isEnabled = changes.enabled.newValue;
    if (isEnabled) {
      waitForPlayer();
      hideUdemyCaptions(true);
    } else {
      destroyOverlay();
      stopObserver();
      hideUdemyCaptions(false);
    }
  }
  if (changes.settings) {
    const prev = settings.targetLang;
    settings = { ...settings, ...changes.settings.newValue };
    applyStyles();
    // Language changed → clear cache + force re-translate current subtitle
    if (prev !== settings.targetLang) {
      cache.clear();
      currentText = '';
    }
  }
});

function waitForPlayer() {
  let attempts = 0;
  const check = setInterval(() => {
    attempts++;
    if (document.querySelector(VIDEO_CONTAINER_SELECTOR)) {
      clearInterval(check);
      init();
    }
    if (attempts > 40) clearInterval(check);
  }, 500);
}

function init() {
  if (!isEnabled) return;
  hideUdemyCaptions(true);
  createOverlay();
  startObserver();
  startPoll();
}

// ─── Hide Udemy's original caption display ────────────────────────────────────
// We use visibility:hidden (not display:none) so the DOM element stays readable.
// A <style> tag is injected so it persists across React re-renders.

let captionHideStyle = null;

function hideUdemyCaptions(hide) {
  if (hide) {
    if (!captionHideStyle) {
      captionHideStyle = document.createElement('style');
      captionHideStyle.id = 'udemy-thai-hide-captions';
      // Hide the visual container but keep the text node in the DOM
      captionHideStyle.textContent = `
        [class*="captions-container"] { visibility: hidden !important; }
      `;
      document.head.appendChild(captionHideStyle);
    }
  } else {
    captionHideStyle?.remove();
    captionHideStyle = null;
  }
}

// ─── Overlay ──────────────────────────────────────────────────────────────────

function createOverlay() {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.id = 'udemy-thai-overlay';

  const thaiLine = document.createElement('div');
  thaiLine.className = 'th-line';

  const origLine = document.createElement('div');
  origLine.className = 'orig-line';

  overlay.appendChild(thaiLine);
  overlay.appendChild(origLine);

  // Attach to video container so it works in fullscreen too
  attachOverlay();
  applyStyles();
  positionOverlay();

  // Drag from the overlay itself (no handle)
  makeDraggable(overlay);

  window.addEventListener('resize', () => { dragPos = null; positionOverlay(); });

  // Move overlay when entering/exiting fullscreen
  document.addEventListener('fullscreenchange', onFullscreenChange);
}

function makeDraggable(el) {
  let startX, startY, startCX, startCY; // track CENTER, not left/top

  el.addEventListener('mousedown', onDown);
  el.addEventListener('touchstart', onDown, { passive: false });

  function onDown(e) {
    e.preventDefault();
    const pt = e.touches ? e.touches[0] : e;
    startX = pt.clientX;
    startY = pt.clientY;
    // Record center of overlay at drag start
    const rect = el.getBoundingClientRect();
    startCX = rect.left + rect.width  / 2;
    startCY = rect.top  + rect.height / 2;

    el.style.cursor = 'grabbing';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend',  onUp);
  }

  function onMove(e) {
    e.preventDefault();
    const pt = e.touches ? e.touches[0] : e;
    // New center = start center + delta
    const cx = startCX + (pt.clientX - startX);
    const cy = startCY + (pt.clientY - startY);
    // Clamp center so overlay stays fully on screen
    const hw = el.offsetWidth  / 2;
    const hh = el.offsetHeight / 2;
    const clampedCX = Math.max(hw, Math.min(window.innerWidth  - hw, cx));
    const clampedCY = Math.max(hh, Math.min(window.innerHeight - hh, cy));

    // Position by center using transform
    el.style.left      = clampedCX + 'px';
    el.style.top       = clampedCY + 'px';
    el.style.transform = 'translate(-50%, -50%)';
    el.style.bottom    = 'auto';
    el.style.right     = 'auto';

    // Save center as ratio so resize keeps proportional position
    dragPos = { rx: clampedCX / window.innerWidth, ry: clampedCY / window.innerHeight };
  }

  function onUp() {
    el.style.cursor = 'grab';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend',  onUp);
  }

  // Double-click → reset to default position
  el.addEventListener('dblclick', () => {
    dragPos = null;
    positionOverlay();
  });
}

function attachOverlay() {
  if (!overlay) return;
  const fsEl = document.fullscreenElement;
  if (fsEl) {
    // In fullscreen: append inside the fullscreen element
    fsEl.appendChild(overlay);
  } else {
    // Normal: append to body
    document.body.appendChild(overlay);
  }
}

function onFullscreenChange() {
  if (!overlay) return;
  dragPos = null;
  attachOverlay();
  setTimeout(positionOverlay, 100);
}

function destroyOverlay() {
  if (overlay) { overlay.remove(); overlay = null; }
  window.removeEventListener('resize', positionOverlay);
  document.removeEventListener('fullscreenchange', onFullscreenChange);
}

function applyStyles() {
  if (!overlay) return;

  Object.assign(overlay.style, {
    position: 'fixed',
    zIndex: '2147483647',
    pointerEvents: 'auto',
    textAlign: 'center',
    padding: '8px 16px',
    maxWidth: '84vw',
    borderRadius: '6px',
    background: settings.bgColor,
    transition: 'opacity 0.15s ease',
    opacity: '0',
    lineHeight: '1',
    cursor: 'grab',
    userSelect: 'none',
  });

  Object.assign(overlay.querySelector('.th-line').style, {
    fontFamily: "'Noto Sans Thai','Noto Sans',Arial,sans-serif",
    fontSize: settings.fontSize + 'px',
    color: settings.textColor,
    lineHeight: '1.6',
    textShadow: '0 1px 4px rgba(0,0,0,0.9)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'keep-all',
  });

  Object.assign(overlay.querySelector('.orig-line').style, {
    fontFamily: "'Noto Sans',Arial,sans-serif",
    fontSize: Math.max(12, settings.fontSize - 6) + 'px',
    color: 'rgba(255,255,255,0.55)',
    marginTop: '3px',
    display: settings.showOriginal ? 'block' : 'none',
  });
}

function positionOverlay() {
  if (!overlay) return;

  // User dragged — restore center from ratio so resize keeps proportional position
  if (dragPos) {
    const cx = dragPos.rx * window.innerWidth;
    const cy = dragPos.ry * window.innerHeight;
    Object.assign(overlay.style, {
      left:      cx + 'px',
      top:       cy + 'px',
      transform: 'translate(-50%, -50%)',
      bottom:    'auto',
      right:     'auto',
    });
    return;
  }

  const fsEl = document.fullscreenElement;
  const ref = fsEl || document;
  const vc = ref.querySelector
    ? ref.querySelector(VIDEO_CONTAINER_SELECTOR)
    : document.querySelector(VIDEO_CONTAINER_SELECTOR);

  if (vc) {
    const r = vc.getBoundingClientRect();
    const bottomGap = window.innerHeight - r.bottom + 52;
    Object.assign(overlay.style, {
      bottom:    bottomGap + 'px',
      left:      r.left + r.width / 2 + 'px',
      transform: 'translateX(-50%)',
      top:       'auto',
    });
  } else {
    Object.assign(overlay.style, {
      bottom:    '90px',
      left:      '50%',
      transform: 'translateX(-50%)',
      top:       'auto',
    });
  }
}

function showTranslation(thai, original) {
  if (!overlay) return;
  overlay.querySelector('.th-line').textContent = thai;
  overlay.querySelector('.orig-line').textContent = original;
  overlay.style.opacity = '1';
  positionOverlay();
  // Collect only when user pressed Start
  if (isCollecting && thai && thai !== lastLogged) {
    subtitleLog.push(thai);
    lastLogged = thai;
  }
}

function hideTranslation() {
  if (!overlay) return;
  overlay.style.opacity = '0';
  setTimeout(() => {
    if (!overlay) return;
    overlay.querySelector('.th-line').textContent = '';
    overlay.querySelector('.orig-line').textContent = '';
  }, 160);
}

// ─── Observer + Poll ──────────────────────────────────────────────────────────

function startObserver() {
  if (observer) observer.disconnect();
  observer = new MutationObserver(checkCaptionText);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

function stopObserver() {
  observer?.disconnect(); observer = null;
  clearInterval(pollInterval); pollInterval = null;
}

function startPoll() {
  clearInterval(pollInterval);
  pollInterval = setInterval(checkCaptionText, 200);
}

function checkCaptionText() {
  if (!isEnabled) return;
  const el = document.querySelector(CAPTION_SELECTOR);
  const text = el ? el.textContent.trim() : '';
  if (text === currentText) return;
  currentText = text;
  if (text && text.length > 1) {
    scheduleTranslation(text);
  } else {
    hideTranslation();
  }
}

// ─── Translation ──────────────────────────────────────────────────────────────

function scheduleTranslation(text) {
  clearTimeout(translateTimeout);
  translateTimeout = setTimeout(() => translateText(text), 80);
}

async function translateText(text) {
  if (!text || text.length < 2) return;

  if (settings.targetLang === 'th' && /[฀-๿]/.test(text)) {
    showTranslation(text, '');
    return;
  }

  // Cache key includes target language so switching language re-translates correctly
  const key = `${settings.targetLang}|${text.trim()}`;
  if (cache.has(key)) {
    if (currentText === text) showTranslation(cache.get(key), settings.showOriginal ? text : '');
    return;
  }

  try {
    const translated = await googleTranslate(text, settings.targetLang);
    if (!translated) return;
    if (cache.size >= 600) cache.delete(cache.keys().next().value);
    cache.set(key, translated);
    if (currentText === text) showTranslation(translated, settings.showOriginal ? text : '');
  } catch (e) {
    console.warn('[UdemyThai]', e.message);
  }
}

async function googleTranslate(text, tl) {
  const url =
    'https://translate.googleapis.com/translate_a/single' +
    '?client=gtx&sl=auto&tl=' + encodeURIComponent(tl) +
    '&dt=t&q=' + encodeURIComponent(text);
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (Array.isArray(data) && Array.isArray(data[0])) {
    return data[0].filter(i => i && i[0]).map(i => i[0]).join('');
  }
  return null;
}

// ─── SPA navigation (Udemy changes lecture without full page reload) ───────────

let lastHref = location.href;
setInterval(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    currentText = '';
    destroyOverlay();
    stopObserver();
    if (isEnabled) setTimeout(waitForPlayer, 1500);
  }
}, 1000);

// ─── Bootstrap ────────────────────────────────────────────────────────────────

setTimeout(waitForPlayer, 1500);
