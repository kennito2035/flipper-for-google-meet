(() => {
  'use strict';

  const DEFAULTS = { enabled: true, mode: 'horizontal' };

  // Opened as a plain file (double-clicking popup.html) instead of as the installed extension,
  // there is no chrome.storage or chrome.tabs. Fall back to an in-memory store so the popup can
  // still be previewed and clicked through; nothing is saved and nothing reaches Meet.
  const standalone = !(typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && chrome.tabs);
  if (standalone) {
    const memory = {};
    const listeners = [];
    window.chrome = {
      ...(window.chrome || {}),
      storage: {
        local: {
          get: async (defaults) => ({ ...defaults, ...memory }),
          set: async (patch) => {
            const changes = {};
            for (const key of Object.keys(patch)) changes[key] = { newValue: patch[key] };
            Object.assign(memory, patch);
            listeners.forEach((fn) => fn(changes, 'local'));
          },
        },
        onChanged: { addListener: (fn) => listeners.push(fn) },
      },
    };
  }

  const enabledEl = document.getElementById('enabled');
  const modeEls = Array.from(document.querySelectorAll('input[name="mode"]'));
  const statusEl = document.getElementById('status');
  const statusTextEl = document.getElementById('statusText');
  const panes = [document.getElementById('paneSelf'), document.getElementById('paneOthers')];
  const liveSelf = document.getElementById('liveSelf');
  const liveOthers = document.getElementById('liveOthers');

  let state = { ...DEFAULTS };

  // Live tiles ------------------------------------------------------------------------------
  // While a Meet tab is sending your camera, page.js posts small JPEGs of two tracks: Meet's own
  // (your self-view, mirrored here the way Meet mirrors it) and the flipped copy that is actually
  // sent to other people. They arrive over a port to bridge.js and are painted into the two tiles.
  // Without frames the tiles show their F placeholder.
  let port = null;
  let live = false;
  let frameSeq = 0;
  let lastFrameAt = 0;

  function setLive(on) {
    if (on === live) return;
    live = on;
    for (const pane of panes) pane.classList.toggle('is-live', on);
    refreshStatus(); // the status line follows the tiles instead of waiting for the next poll
  }

  // Frames come from a page script, so only accept what really is a small JPEG.
  const isJpeg = (s) =>
    typeof s === 'string' && s.length < 400000 && s.startsWith('data:image/jpeg;base64,');

  async function decode(url) {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  }

  function draw(canvas, img) {
    if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
    }
    canvas.getContext('2d').drawImage(img, 0, 0);
  }

  async function onPreviewMessage(msg) {
    if (!msg) return;
    if (msg.type === 'idle') {
      setLive(false);
    } else if (msg.type === 'frame' && isJpeg(msg.self) && isJpeg(msg.others)) {
      const seq = ++frameSeq;
      let self, others;
      try {
        [self, others] = await Promise.all([decode(msg.self), decode(msg.others)]);
      } catch {
        return; // a frame that would not decode: wait for the next one
      }
      if (seq !== frameSeq) return; // a newer frame overtook this one while it decoded
      draw(liveSelf, self);
      draw(liveOthers, others);
      lastFrameAt = Date.now();
      setLive(true);
    }
  }

  // Called on every status refresh while a Meet tab with Flipper is showing: open the port if there
  // is none, otherwise renew it. bridge.js only has page.js produce frames while it hears from us.
  function keepPreviewAlive(tabId) {
    if (port) {
      try {
        port.postMessage({ type: 'keepalive' });
      } catch {
        port = null; // it disconnected under us; the next refresh opens a fresh one
      }
      return;
    }
    let p;
    try {
      p = chrome.tabs.connect(tabId, { name: 'flipper-preview', frameId: 0 });
    } catch {
      return;
    }
    port = p;
    p.onMessage.addListener(onPreviewMessage);
    p.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // read it so Chrome doesn't log it as unchecked
      if (port === p) port = null;
      setLive(false);
    });
  }

  // Frames that stop arriving (camera off, tab gone) mean the placeholder should come back, even if
  // no 'idle' message made it through.
  setInterval(() => {
    if (live && Date.now() - lastFrameAt > 1200) setLive(false);
  }, 400);

  function render() {
    enabledEl.checked = state.enabled;
    for (const el of modeEls) {
      el.checked = el.value === state.mode;
      el.disabled = !state.enabled;
    }
    document.body.classList.toggle('is-off', !state.enabled);
  }

  function setStatus(tone, text) {
    statusEl.dataset.tone = tone;
    statusTextEl.textContent = text;
  }

  async function refreshStatus() {
    if (standalone) {
      setStatus('idle', 'Preview only. Load Flipper as an extension to use it in Meet.');
      return;
    }
    let tab;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch {
      tab = null;
    }
    // tab.url is only visible for hosts the extension has access to, i.e. meet.google.com.
    if (!tab || !tab.url || !tab.url.startsWith('https://meet.google.com/')) {
      setStatus('idle', 'Open a Google Meet tab to use Flipper.');
      return;
    }
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, { type: 'flipper:getStatus' });
      if (!reply || !reply.page) {
        setStatus('warn', "Flipper isn't running on this tab. Reload the Meet tab.");
      } else {
        keepPreviewAlive(tab.id);
        if (reply.active > 0) {
          setStatus('ok', state.enabled ? 'Flipping your camera.' : 'Camera is on. Flip is off.');
        } else {
          setStatus('idle', 'Ready. Flipping starts once you are in a call with your camera on.');
        }
      }
    } catch {
      // No content script answered: the tab was opened before Flipper was installed or reloaded.
      setStatus('warn', "Flipper isn't running on this tab. Reload the Meet tab.");
    }
  }

  function update(patch) {
    state = { ...state, ...patch };
    render();
    chrome.storage.local.set(patch).then(refreshStatus).catch(() => {
      /* extension context invalidated (e.g. reloaded while the popup was open); nothing to save to */
    });
  }

  enabledEl.addEventListener('change', () => update({ enabled: enabledEl.checked }));
  for (const el of modeEls) {
    el.addEventListener('change', () => {
      if (el.checked) update({ mode: el.value });
    });
  }

  // Keep the popup in sync if the Alt+Shift+F shortcut changes the setting while it's open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const patch = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (key in changes) patch[key] = changes[key].newValue ?? DEFAULTS[key];
    }
    state = { ...state, ...patch };
    render();
    refreshStatus();
  });

  (async () => {
    try {
      state = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
    } catch {
      /* storage unavailable: show the defaults rather than a blank popup */
    }
    render();
    // popup.css keeps the popup hidden and every transition off until 'ready'. Reading the layout
    // first makes the browser apply the saved state while they are still off; adding the class in
    // the same breath would let the change animate.
    document.body.getBoundingClientRect();
    document.documentElement.classList.add('ready');
    refreshStatus();
    setInterval(refreshStatus, 1500);
  })();
})();
