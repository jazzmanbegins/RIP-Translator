// Udemy Thai Subtitle Translator
// Confirmed selectors (from live DOM inspection):
//   [data-purpose="captions-cue-text"]  — subtitle text element
//   [class*="captions-container"]       — Udemy's caption display (we hide this)
//   [class*="video-container"]          — video wrapper for overlay positioning

// Learning player: [data-purpose="captions-cue-text"]
// Course preview (landing page): [class*="_cue-text_"]
const CAPTION_SELECTOR = '[data-purpose="captions-cue-text"], [class*="_cue-text_"]';
const CAPTION_CONTAINER_SELECTOR = '[class*="captions-container"], [class*="_caption-container_"]';
const VIDEO_CONTAINER_SELECTOR = '[class*="video-container"]';

// Subtitle wraps onto at most this many lines; long text shrinks to fit
const MAX_LINES = 2;
const LINE_HEIGHT = 1.6;
const MAX_OVERLAY_WIDTH = '70vw';

function findVideoRef() {
  return (
    document.querySelector('[data-purpose="media-player-container"]') ||
    document.querySelector(VIDEO_CONTAINER_SELECTOR) ||
    document.querySelector('video')
  );
}

const cache = new Map();
// Once Google Translate fails, skip retrying it until this timestamp (avoids
// hammering a blocked/unreachable endpoint on every single caption line).
let googleDownUntil = 0;
const GOOGLE_RETRY_COOLDOWN = 5 * 60 * 1000;
let overlay = null;
let isEnabled = true;
let observer = null;
let pollInterval = null;
let currentText = '';
let translateTimeout = null;
// Custom drag position stored as ratio (null = auto-position from video container)
let dragPos = null;
let resizeHandler = null;
let settings = {
  fontSize: 22,
  textColor: '#ffffff',
  bgColor: 'rgba(0,0,0,0.78)',
  showOriginal: false,
  targetLang: 'th',
  sourceLang: 'auto',
};

// ─── Load Noto Sans Thai from Google Fonts into the page ─────────────────────
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
let isCollecting  = false;

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

// Listen for storage changes
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
    const prevTl = settings.targetLang;
    const prevSl = settings.sourceLang;
    settings = { ...settings, ...changes.settings.newValue };
    applyStyles();
    if (prevTl !== settings.targetLang || prevSl !== settings.sourceLang) {
      cache.clear();
      currentText = '';
    }
  }
});

let preInitObserver = null;

