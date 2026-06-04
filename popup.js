const $ = id => document.getElementById(id);

const defaults = {
  fontSize: 22,
  textColor: '#ffffff',
  bgColor: 'rgba(0,0,0,0.78)',
  bgOpacity: 78,
  showOriginal: false,
  targetLang: 'th',
};

function updateBgPreview(opacity) {
  const el = $('bgPreview');
  if (el) el.style.background = `linear-gradient(to right, transparent, rgba(0,0,0,${opacity / 100}))`;
}

function updateStatus(enabled) {
  const dot = $('dot');
  const label = $('statusLabel');
  dot.className = 'dot ' + (enabled ? 'on' : 'off');
  label.textContent = enabled ? 'Active' : 'Disabled';
}

// Load saved state
chrome.storage.sync.get(['enabled', 'settings'], result => {
  const enabled = result.enabled !== false;
  const s = { ...defaults, ...(result.settings || {}) };

  $('enabled').checked = enabled;
  $('showOriginal').checked = s.showOriginal;
  $('fontSize').value = s.fontSize;
  $('fontSizeVal').textContent = s.fontSize + 'px';
  $('textColor').value = s.textColor;
  $('bgOpacity').value = s.bgOpacity ?? 78;
  $('bgOpacityVal').textContent = (s.bgOpacity ?? 78) + '%';
  $('targetLang').value = s.targetLang;

  updateBgPreview(s.bgOpacity ?? 78);
  updateStatus(enabled);
});

function getSettings() {
  const opacity = parseInt($('bgOpacity').value) / 100;
  return {
    fontSize: parseInt($('fontSize').value),
    textColor: $('textColor').value,
    bgColor: `rgba(0,0,0,${opacity.toFixed(2)})`,
    bgOpacity: parseInt($('bgOpacity').value),
    showOriginal: $('showOriginal').checked,
    targetLang: $('targetLang').value,
  };
}

function sendToTab(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, msg).catch(() => {});
  });
}

function saveAndSend() {
  const settings = getSettings();
  chrome.storage.sync.set({ settings });
  sendToTab({ type: 'settings', settings });
}

$('enabled').addEventListener('change', e => {
  const enabled = e.target.checked;
  chrome.storage.sync.set({ enabled });
  sendToTab({ type: 'toggle', enabled });
  updateStatus(enabled);
});

$('showOriginal').addEventListener('change', saveAndSend);
$('fontSize').addEventListener('input', e => { $('fontSizeVal').textContent = e.target.value + 'px'; saveAndSend(); });
$('bgOpacity').addEventListener('input', e => { $('bgOpacityVal').textContent = e.target.value + '%'; updateBgPreview(parseInt(e.target.value)); saveAndSend(); });
$('textColor').addEventListener('input', saveAndSend);
$('targetLang').addEventListener('change', saveAndSend);

// ── Collect subtitles ─────────────────────────────────────────────────────────

function getActiveTab(cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs[0]) cb(tabs[0]);
  });
}

let collecting = false;

function setCollectUI(isRec, count) {
  const btn    = $('collectBtn');
  const status = $('collectStatus');
  const lc     = $('lineCount');

  if (isRec) {
    btn.textContent = '⏹ Stop';
    btn.className   = 'btn btn-collect recording';
    status.className = 'status-rec';
    status.textContent = '● Recording';
  } else {
    btn.textContent = '▶ Start';
    btn.className   = 'btn btn-collect';
    status.className = 'status-idle';
    status.textContent = '● Idle';
  }

  lc.textContent        = (count || 0) + ' lines';
  $('saveBtn').disabled  = !count;
  $('clearBtn').disabled = !count;
}

// Poll count every second
function refreshCount() {
  getActiveTab(tab => {
    chrome.tabs.sendMessage(tab.id, { type: 'getLog' }, res => {
      if (chrome.runtime.lastError || !res) return;
      collecting = res.collecting;
      setCollectUI(collecting, res.count);
    });
  });
}
refreshCount();
setInterval(refreshCount, 1000);

// Start / Stop toggle
$('collectBtn').addEventListener('click', () => {
  getActiveTab(tab => {
    const type = collecting ? 'stopCollect' : 'startCollect';
    chrome.tabs.sendMessage(tab.id, { type }, res => {
      if (chrome.runtime.lastError || !res) return;
      collecting = !collecting;
      setCollectUI(collecting, 0);
    });
  });
});

// Save .txt
$('saveBtn').addEventListener('click', () => {
  getActiveTab(tab => {
    chrome.tabs.sendMessage(tab.id, { type: 'getLog' }, res => {
      if (chrome.runtime.lastError || !res || !res.log.length) return;
      const content = res.log.join('\n');
      const blob    = new Blob(['﻿' + content], { type: 'text/plain;charset=utf-8' });
      const url     = URL.createObjectURL(blob);
      const now     = new Date();
      const stamp   = now.getFullYear() +
                      String(now.getMonth()+1).padStart(2,'0') +
                      String(now.getDate()).padStart(2,'0') + '_' +
                      String(now.getHours()).padStart(2,'0') +
                      String(now.getMinutes()).padStart(2,'0');
      chrome.downloads.download({ url, filename: `subtitles_${stamp}.txt`, saveAs: false });
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    });
  });
});

// Clear
$('clearBtn').addEventListener('click', () => {
  getActiveTab(tab => {
    chrome.tabs.sendMessage(tab.id, { type: 'clearLog' }, () => {
      if (chrome.runtime.lastError) return;
      setCollectUI(collecting, 0);
    });
  });
});
