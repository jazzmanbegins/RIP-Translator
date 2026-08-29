// RIP Translator — domestika.org (Video.js player)
// Subtitle element: .vjs-text-track-cue  inside  .vjs-text-track-display


// Subtitle wraps onto at most this many lines; long text shrinks to fit
const MAX_LINES = 2;
const LINE_HEIGHT = 1.6;
const MAX_OVERLAY_WIDTH = '70vw';

const cache = new Map();
// Once Google Translate fails, skip retrying it until this timestamp (avoids
// hammering a blocked/unreachable endpoint on every single caption line).
let googleDownUntil = 0;
const GOOGLE_RETRY_COOLDOWN = 5 * 60 * 1000;
let overlay       = null;
let currentText   = '';
let dragPos       = null;
let resizeHandler = null;
let pollInterval  = null;
let translateTimeout = null;
let isEnabled     = true;
const subtitleLog = [];
let lastLogged    = '';
let isCollecting  = false;
let settings = {
  fontSize: 22,
  textColor: '#ffffff',
  bgColor: 'rgba(0,0,0,0.78)',
  showOriginal: false,
  targetLang: 'th',
  sourceLang: 'auto',
};

// ─── Font ─────────────────────────────────────────────────────────────────────
(function injectFont() {
  if (document.getElementById('rip-dom-gfont')) return;
  const link = document.createElement('link');
  link.id   = 'rip-dom-gfont';
  link.rel  = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;600&display=swap';
  document.head.appendChild(link);
})();

// ─── Storage ──────────────────────────────────────────────────────────────────
chrome.storage.sync.get(['enabled', 'settings'], (r) => {
  if (r.enabled !== undefined) isEnabled = r.enabled;
  if (r.settings) settings = { ...settings, ...r.settings };
  waitForPlayer();
});

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

chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled) {
    isEnabled = changes.enabled.newValue;
    if (!isEnabled) { hideOverlay(); clearInterval(pollInterval); }
    else startPoll();
  }
  if (changes.settings) {
    settings = { ...settings, ...changes.settings.newValue };
    applyStyles();
  }
});

// ─── Wait for Video.js player ─────────────────────────────────────────────────
function waitForPlayer() {
  let attempts = 0;

  const check = setInterval(() => {
    attempts++;
    if (document.querySelector('.vjs-text-track-display')) {
      clearInterval(check);

      init();
    }
    if (attempts > 60) {
      clearInterval(check);

    }
  }, 500);
}

function init() {
  if (!isEnabled) return;
  hideVjsCaptions();
  createOverlay();
  startPoll();
}

// ─── Hide original Video.js captions ──────────────────────────────────────────
function hideVjsCaptions() {
  if (document.getElementById('rip-vjs-hide')) return;
  const s = document.createElement('style');
  s.id = 'rip-vjs-hide';
  // Hide caption display but keep it in DOM so we can still read text
  s.textContent = '.vjs-text-track-display { visibility: hidden !important; }';
  document.head.appendChild(s);
}

// ─── Poll for active caption cue ─────────────────────────────────────────────
// Multiple videos may exist on page — scan all, use first with active text
function getActiveCueText() {
  const cues = document.querySelectorAll('.vjs-text-track-cue');
  for (const cue of cues) {
    const text = cue.textContent.trim();
    if (text) return { text, cue };
  }
  return { text: '', cue: null };
}

function startPoll() {
  clearInterval(pollInterval);
  pollInterval = setInterval(() => {
    if (!isEnabled) return;
    const { text, cue } = getActiveCueText();
    if (text === currentText) return;
    currentText = text;
    if (text.length > 1) {
      scheduleTranslation(text, cue);
    } else {
      hideOverlay();
    }
  }, 200);
}

