'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { PARTITION, allowedUrl, hardenWebview, appHotkey } = require('../src/main/browser');

test('allowedUrl accepts web pages and the blank page only', () => {
  for (const url of ['https://example.com/', 'http://localhost:3000/x?y=1', 'HTTPS://EXAMPLE.COM', 'about:blank']) {
    assert.strictEqual(allowedUrl(url), true, url);
  }
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'chrome://gpu', 'about:config', 'ftp://x', '', 'not a url', undefined]) {
    assert.strictEqual(allowedUrl(url), false, String(url));
  }
});

test('hardenWebview strips the preload and forces the locked-down settings', () => {
  const prefs = { preload: '/evil.js', preloadURL: 'file:///evil.js', nodeIntegration: true, contextIsolation: false, sandbox: false, webSecurity: false, partition: 'other' };
  const params = { src: 'https://example.com', partition: 'other' };
  assert.strictEqual(hardenWebview(prefs, params), true);
  assert.strictEqual(prefs.preload, undefined);
  assert.strictEqual(prefs.preloadURL, undefined);
  assert.strictEqual(prefs.nodeIntegration, false);
  assert.strictEqual(prefs.nodeIntegrationInSubFrames, false);
  assert.strictEqual(prefs.contextIsolation, true);
  assert.strictEqual(prefs.sandbox, true);
  assert.strictEqual(prefs.webSecurity, true);
  assert.strictEqual(prefs.partition, PARTITION);
  assert.strictEqual(params.partition, PARTITION);
});

test('hardenWebview refuses a guest that would open a disallowed address', () => {
  assert.strictEqual(hardenWebview({}, { src: 'file:///home' }), false);
  assert.strictEqual(hardenWebview({}, { src: '' }), false);
  assert.strictEqual(hardenWebview({}, { src: 'about:blank' }), true);
});

test('appHotkey forwards Asterism shortcuts as renderer key events', () => {
  const key = o => ({ type: 'keyDown', control: true, shift: true, alt: false, meta: false, isAutoRepeat: false, ...o });
  assert.deepStrictEqual(appHotkey(key({ code: 'KeyW', key: 'W' })), { code: 'KeyW', key: 'W', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, repeat: false });
  assert.strictEqual(appHotkey(key({ code: 'Digit3', key: '#' })).code, 'Digit3');
  assert.strictEqual(appHotkey(key({ code: 'ArrowLeft', key: 'ArrowLeft', isAutoRepeat: true })).repeat, true);
  const tab = appHotkey(key({ code: 'Tab', key: 'Tab', shift: false }));
  assert.strictEqual(tab.code, 'Tab');
  assert.strictEqual(tab.shiftKey, false);
  assert.strictEqual(appHotkey(key({ code: 'Tab', key: 'Tab' })).shiftKey, true);
});

test('appHotkey forwards every Ctrl+Shift key the renderer handles for any pane', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const body = app.slice(app.indexOf('function handleHotkey('), app.indexOf('\n}\n', app.indexOf('function handleHotkey(')));
  const handled = new Set([...body.matchAll(/case '(\w+)':/g)].map(m => m[1]));
  for (let d = 1; d <= 9; d++) handled.add(`Digit${d}`);
  for (const code of ['KeyC', 'KeyV', 'KeyF', 'KeyE', 'KeyD', 'KeyP']) handled.delete(code);
  const key = code => ({ type: 'keyDown', control: true, shift: true, alt: false, meta: false, code });
  const forwarded = [...handled].filter(code => appHotkey(key(code)));
  assert.deepStrictEqual(forwarded.sort(), [...handled].sort());
  assert.ok(handled.has('KeyB') && handled.has('KeyW'));
});

test('appHotkey leaves the page its own keys', () => {
  const key = o => ({ type: 'keyDown', control: true, shift: true, alt: false, meta: false, ...o });
  assert.strictEqual(appHotkey(key({ code: 'KeyW', shift: false })), null);
  assert.strictEqual(appHotkey(key({ code: 'KeyW', alt: true })), null);
  assert.strictEqual(appHotkey(key({ code: 'KeyW', meta: true })), null);
  assert.strictEqual(appHotkey(key({ code: 'KeyW', control: false })), null);
  assert.strictEqual(appHotkey(key({ code: 'KeyW', type: 'keyUp' })), null);
  for (const code of ['KeyC', 'KeyV', 'KeyF', 'KeyE', 'KeyD', 'KeyP', 'KeyZ', 'KeyI']) assert.strictEqual(appHotkey(key({ code })), null, code);
});
