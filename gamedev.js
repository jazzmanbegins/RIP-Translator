// RIP Translator — gamedev.tv (Plyr player)
// Subtitle element: span.plyr__caption inside div.plyr__captions


const cache = new Map();
let overlay      = null;
let currentText  = '';
let dragPos      = null;
let resizeHandler = null;
let pollInterval  = null;
let translateTimeout = null;
let isEnabled    = true;
let settings = {
  fontSize: 22,
  textColor: '#ffffff',
  bgColor: 'rgba(0,0,0,0.78)',
  showOriginal: false,
  targetLang: 'th',
};

// ─── Font ─────────────────────────────────────────────────────────────────────
(function injectFont() {
  if (document.getElementById('rip-gfont')) return;
  const link = document.createElement('link');
  link.id   = 'rip-gfont';
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

// ─── Wait for Plyr player ─────────────────────────────────────────────────────
function waitForPlayer() {
  let attempts = 0;

  const check = setInterval(() => {
    attempts++;
    if (document.querySelector('.plyr')) {
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
  hidePlyrCaptions();
  createOverlay();
  startPoll();
}

// ─── Hide original Plyr captions ──────────────────────────────────────────────
function hidePlyrCaptions() {
  if (document.getElementById('rip-plyr-hide')) return;
  const s = document.createElement('style');
  s.id = 'rip-plyr-hide';
  s.textContent = '.plyr__captions { visibility: hidden !important; }';
  document.head.appendChild(s);
}

// ─── Poll for caption text ────────────────────────────────────────────────────
function startPoll() {
  clearInterval(pollInterval);
  pollInterval = setInterval(() => {
    if (!isEnabled) return;
    const el   = document.querySelector('.plyr__caption');
    const text = el ? el.textContent.trim() : '';
    if (text === currentText) return;
    currentText = text;
    if (text.length > 1) scheduleTranslation(text);
    else hideOverlay();
  }, 200);
}

// ─── Overlay ──────────────────────────────────────────────────────────────────
function createOverlay() {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.id = 'rip-gamedev-overlay';
  overlay.innerHTML = '<div class="th-line"></div><div class="orig-line"></div>';
  document.body.appendChild(overlay);
  applyStyles();
  positionOverlay();
  makeDraggable(overlay);
  resizeHandler = () => { dragPos = null; positionOverlay(); };
  window.addEventListener('resize', resizeHandler);
  document.addEventListener('fullscreenchange', () => {
    dragPos = null;
    // Move overlay inside the fullscreen element so it stays visible
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
    maxWidth:  '84vw',
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
    lineHeight: '1.6',
    textShadow: '0 1px 4px rgba(0,0,0,0.9)',
    whiteSpace: 'pre-wrap',
    wordBreak:  'keep-all',
  });
  Object.assign(overlay.querySelector('.orig-line').style, {
    fontFamily: "'Noto Sans',Arial,sans-serif",
    fontSize:   Math.max(12, settings.fontSize - 6) + 'px',
    color:      'rgba(255,255,255,0.55)',
    marginTop:  '3px',
    display:    settings.showOriginal ? 'block' : 'none',
  });
}

function positionOverlay() {
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
  const fsEl = document.fullscreenElement;
  const vc = (fsEl || document).querySelector('.plyr') || document.querySelector('.plyr');
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

function showOverlay(thai, orig) {
  if (!overlay) return;
  overlay.querySelector('.th-line').textContent  = thai;
  overlay.querySelector('.orig-line').textContent = orig;
  overlay.style.opacity = '1';
  positionOverlay();
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
    scx = r.left + r.width / 2;
    scy = r.top  + r.height / 2;
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
function scheduleTranslation(text) {
  clearTimeout(translateTimeout);
  translateTimeout = setTimeout(() => translateText(text), 80);
}

async function translateText(text) {
  if (!text || text.length < 2) return;
  const key = `${settings.targetLang}|${text.trim()}`;
  if (cache.has(key)) {
    if (currentText === text) showOverlay(cache.get(key), settings.showOriginal ? text : '');
    return;
  }
  try {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='
      + encodeURIComponent(settings.targetLang) + '&dt=t&q=' + encodeURIComponent(text);
    const res  = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const translated = Array.isArray(data) && Array.isArray(data[0])
      ? data[0].filter(i => i?.[0]).map(i => i[0]).join('')
      : null;
    if (!translated) return;
    if (cache.size >= 400) cache.delete(cache.keys().next().value);
    cache.set(key, translated);
    if (currentText === text) showOverlay(translated, settings.showOriginal ? text : '');
  } catch (e) {
    console.warn('[RIP gamedev]', e.message);
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
    if (isEnabled) setTimeout(waitForPlayer, 1500);
  }
}, 1000);

// ─── Bootstrap ────────────────────────────────────────────────────────────────
setTimeout(waitForPlayer, 1500);