// ─── Overlay ──────────────────────────────────────────────────────────────────
function createOverlay() {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.id = 'rip-domestika-overlay';
  overlay.innerHTML = '<div class="th-line"></div><div class="orig-line"></div>';
  document.body.appendChild(overlay);
  applyStyles();
  positionOverlay();
  makeDraggable(overlay);
  resizeHandler = () => { dragPos = null; positionOverlay(); };
  window.addEventListener('resize', resizeHandler);
  document.addEventListener('fullscreenchange', () => {
    dragPos = null;
    const fsEl = document.fullscreenElement;
    if (fsEl) fsEl.appendChild(overlay);
    else document.body.appendChild(overlay);
    setTimeout(positionOverlay, 100);
  });
}

function applyStyles() {
  if (!overlay) return;
  Object.assign(overlay.style, {
    position:  'fixed',
    zIndex:    '2147483647',
    textAlign: 'center',
    padding:   '8px 16px',
    maxWidth:  MAX_OVERLAY_WIDTH,
    borderRadius: '6px',
    background: settings.bgColor,
    opacity:   '0',
    transition: 'opacity 0.15s ease',
    cursor:    'grab',
    userSelect: 'none',
    pointerEvents: 'auto',
  });
  Object.assign(overlay.querySelector('.th-line').style, {
    fontFamily: "'Noto Sans Thai','Noto Sans',Arial,sans-serif",
    fontSize:   settings.fontSize + 'px',
    color:      settings.textColor,
    lineHeight: String(LINE_HEIGHT),
    textShadow: '0 1px 4px rgba(0,0,0,0.9)',
    whiteSpace: 'normal',
    overflowWrap: 'break-word',
    textWrap:   'balance',
    width:      'auto',   // fitToMaxLines() narrows this to the text on every cue
    marginInline: 'auto',
  });
  Object.assign(overlay.querySelector('.orig-line').style, {
    fontFamily: "'Noto Sans',Arial,sans-serif",
    fontSize:   Math.max(12, settings.fontSize - 6) + 'px',
    color:      'rgba(255,255,255,0.55)',
    marginTop:  '3px',
    width:      'auto',
    marginInline: 'auto',
    display:    settings.showOriginal ? 'block' : 'none',
  });
}

