const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

function chromeHarness() {
  const listeners = [];
  const chrome = {
    runtime: {
      id: 'test-extension', getURL: (name) => `chrome-extension://test-extension/${name}`,
      getManifest: () => ({ version: '1.0' }),
      onMessage: {
        addListener: (listener) => listeners.push(listener),
        removeListener: (listener) => listeners.splice(listeners.indexOf(listener), 1),
      },
      sendMessage(message, callback) { callback({ received: message }); },
    },
    downloads: { search(query, callback) { callback([{ id: query.id }]); }, show() {} },
    offscreen: { createDocument: async (...args) => args },
  };
  const context = vm.createContext({ chrome });
  vm.runInContext(source('browser-compat.js'), context);
  return { chrome, context, listeners, browser: context.browser };
}

test('Firefox retains its native Promise API and events', () => {
  const browser = { runtime: { getURL: () => 'moz-extension://test/' } };
  const context = vm.createContext({ browser });
  vm.runInContext(source('browser-compat.js'), context);
  assert.equal(context.browser, browser);
  assert.equal(context.VideoDownloaderBrowser.isChrome, false);
});

test('Chrome callback APIs resolve values and retain synchronous APIs', async () => {
  const { browser } = chromeHarness();
  assert.equal((await browser.downloads.search({ id: 42 }))[0].id, 42);
  assert.equal(browser.runtime.getManifest().version, '1.0');
  assert.equal(browser.runtime.getURL('app.html'), 'chrome-extension://test-extension/app.html');
});

test('Chrome lastError and synchronous validation errors reject', async () => {
  const { chrome, browser } = chromeHarness();
  chrome.downloads.search = (_, callback) => {
    chrome.runtime.lastError = { message: 'Unknown download' };
    callback();
    delete chrome.runtime.lastError;
  };
  await assert.rejects(browser.downloads.search({ id: 99 }), /Unknown download/);
  chrome.downloads.search = () => { throw new Error('Invalid query'); };
  await assert.rejects(browser.downloads.search({}), /Invalid query/);
});

test('Chrome 120 message channels stay open for Promise replies', async () => {
  const { browser, listeners } = chromeHarness();
  browser.runtime.onMessage.addListener(async () => ({ ok: true, answer: 42 }));
  let reply;
  assert.equal(listeners[0]({}, {}, (value) => { reply = value; }), true);
  await Promise.resolve();
  assert.equal(reply.answer, 42);
});

test('unhandled messages do not claim the parser response channel', () => {
  const { browser, listeners } = chromeHarness();
  const listener = () => undefined;
  browser.runtime.onMessage.addListener(listener);
  assert.equal(listeners[0]({ target: 'video-parser' }, {}, () => assert.fail('Unexpected response')), undefined);
  assert.equal(browser.runtime.onMessage.hasListener(listener), true);
  browser.runtime.onMessage.removeListener(listener);
  assert.equal(listeners.length, 0);
  assert.equal(browser.runtime.onMessage.hasListener(listener), false);
});

test('Promise-only offscreen APIs receive no extra callback', async () => {
  const { browser } = chromeHarness();
  const args = await browser.offscreen.createDocument({ url: 'offscreen.html' });
  assert.equal(args.length, 1);
});

test('Chrome show-in-folder is a synchronous API without a callback argument', () => {
  const { chrome, context } = chromeHarness();
  let called;
  chrome.downloads.show = (...args) => { called = args; };
  vm.runInContext(source('browser-compat.js'), context);
  assert.equal(context.browser.downloads.show(42), undefined);
  assert.deepEqual(called, [42]);
});

test('offscreen parser preserves exact quality errors and ignores other senders', () => {
  const { context, browser, listeners } = chromeHarness();
  context.VideoDownloader = {
    parseVideoPage(text, baseUrl, quality) {
      assert.equal(text, '<html></html>');
      assert.equal(quality.exactHeight, 2160);
      const error = new Error('2160p is no longer available.');
      error.availableHeights = [1080, 720];
      throw error;
    },
    parseThumbnail: () => 'https://www.eporner.com/thumb.jpg',
  };
  vm.runInContext(source('offscreen.js'), context);
  let reply;
  listeners[0]({ target: 'other' }, { id: browser.runtime.id }, () => assert.fail('Wrong target'));
  listeners[0]({ target: 'video-parser' }, { id: 'other-extension' }, () => assert.fail('Wrong sender'));
  listeners[0]({ target: 'video-parser', text: '<html></html>', baseUrl: 'https://www.eporner.com/video-1/title/',
    quality: { exactHeight: 2160 } }, { id: browser.runtime.id }, (value) => { reply = value; });
  assert.equal(reply.ok, false);
  assert.deepEqual(reply.availableHeights, [1080, 720]);
  listeners[0]({ target: 'video-parser', thumbnailOnly: true, text: '', baseUrl: 'https://www.eporner.com/' },
    { id: browser.runtime.id }, (value) => { reply = value; });
  assert.equal(reply.value.thumbnail, 'https://www.eporner.com/thumb.jpg');
});
