'use strict';

const test = require('node:test');
const assert = require('node:assert');
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

test('appHotkey leaves the page its own keys', () => {
  const key = o => ({ type: 'keyDown', control: true, shift: true, alt: false, meta: false, ...o });
  assert.strictEqual(appHotkey(key({ code: 'KeyW', shift: false })), null);
  assert.strictEqual(appHotkey(key({ code: 'KeyW', alt: true })), null);
  assert.strictEqual(appHotkey(key({ code: 'KeyW', meta: true })), null);
  assert.strictEqual(appHotkey(key({ code: 'KeyW', control: false })), null);
  assert.strictEqual(appHotkey(key({ code: 'KeyW', type: 'keyUp' })), null);
  for (const code of ['KeyC', 'KeyV', 'KeyF', 'KeyZ', 'KeyI']) assert.strictEqual(appHotkey(key({ code })), null, code);
});
