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

function findVideoRef() {
  return (
    document.querySelector('[data-purpose="media-player-container"]') ||
    document.querySelector(VIDEO_CONTAINER_SELECTOR) ||
    document.querySelector('video')
  );
}

const cache = new Map();
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
  if (msg.type === 'whisperStart') {
    startWhisperMode(msg.serverUrl || 'http://localhost:5000').then(sendResponse);
  }
  if (msg.type === 'whisperStop') {
    stopWhisperMode();
    sendResponse({ ok: true });
  }
  if (msg.type === 'whisperStatus') {
    sendResponse({ active: whisperActive });
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

function showTranslation(thai, original) {
  if (!overlay) return;
  overlay.querySelector('.th-line').textContent = thai;
  overlay.querySelector('.orig-line').textContent = original;
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
  const sl = settings.sourceLang || 'auto';
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

// ─── SPA navigation ───────────────────────────────────────────────────────────

let lastHref = location.href;
setInterval(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    currentText = '';
    destroyOverlay();
    stopObserver();
    stopWhisperMode();
    if (isEnabled) setTimeout(waitForPlayer, 1500);
  }
}, 1000);

// ─── Whisper Mode ─────────────────────────────────────────────────────────────

let whisperActive = false;
let whisperRecorder = null;
let whisperServerUrl = 'http://localhost:5000';

async function startWhisperMode(serverUrl) {
  // Ping server first — fast fail with clear error
  try {
    const probe = await fetch(serverUrl + '/health', {
      signal: AbortSignal.timeout(3000),
    });
    if (!probe.ok) throw new Error('server returned ' + probe.status);
  } catch (e) {
    return { ok: false, error: 'Server ไม่ตอบ — รัน start_server.bat ก่อน' };
  }

  const video = document.querySelector('video');
  if (!video) return { ok: false, error: 'ไม่พบ video บนหน้านี้' };

  stopWhisperMode();
  if (!overlay) createOverlay();

  whisperServerUrl = serverUrl;

  try {
    attachWhisperRecorder(video);
    whisperActive = true;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function attachWhisperRecorder(video) {
  const stream = video.captureStream();
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) throw new Error('ไม่พบ audio track (DRM?)');

  const audioStream = new MediaStream(audioTracks);
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus' : 'audio/webm';

  whisperRecorder = new MediaRecorder(audioStream, { mimeType });

  whisperRecorder.ondataavailable = async (e) => {
    if (e.data.size < 500) return;
    try {
      const formData = new FormData();
      formData.append('audio', e.data, 'chunk.webm');
      const res = await fetch(whisperServerUrl + '/transcribe', { method: 'POST', body: formData });
      if (!res.ok) return;
      const { text } = await res.json();
      if (!text || text.trim().length < 2) return;
      const trimmed = text.trim();
      const translated = await googleTranslate(trimmed, settings.targetLang);
      if (translated) showTranslation(translated, settings.showOriginal ? trimmed : '');
    } catch (err) {
      console.warn('[RIP Whisper]', err.message);
    }
  };

  // Auto-restart if the recorder stops unexpectedly
  whisperRecorder.onstop = () => {
    if (!whisperActive) return;
    const v = document.querySelector('video');
    if (v) setTimeout(() => attachWhisperRecorder(v), 300);
  };

  whisperRecorder.onerror = (e) => {
    console.warn('[RIP Whisper] recorder error:', e.error?.message);
  };

  whisperRecorder.start(4000); // 4-second chunks
}

function stopWhisperMode() {
  whisperActive = false;
  if (whisperRecorder) {
    try { whisperRecorder.stop(); } catch (_) {}
    whisperRecorder = null;
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

setTimeout(waitForPlayer, 1500);
