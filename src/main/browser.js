'use strict';

const PARTITION = 'persist:asterism-browser';

/**
 * Ctrl+Shift+… codes the renderer's hotkey handler acts on. Keep in step with handleHotkey in
 * src/renderer/app.js. C, V, F, E, D and P stay with the page: Asterism's versions act only on terminals.
 */
const HOTKEY_CODES = new Set([
  'Space', 'KeyN', 'KeyO', 'KeyT', 'KeyW', 'KeyB', 'Enter', 'KeyL', 'KeyR', 'KeyH',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Equal', 'Minus',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9',
]);

/** Browser panes may only show web pages and the blank page they open on. */
function allowedUrl(url) {
  if (url === 'about:blank') return true;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Forces a `<webview>`'s settings to the locked-down ones whatever the page asked for. False means refuse it. */
function hardenWebview(webPreferences, params) {
  delete webPreferences.preload;
  delete webPreferences.preloadURL;
  Object.assign(webPreferences, {
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    partition: PARTITION,
  });
  params.partition = PARTITION;
  return allowedUrl(params.src);
}

/** The key event to hand the renderer when a guest keystroke is an Asterism shortcut, otherwise null. */
function appHotkey(input) {
  if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return null;
  if (input.code !== 'Tab' && !(input.shift && HOTKEY_CODES.has(input.code))) return null;
  return { code: input.code, key: input.key, ctrlKey: true, shiftKey: !!input.shift, altKey: false, metaKey: false, repeat: !!input.isAutoRepeat };
}

/** Polices every browser-pane guest: where it may go, what it may ask for, and which keys belong to Asterism. */
function wireBrowserGuests({ app, getWin, send }) {
  const { session, shell } = require('electron');
  const ses = session.fromPartition(PARTITION);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  // will-navigate misses navigations the embedder starts, so local files are refused at the protocol too.
  ses.protocol.handle('file', () => new Response('Local files cannot be opened in a browser pane.', { status: 403 }));

  app.on('web-contents-created', (_e, wc) => {
    if (wc.getType() !== 'webview') return;
    const guard = (e, url) => { if (!allowedUrl(url)) e.preventDefault(); };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    // Guests run with allowpopups so pop-ups reach this handler. That also lifts Chromium's pop-up
    // blocker, so one external open per second stops a page from flooding the system browser.
    let lastOpen = 0;
    wc.setWindowOpenHandler(({ url }) => {
      if (url !== 'about:blank' && allowedUrl(url) && Date.now() - lastOpen > 1000) {
        lastOpen = Date.now();
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'F12' || input.key === 'F11') {
        e.preventDefault();
        if (input.isAutoRepeat) return;
        const win = getWin();
        if (input.key === 'F12') wc.toggleDevTools();
        else if (win) win.setFullScreen(!win.isFullScreen());
        return;
      }
      const hotkey = appHotkey(input);
      if (hotkey) { e.preventDefault(); send('app:hotkey', hotkey); }
    });
  });
}

module.exports = { PARTITION, allowedUrl, hardenWebview, appHotkey, wireBrowserGuests };