// Position relative to the active video's container
function positionOverlay(activeCue) {
  if (!overlay) return;
  if (dragPos) {
    Object.assign(overlay.style, {
      left: (dragPos.rx * window.innerWidth) + 'px',
      top:  (dragPos.ry * window.innerHeight) + 'px',
      transform: 'translate(-50%,-50%)',
      bottom: 'auto', right: 'auto',
    });
    return;
  }
  // Find the active video container — walk up from cue element to .video-js
  const fsEl = document.fullscreenElement;
  const vc = activeCue?.closest('.video-js')
    || (fsEl || document).querySelector('.video-js')
    || document.querySelector('.video-js');

  if (vc) {
    const r = vc.getBoundingClientRect();
    Object.assign(overlay.style, {
      bottom: (window.innerHeight - r.bottom + 52) + 'px',
      left:   (r.left + r.width / 2) + 'px',
      transform: 'translateX(-50%)',
      top: 'auto',
    });
  } else {
    Object.assign(overlay.style, {
      bottom: '90px', left: '50%',
      transform: 'translateX(-50%)', top: 'auto',
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

function showOverlay(thai, orig, cue) {
  if (!overlay) return;
  const thLine = overlay.querySelector('.th-line');
  thLine.textContent = thai;
  fitToMaxLines(thLine);
  const origLine = overlay.querySelector('.orig-line');
  origLine.textContent = orig;
  if (settings.showOriginal) tightenWidth(origLine);
  overlay.style.opacity = '1';
  positionOverlay(cue);
  if (isCollecting && thai && thai !== lastLogged) {
    subtitleLog.push(thai);
    lastLogged = thai;
  }
}

function hideOverlay() {
  if (!overlay) return;
  overlay.style.opacity = '0';
  setTimeout(() => {
    if (!overlay) return;
    overlay.querySelector('.th-line').textContent  = '';
    overlay.querySelector('.orig-line').textContent = '';
  }, 160);
}

function makeDraggable(el) {
  let sx, sy, scx, scy;
  el.addEventListener('mousedown', down);
  el.addEventListener('touchstart', down, { passive: false });
  function down(e) {
    e.preventDefault();
    const p = e.touches ? e.touches[0] : e;
    sx = p.clientX; sy = p.clientY;
    const r = el.getBoundingClientRect();
    scx = r.left + r.width / 2; scy = r.top + r.height / 2;
    el.style.cursor = 'grabbing';
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', up);
  }
  function move(e) {
    e.preventDefault();
    const p = e.touches ? e.touches[0] : e;
    const cx = Math.max(el.offsetWidth/2,  Math.min(window.innerWidth  - el.offsetWidth/2,  scx + p.clientX - sx));
    const cy = Math.max(el.offsetHeight/2, Math.min(window.innerHeight - el.offsetHeight/2, scy + p.clientY - sy));
    el.style.left = cx + 'px'; el.style.top = cy + 'px';
    el.style.transform = 'translate(-50%,-50%)';
    el.style.bottom = 'auto'; el.style.right = 'auto';
    dragPos = { rx: cx / window.innerWidth, ry: cy / window.innerHeight };
  }
  function up() {
    el.style.cursor = 'grab';
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.removeEventListener('touchmove', move);
    document.removeEventListener('touchend', up);
  }
  el.addEventListener('dblclick', () => { dragPos = null; positionOverlay(); });
}

// ─── Translation ──────────────────────────────────────────────────────────────
function scheduleTranslation(text, cue) {
  clearTimeout(translateTimeout);
  translateTimeout = setTimeout(() => translateText(text, cue), 80);
}

async function translateText(text, cue) {
  if (!text || text.length < 2) return;
  const key = `${settings.sourceLang}|${settings.targetLang}|${text.trim()}`;
  if (cache.has(key)) {
    if (currentText === text) showOverlay(cache.get(key), settings.showOriginal ? text : '', cue);
    return;
  }
  const sl = settings.sourceLang || 'auto';
  const translated = await fetchTranslation(text, sl, settings.targetLang);
  if (translated) {
    if (cache.size >= 400) cache.delete(cache.keys().next().value);
    cache.set(key, translated);
    if (currentText === text) showOverlay(translated, settings.showOriginal ? text : '', cue);
  } else if (currentText === text) {
    // Both translation providers failed (e.g. blocked network) — show the original
    // text rather than leaving the overlay empty.
    showOverlay(text, '', cue);
  }
}

// Tries Google Translate first, then falls back to MyMemory if that's unreachable
// (e.g. translate.googleapis.com blocked by network/firewall/ISP). Once Google
// fails it's skipped for a cooldown period so a blocked endpoint doesn't get
// retried (and logged) on every single caption line.
async function fetchTranslation(text, sl, tl) {
  if (Date.now() >= googleDownUntil) {
    try {
      const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl='
        + encodeURIComponent(sl) + '&tl='
        + encodeURIComponent(tl) + '&dt=t&q=' + encodeURIComponent(text);
      const res  = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const translated = Array.isArray(data) && Array.isArray(data[0])
        ? data[0].filter(i => i?.[0]).map(i => i[0]).join('')
        : null;
      if (translated) return translated;
    } catch (e) {
      googleDownUntil = Date.now() + GOOGLE_RETRY_COOLDOWN;
      console.info('[RIP domestika] Google Translate unreachable, switching to fallback:', e.message);
    }
  }
  try {
    const pair = (sl === 'auto' ? 'en' : sl) + '|' + tl;
    const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text)
      + '&langpair=' + encodeURIComponent(pair);
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
  } catch (e) {
    console.info('[RIP domestika] Fallback translation also failed:', e.message);
    return null;
  }
}

// ─── SPA navigation ───────────────────────────────────────────────────────────
let lastHref = location.href;
setInterval(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    currentText = '';
    clearInterval(pollInterval);
    if (overlay) { overlay.remove(); overlay = null; }
    const hideStyle = document.getElementById('rip-vjs-hide');
    if (hideStyle) hideStyle.remove();
    if (isEnabled) setTimeout(waitForPlayer, 1500);
  }
}, 1000);

// ─── Bootstrap ────────────────────────────────────────────────────────────────
setTimeout(waitForPlayer, 1500);
