const $ = id => document.getElementById(id);

const defaults = {
  fontSize: 22,
  textColor: '#ffffff',
  bgColor: 'rgba(0,0,0,0.78)',
  bgOpacity: 78,
  showOriginal: false,
  targetLang: 'th',
  sourceLang: 'auto',
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
  $('sourceLang').value = s.sourceLang || 'auto';

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
    sourceLang: $('sourceLang').value,
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
$('sourceLang').addEventListener('change', saveAndSend);

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

// ── Whisper Mode ──────────────────────────────────────────────────────────────

let whisperRunning = false;

function setWhisperUI(running, errorMsg) {
  const btn    = $('whisperBtn');
  const status = $('whisperStatus');
  if (running) {
    btn.textContent = '⏹ Stop';
    btn.className   = 'btn-whisper active';
    status.className = 'w-running';
    status.textContent = '● Running';
  } else {
    btn.textContent = '🎙 Start';
    btn.className   = 'btn-whisper';
    status.className = errorMsg ? 'w-error' : 'w-idle';
    status.textContent = errorMsg ? '✕ ' + errorMsg : '● Idle';
  }
}

// Load saved server URL
chrome.storage.local.get(['whisperUrl'], result => {
  if (result.whisperUrl) $('whisperUrl').value = result.whisperUrl;
});
$('whisperUrl').addEventListener('change', e => {
  chrome.storage.local.set({ whisperUrl: e.target.value });
});

// Check server + whisper state on popup open
function checkServerStatus(url) {
  const el = $('srvStatus');
  fetch(url + '/health', { signal: AbortSignal.timeout(2000) })
    .then(r => {
      el.textContent = r.ok ? '● รันอยู่' : '● error';
      el.style.color  = r.ok ? '#4ade80' : '#ef4444';
    })
    .catch(() => {
      el.textContent = '● ไม่ได้รัน';
      el.style.color  = '#ef4444';
    });
}

getActiveTab(tab => {
  chrome.tabs.sendMessage(tab.id, { type: 'whisperStatus' }, res => {
    if (chrome.runtime.lastError || !res) return;
    whisperRunning = res.active;
    setWhisperUI(whisperRunning);
  });
});

// Ping server directly from popup (no content script needed)
chrome.storage.local.get(['whisperUrl'], r => {
  checkServerStatus(r.whisperUrl || 'http://localhost:5000');
});

// Launch server via registered ripwhisper:// protocol handler
// One-time setup: run install_protocol.bat first
$('srvBtn').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = 'ripwhisper://start';
  a.click();
  // Re-check server status after a few seconds
  const url = $('whisperUrl').value || 'http://localhost:5000';
  setTimeout(() => checkServerStatus(url), 4000);
  setTimeout(() => checkServerStatus(url), 8000);
});

$('whisperBtn').addEventListener('click', () => {
  getActiveTab(tab => {
    if (whisperRunning) {
      chrome.tabs.sendMessage(tab.id, { type: 'whisperStop' }, () => {
        whisperRunning = false;
        setWhisperUI(false);
      });
    } else {
      const serverUrl = $('whisperUrl').value.trim() || 'http://localhost:5000';
      chrome.storage.local.set({ whisperUrl: serverUrl });
      chrome.tabs.sendMessage(tab.id, { type: 'whisperStart', serverUrl }, res => {
        if (chrome.runtime.lastError || !res) {
          setWhisperUI(false, 'ไม่สามารถเชื่อมต่อ tab');
          return;
        }
        if (res.ok) {
          whisperRunning = true;
          setWhisperUI(true);
        } else {
          setWhisperUI(false, res.error || 'Error');
        }
      });
    }
  });
});
