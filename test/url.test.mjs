import test from 'node:test';
import assert from 'node:assert';
import { toUrl, HOME_URL } from '../src/renderer/url.js';

test('explicit http and https addresses are kept', () => {
  assert.deepStrictEqual(toUrl('https://example.com/a?b=1#c'), { url: 'https://example.com/a?b=1#c' });
  assert.deepStrictEqual(toUrl('http://example.com'), { url: 'http://example.com/' });
  assert.deepStrictEqual(toUrl('  HTTPS://Example.com  '), { url: 'https://example.com/' });
});

test('local hosts and IP addresses become http, with or without a port', () => {
  assert.deepStrictEqual(toUrl('localhost'), { url: 'http://localhost/' });
  assert.deepStrictEqual(toUrl('localhost:3000'), { url: 'http://localhost:3000/' });
  assert.deepStrictEqual(toUrl('localhost:3000/app?x=1'), { url: 'http://localhost:3000/app?x=1' });
  assert.deepStrictEqual(toUrl('127.0.0.1:8080'), { url: 'http://127.0.0.1:8080/' });
  assert.deepStrictEqual(toUrl('[::1]:5173'), { url: 'http://[::1]:5173/' });
  assert.deepStrictEqual(toUrl('192.168.1.20:5173'), { url: 'http://192.168.1.20:5173/' });
  assert.deepStrictEqual(toUrl('0.0.0.0:3000/app'), { url: 'http://0.0.0.0:3000/app' });
});

test('a bare host with a dot becomes https', () => {
  assert.deepStrictEqual(toUrl('example.com'), { url: 'https://example.com/' });
  assert.deepStrictEqual(toUrl('docs.example.co.uk/guide'), { url: 'https://docs.example.co.uk/guide' });
  assert.deepStrictEqual(toUrl('example.com:8443'), { url: 'https://example.com:8443/' });
});

test('about:blank passes through, and the home page is an allowed address', () => {
  assert.deepStrictEqual(toUrl(HOME_URL), { url: HOME_URL });
  assert.deepStrictEqual(toUrl('about:blank'), { url: 'about:blank' });
});

test('other text is searched on Google', () => {
  const search = q => ({ url: `https://www.google.com/search?q=${encodeURIComponent(q)}` });
  for (const t of ['hello', 'how do I centre a div', 'define:asterism', 'c++ vs rust', 'example.com is down?', 'localhost 3000']) {
    assert.deepStrictEqual(toUrl(t), search(t), t);
  }
  assert.deepStrictEqual(toUrl('  a & b  '), { url: 'https://www.google.com/search?q=a%20%26%20b' });
});

test('empty text and refused schemes are errors', () => {
  for (const t of ['', '   ', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'about:config', 'ftp://x.com', 'chrome://gpu', 'VIEW-SOURCE:https://x.com', null, undefined]) {
    assert.ok(toUrl(t).error, String(t));
  }
});
