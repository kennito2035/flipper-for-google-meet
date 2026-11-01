// Flipper: bridge script. Runs in the extension's isolated content-script world.
// It connects three things: chrome.storage (saved settings), the popup (status checks),
// and page.js (which lives in the page's own world and can't use chrome.* APIs).
(() => {
  'use strict';

  const DEFAULTS = { enabled: true, mode: 'horizontal' };
  const TO_PAGE = 'flipper-content';
  const FROM_PAGE = 'flipper-page';

  const toPage = (msg) => window.postMessage({ source: TO_PAGE, ...msg }, window.location.origin);
  const fromPage = (e, type) =>
    e.source === window && e.data && e.data.source === FROM_PAGE && e.data.type === type;

  async function pushConfig() {
    try {
      const s = await chrome.storage.local.get(DEFAULTS);
      toPage({ type: 'config', enabled: s.enabled, mode: s.mode });
    } catch {
      /* the extension was reloaded; this old copy of the script is orphaned */
    }
  }

  // page.js announces itself, then we send it the saved settings.
  window.addEventListener('message', (e) => {
    if (fromPage(e, 'hello')) pushConfig();
  });

  // Any settings change (popup or shortcut) is forwarded to the page immediately.
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'local') pushConfig();
  });

  // Alt+Shift+F toggles flipping.
  window.addEventListener(
    'keydown',
    async (e) => {
      if (!(e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyF')) return;
      e.preventDefault(); // stop macOS from typing a special character
      // Holding the combo down fires repeated keydowns. Each would read the current "enabled"
      // value and write its negation; two of those in flight at once race and can collapse
      // several toggles into one. Only the initial press should flip it.
      if (e.repeat) return;
      try {
        const { enabled } = await chrome.storage.local.get(DEFAULTS);
        await chrome.storage.local.set({ enabled: !enabled });
      } catch {
        /* orphaned script, ignore */
      }
    },
    true
  );

  // Live preview for the popup's two tiles. The popup opens a port while it is showing and keeps
  // renewing it; only then does page.js spend any effort producing preview frames.
  let previewPort = null;

  // Anything the page world posts could have been forged by a script on the page, so only pass
  // on what really is a small JPEG.
  const isJpeg = (s) =>
    typeof s === 'string' && s.length < 400000 && s.startsWith('data:image/jpeg;base64,');

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'flipper-preview') return;
    previewPort = port;
    toPage({ type: 'preview-watch' });
    port.onMessage.addListener((msg) => {
      // The popup renews every second or so. If it stops (crash, extension reload), page.js
      // notices the silence and stops producing frames by itself.
      if (msg && msg.type === 'keepalive') toPage({ type: 'preview-watch' });
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // read it so Chrome doesn't log it as unchecked
      if (previewPort !== port) return; // a newer popup already took over
      previewPort = null;
      toPage({ type: 'preview-stop' });
    });
  });

  window.addEventListener('message', (e) => {
    if (!previewPort) return;
    try {
      if (fromPage(e, 'preview-frame')) {
        if (isJpeg(e.data.self) && isJpeg(e.data.others)) {
          previewPort.postMessage({ type: 'frame', self: e.data.self, others: e.data.others });
        }
      } else if (fromPage(e, 'preview-idle')) {
        previewPort.postMessage({ type: 'idle' });
      }
    } catch {
      /* the popup closed while a frame was in flight */
    }
  });

  // The popup asks: is page.js alive, and is a camera being flipped right now?
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'flipper:getStatus') return false;

    let settled = false;
    let timer = null;
    const finish = (reply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('message', onStatus);
      sendResponse(reply);
    };
    function onStatus(e) {
      if (fromPage(e, 'status')) finish({ page: true, active: e.data.active });
    }

    timer = setTimeout(() => finish({ page: false, active: 0 }), 500);
    window.addEventListener('message', onStatus);
    toPage({ type: 'ping' });
    return true; // keep the message channel open for the async reply
  });

  pushConfig();
})();