function waitForPlayer() {
  // Fast path: player already in DOM
  if (findVideoRef()) { init(); return; }

  // Watch for dynamically loaded players (landing page modals, promo video)
  if (preInitObserver) preInitObserver.disconnect();
  preInitObserver = new MutationObserver(() => {
    if (overlay) { preInitObserver.disconnect(); return; }
    if (findVideoRef() || document.querySelector(CAPTION_SELECTOR)) {
      preInitObserver.disconnect();
      init();
    }
  });
  preInitObserver.observe(document.body, { childList: true, subtree: true });

  // Fallback poll (40 × 500 ms = 20 s)
  let attempts = 0;
  const check = setInterval(() => {
    attempts++;
    if (overlay || findVideoRef() || document.querySelector(CAPTION_SELECTOR)) {
      clearInterval(check);
      if (!overlay) init();
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
let captionHideStyle = null;

function hideUdemyCaptions(hide) {
  if (hide) {
    if (!captionHideStyle) {
      captionHideStyle = document.createElement('style');
      captionHideStyle.id = 'udemy-thai-hide-captions';
      captionHideStyle.textContent = `
        [class*="captions-container"],
        [class*="_caption-container_"] { visibility: hidden !important; }
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

  attachOverlay();
  applyStyles();
  positionOverlay();

  makeDraggable(overlay);

  resizeHandler = () => { dragPos = null; positionOverlay(); };
  window.addEventListener('resize', resizeHandler);
  document.addEventListener('fullscreenchange', onFullscreenChange);
}

function makeDraggable(el) {
  let startX, startY, startCX, startCY;

  el.addEventListener('mousedown', onDown);
  el.addEventListener('touchstart', onDown, { passive: false });

  function onDown(e) {
    e.preventDefault();
    const pt = e.touches ? e.touches[0] : e;
    startX = pt.clientX;
    startY = pt.clientY;
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
    const cx = startCX + (pt.clientX - startX);
    const cy = startCY + (pt.clientY - startY);
    const hw = el.offsetWidth  / 2;
    const hh = el.offsetHeight / 2;
    const clampedCX = Math.max(hw, Math.min(window.innerWidth  - hw, cx));
    const clampedCY = Math.max(hh, Math.min(window.innerHeight - hh, cy));

    el.style.left      = clampedCX + 'px';
    el.style.top       = clampedCY + 'px';
    el.style.transform = 'translate(-50%, -50%)';
    el.style.bottom    = 'auto';
    el.style.right     = 'auto';

    dragPos = { rx: clampedCX / window.innerWidth, ry: clampedCY / window.innerHeight };
  }

  function onUp() {
    el.style.cursor = 'grab';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend',  onUp);
  }

  el.addEventListener('dblclick', () => {
    dragPos = null;
    positionOverlay();
  });
}

function attachOverlay() {
  if (!overlay) return;
  const fsEl = document.fullscreenElement;
  if (fsEl) {
    fsEl.appendChild(overlay);
  } else {
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
  if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
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
    maxWidth: MAX_OVERLAY_WIDTH,
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
    lineHeight: String(LINE_HEIGHT),
    textShadow: '0 1px 4px rgba(0,0,0,0.9)',
    whiteSpace: 'normal',
    overflowWrap: 'break-word',
    textWrap: 'balance',
    width: 'auto',        // fitToMaxLines() narrows this to the text on every cue
    marginInline: 'auto',
  });

  Object.assign(overlay.querySelector('.orig-line').style, {
    fontFamily: "'Noto Sans',Arial,sans-serif",
    fontSize: Math.max(12, settings.fontSize - 6) + 'px',
    color: 'rgba(255,255,255,0.55)',
    marginTop: '3px',
    width: 'auto',
    marginInline: 'auto',
    display: settings.showOriginal ? 'block' : 'none',
  });
}

function positionOverlay() {
  if (!overlay) return;

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
  const vc = (ref.querySelector ? ref.querySelector(VIDEO_CONTAINER_SELECTOR) : null) ||
             findVideoRef();

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

// Count the rendered lines of a text element and measure its widest one
function measureLines(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const rows = new Map();
  for (const r of range.getClientRects()) {
    if (!r.width || !r.height) continue;
    const key = Math.round(r.top);
    const row = rows.get(key);
    if (row) {
      row.left  = Math.min(row.left, r.left);
      row.right = Math.max(row.right, r.right);
    } else {
      rows.set(key, { left: r.left, right: r.right });
    }
  }
  let widest = 0;
  for (const row of rows.values()) widest = Math.max(widest, row.right - row.left);
  return { lines: rows.size, widest };
}

// Shrink the font (down to 70% of the chosen size) until the text fits MAX_LINES,
// then tighten the box to the widest rendered line so no empty background is left
function fitToMaxLines(el) {
  el.style.width = 'auto';
  let size = settings.fontSize;
  const minSize = Math.max(12, Math.round(settings.fontSize * 0.7));
  el.style.fontSize = size + 'px';

  let m = measureLines(el);
  if (!m.lines) return;

  while (size > minSize && m.lines > MAX_LINES) {
    size -= 1;
    el.style.fontSize = size + 'px';
    m = measureLines(el);
  }

  tightenWidth(el);
}

// Pull the box in to the widest rendered line so the background hugs the text
function tightenWidth(el) {
  el.style.width = 'auto';
  const m = measureLines(el);
  if (!m.lines) return;
  el.style.width = Math.ceil(m.widest) + 1 + 'px';
  // A narrower box can re-wrap the text; fall back to auto width if it did
  if (measureLines(el).lines > m.lines) el.style.width = 'auto';
}

function showTranslation(thai, original) {
  if (!overlay) return;
  const thLine = overlay.querySelector('.th-line');
  thLine.textContent = thai;
  fitToMaxLines(thLine);
  const origLine = overlay.querySelector('.orig-line');
  origLine.textContent = original;
  if (settings.showOriginal) tightenWidth(origLine);
  overlay.style.opacity = '1';
  positionOverlay();
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
  preInitObserver?.disconnect(); preInitObserver = null;
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

  const key = `${settings.sourceLang}|${settings.targetLang}|${text.trim()}`;
  if (cache.has(key)) {
    if (currentText === text) showTranslation(cache.get(key), settings.showOriginal ? text : '');
    return;
  }

  const translated = await fetchTranslation(text, settings.sourceLang || 'auto', settings.targetLang);
  if (translated) {
    if (cache.size >= 600) cache.delete(cache.keys().next().value);
    cache.set(key, translated);
    if (currentText === text) showTranslation(translated, settings.showOriginal ? text : '');
  } else if (currentText === text) {
    // Both translation providers failed (e.g. blocked network) — show the original
    // text rather than leaving the overlay empty.
    showTranslation(text, '');
  }
}

// Tries Google Translate first, then falls back to MyMemory if that's unreachable
// (e.g. translate.googleapis.com blocked by network/firewall/ISP). Once Google
// fails it's skipped for a cooldown period so a blocked endpoint doesn't get
// retried (and logged) on every single caption line.
async function fetchTranslation(text, sl, tl) {
  if (Date.now() >= googleDownUntil) {
    try {
      const translated = await googleTranslate(text, sl, tl);
      if (translated) return translated;
    } catch (e) {
      googleDownUntil = Date.now() + GOOGLE_RETRY_COOLDOWN;
      console.info('[UdemyThai] Google Translate unreachable, switching to fallback:', e.message);
    }
  }
  try {
    return await myMemoryTranslate(text, sl, tl);
  } catch (e) {
    console.info('[UdemyThai] Fallback translation also failed:', e.message);
    return null;
  }
}

async function googleTranslate(text, sl, tl) {
  const url =
    'https://translate.googleapis.com/translate_a/single' +
    '?client=gtx&sl=' + encodeURIComponent(sl) + '&tl=' + encodeURIComponent(tl) +
    '&dt=t&q=' + encodeURIComponent(text);
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (Array.isArray(data) && Array.isArray(data[0])) {
    return data[0].filter(i => i && i[0]).map(i => i[0]).join('');
  }
  return null;
}

async function myMemoryTranslate(text, sl, tl) {
  const pair = (sl === 'auto' ? 'en' : sl) + '|' + tl;
  const url =
    'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) +
    '&langpair=' + encodeURIComponent(pair);
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const translated = data?.responseData?.translatedText;
  // MyMemory returns HTTP 200 even when rate-limited or out of quota, with an
  // English warning string in translatedText and the real error in responseStatus —
  // treat that as a failure instead of caching/showing the warning as a "translation".
  if (!translated || Number(data?.responseStatus) !== 200 || /MYMEMORY WARNING/i.test(translated)) {
    return null;
  }
  return translated;
}

// ─── SPA navigation ───────────────────────────────────────────────────────────

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
