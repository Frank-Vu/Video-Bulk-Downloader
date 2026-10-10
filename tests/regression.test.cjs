const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const root = path.join(__dirname, '..');
const sharedSource = fs.readFileSync(path.join(root, 'shared.js'), 'utf8');
const backgroundSource = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));

class Event {
  listeners = [];
  addListener(listener) { this.listeners.push(listener); }
  emit(...args) { for (const listener of this.listeners) listener(...args); }
}

// The parser sees DOM-shaped fixtures here; real HTML parsing is checked in browser QA.
class FixtureParser {
  parseFromString(html) {
    const fixture = JSON.parse(html);
    return {
      querySelectorAll: () => fixture.links.map((href) => ({ getAttribute: () => href })),
      querySelector: () => ({ childNodes: [{ nodeType: 3, textContent: fixture.title }] }),
    };
  }
}

function harness({ storage = {}, sessionStorage = {}, records = new Map(), fetchPage, downloadHook, created = true, now } = {}) {
  const onMessage = new Event();
  const onCreated = new Event();
  const onChanged = new Event();
  const onErased = new Event();
  const storageChanged = new Event();
  const errors = [];
  const requests = [];
  const options = [];
  let maxActive = 0;
  let nextId = Math.max(0, ...records.keys());
  const runtimeId = 'video-bulk-downloader@local';
  const getURL = (name) => `moz-extension://test/${name}`;
  function storageArea(data, area) {
    return {
      get: async (key) => data[key] ? { [key]: clone(data[key]) } : {},
      set: async (values) => {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: data[key], newValue: clone(value) }; data[key] = clone(value);
        }
        storageChanged.emit(changes, area);
      },
      remove: async (key) => { delete data[key]; storageChanged.emit({ [key]: {} }, area); },
    };
  }
  const browser = {
    runtime: { id: runtimeId, getURL, onMessage, onStartup: new Event() },
    extension: { isAllowedIncognitoAccess: async () => true },
    action: { onClicked: new Event() },
    tabs: { query: async () => [], create: async () => {}, update: async () => {},
      get: async (id) => ({ id, url: getURL('app.html'), incognito: id === 200 }) },
    windows: { update: async () => {}, getAll: async () => [{ id: 1, incognito: true }], onRemoved: new Event() },
    storage: {
      onChanged: storageChanged,
      local: storageArea(storage, 'local'),
      session: storageArea(sessionStorage, 'session'),
    },
    downloads: {
      onCreated, onChanged, onErased,
      cancel: async (id) => {
        const record = records.get(id);
        if (!record || record.state !== 'in_progress') throw new Error('Download is not active');
        record.state = 'interrupted'; record.error = 'USER_CANCELED';
        onChanged.emit({ id, state: { current: 'interrupted' } });
      },
      search: async (query) => clone(query.id === undefined ? [...records.values()] :
        (records.has(query.id) ? [records.get(query.id)] : [])),
      download: async (value) => {
        const stored = value.incognito ? sessionStorage.privateDownloaderState : storage.downloaderState;
        assert.ok(stored.items.some((item) =>
          item.state === 'downloading' && item.url === value.url && item.startedAt),
        'The download must have a persisted owner before starting');
        const id = ++nextId;
        const record = { id, state: 'in_progress', mime: 'video/mp4', url: value.url,
          byExtensionId: runtimeId, startTime: new Date().toISOString(), incognito: value.incognito };
        records.set(id, record);
        options.push(clone(value));
        maxActive = Math.max(maxActive, [...records.values()].filter((d) => d.state === 'in_progress').length);
        if (created) onCreated.emit(clone(record));
        if (downloadHook) await downloadHook(record, value);
        return id;
      },
    },
  };
  const context = vm.createContext({ browser, URL, DOMParser: FixtureParser,
    Date: class extends Date { static now() { return now ? now() : Date.now(); } },
    Node: { TEXT_NODE: 3 }, crypto: webcrypto, AbortController, setTimeout, clearTimeout,
    console: { error: (...args) => errors.push(args) },
    fetch: async (url, init) => {
      requests.push({ url, credentials: init.credentials });
      if (fetchPage) return fetchPage(url, init);
      const id = new URL(url).pathname.split('/')[1];
      return { ok: true, url, text: async () => JSON.stringify({ title: `Title ${id}`,
        links: [`/dload/${id}/1080/clip.mp4`, `/dload/${id}/2160/clip.mp4`, `/dload/${id}/2160/clip-av1.mp4`] }) };
    },
  });
  vm.runInContext(sharedSource, context, { filename: 'shared.js' });
  vm.runInContext(backgroundSource, context, { filename: 'background.js' });
  return {
    browser, storage, sessionStorage, records, requests, options, errors, context,
    get maxActive() { return maxActive; },
    async command(message, incognito = false) {
      return clone(await onMessage.listeners[0]({ ...message, tabId: incognito ? 200 : 100 },
        { id: runtimeId, url: getURL('app.html'), tab: { id: incognito ? 200 : 100, incognito, url: getURL('app.html') } }));
    },
    async state(incognito = false) { return (await this.command({ type: 'get-state' }, incognito)).state; },
    async until(predicate, incognito = false) {
      for (let i = 0; i < 50; i++) {
        await tick();
        const state = await this.state(incognito);
        if (predicate(state)) return state;
      }
      assert.fail('Background did not reach the expected state');
    },
    complete(id, { state = 'complete', mime = 'video/mp4', error } = {}) {
      Object.assign(records.get(id), { state, mime, error });
      onChanged.emit({ id, state: { current: state } });
    },
    erase(id) { records.delete(id); onErased.emit(id); },
  };
}

async function find(h, count = 1, incognito = false) {
  const result = await h.command({ type: 'find', input: Array.from({ length: count },
    (_, i) => `https://www.eporner.com/video-${i + 1}/title/`).join('\n') }, incognito);
  assert.equal(result.ok, true);
  return h.until((s) => s.items.every((item) => item.state !== 'finding'), incognito);
}

function start(h, state, saveAs = false, items = state.items, incognito = false) {
  return h.command({ type: 'download', batchId: state.batchId, saveAs,
    items: items.map((item) => ({ id: item.id, filename: item.filename || 'Retry name' })) }, incognito);
}

test('normalizes allowed URL variants and rejects other origins or credentials', () => {
  const h = harness();
  const { normalizePageUrl } = h.context.VideoDownloader;
  assert.equal(normalizePageUrl('http://eporner.com/video-1/title/#part'),
    'https://www.eporner.com/video-1/title/');
  for (const url of ['https://eporner.com.evil.test/video-1/', 'https://user@eporner.com/video-1/',
    'ftp://eporner.com/video-1/', 'https://eporner.com:123/video-1/', 'https://eporner.com/login/']) {
    assert.throws(() => normalizePageUrl(url));
  }
});

test('validates the final basename, including dots, extensions and Windows device names', () => {
  const { fileBasename } = harness().context.VideoDownloader;
  for (const name of ['', '   ', '.', '..', '.mp4', '..mp4']) assert.throws(() => fileBasename(name));
  assert.equal(fileBasename('.hidden.mp4'), 'hidden');
  assert.equal(fileBasename(' CON.mp4 '), '_CON');
  assert.equal(fileBasename('hello/there.MP4'), 'hello_there');
  assert.ok(!fileBasename('a'.repeat(179) + '.trailing').endsWith('.'));
});

test('highest resolution wins, AV1 is preferred, and foreign download links are ignored', () => {
  const { parseVideoPage } = harness().context.VideoDownloader;
  const fixture = JSON.stringify({ title: 'Example', links: ['/dload/x/1080/a-av1.mp4',
    '/dload/x/2160/a.mp4', '/dload/x/2160/a-av1.mp4', 'https://evil.test/dload/x/4320/a-av1.mp4'] });
  const info = parseVideoPage(fixture, 'https://www.eporner.com/video-x/');
  assert.equal(info.height, 2160);
  assert.equal(info.codec, 'AV1');
  assert.equal(info.title, 'Example');
  const fallback = parseVideoPage(JSON.stringify({ title: 'Example', links: ['/dload/x/2160/a.mp4'] }),
    'https://www.eporner.com/video-x/');
  assert.equal(fallback.codec, 'H.264');
});

test('new URLs append during downloads; competing downloads cannot start the same rows twice', async () => {
  const h = harness();
  const state = await find(h, 5);
  const results = await Promise.all([start(h, state), start(h, state)]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  await h.until((s) => s.items.filter((i) => Number.isInteger(i.downloadId)).length === 3);
  const added = await h.command({ type: 'find', input: 'https://www.eporner.com/video-new/' });
  assert.equal(added.ok, true);
  assert.equal(added.state.items.length, 6);
  assert.equal((await h.state()).batchId, state.batchId);
  h.complete(1);
  await h.until((s) => s.items.some((i) => i.downloadId === 4));
  h.complete(2);
  await h.until((s) => s.items.some((i) => i.downloadId === 5));
  for (const id of [3, 4, 5]) h.complete(id);
  await h.until((s) => s.items.filter((i) => i.state === 'done').length === 5);
  assert.equal(h.maxActive, 3);
  assert.equal(h.errors.length, 0);
});

test('a restored background completes existing downloads and advances the persisted queue', async () => {
  const original = harness();
  const state = await find(original, 5);
  await start(original, state);
  await original.until((s) => s.items.filter((i) => Number.isInteger(i.downloadId)).length === 3);
  original.records.get(1).state = 'complete'; // Event missed while the background page was asleep.
  const restored = harness({ storage: original.storage, records: original.records });
  await restored.until((s) => s.items[0].state === 'done' && s.items.some((i) => i.downloadId === 4));
  assert.equal(restored.options.length, 1, 'Existing downloads must not be restarted');
  restored.complete(2);
  await restored.until((s) => s.items.some((i) => i.downloadId === 5));
  for (const id of [3, 4, 5]) restored.complete(id);
  await restored.until((s) => s.items.every((i) => i.state === 'done'));
  assert.equal(restored.maxActive, 3);
});

test('recovers an ID lost after starting a download without starting a duplicate', async () => {
  const original = harness();
  const state = await find(original);
  await start(original, state);
  await original.until((s) => Number.isInteger(s.items[0].downloadId));
  delete original.storage.downloaderState.items[0].downloadId;
  const restored = harness({ storage: original.storage, records: original.records });
  await restored.until((s) => s.items[0].downloadId === 1);
  assert.equal(restored.options.length, 0);
  restored.complete(1);
  await restored.until((s) => s.items[0].state === 'done');
});

test('HTML completion fails; retry refreshes the URL and preserves the edited filename', async () => {
  const h = harness();
  let state = await find(h);
  await h.command({ type: 'edit', batchId: state.batchId, id: state.items[0].id, filename: 'My video' });
  state = await h.state();
  await start(h, state);
  await h.until((s) => s.items[0].downloadId === 1);
  h.complete(1, { mime: 'text/html; charset=utf-8' });
  state = await h.until((s) => s.items[0].state === 'failed');
  assert.match(state.items[0].error, /instead of a video/);
  assert.equal(state.items[0].filename, 'My video');
  assert.equal(h.context.VideoDownloader.isSelectable(state.items[0]), true);
  const requests = h.requests.length;
  await start(h, state);
  await h.until((s) => s.items[0].downloadId === 2);
  assert.equal(h.requests.length, requests + 1);
  assert.equal(h.options[1].filename, 'Video Bulk Downloads/My video.mp4');
  h.complete(2, { mime: 'application/octet-stream' });
  await h.until((s) => s.items[0].state === 'done');
});

test('page lookup errors are selectable and retryable', async () => {
  let blocked = true;
  const h = harness({ fetchPage: async (url) => blocked ? { ok: false, status: 403 } :
    { ok: true, url, text: async () => JSON.stringify({ title: 'Now available', links: ['/dload/x/2160/a.mp4'] }) } });
  const state = await find(h);
  assert.equal(state.items[0].state, 'error');
  assert.ok(state.items[0].filename, 'Failed page lookups should still have a usable retry name');
  assert.equal(h.context.VideoDownloader.isSelectable(state.items[0]), true);
  blocked = false;
  await start(h, state);
  await h.until((s) => s.items[0].downloadId === 1);
  h.complete(1);
  await h.until((s) => s.items[0].state === 'done');
});

test('save-dialog mode stays sequential even if options change for future downloads', async () => {
  const h = harness();
  const state = await find(h, 3);
  await start(h, state, true);
  await h.until((s) => s.items[0].downloadId === 1);
  assert.equal(h.options.length, 1);
  assert.equal((await h.command({ type: 'settings', saveAs: false })).ok, true);
  for (let id = 1; id <= 3; id++) {
    await h.until((s) => s.items.some((i) => i.downloadId === id));
    h.complete(id);
  }
  await h.until((s) => s.items.every((i) => i.state === 'done'));
  assert.equal(h.maxActive, 1);
  assert.ok(h.options.every((o) => o.saveAs && !o.filename.includes('/')));
});

test('immediate completion is detected even without an onCreated event', async () => {
  const h = harness({ created: false, downloadHook: (record) => { record.state = 'complete'; } });
  const state = await find(h, 4);
  await start(h, state);
  await h.until((s) => s.items.every((i) => i.state === 'done'));
  assert.equal(h.options.length, 4);
});

test('invalid filenames reject the whole batch before starting any download', async () => {
  const h = harness();
  const state = await find(h, 2);
  state.items[1].filename = '.mp4';
  assert.equal((await start(h, state)).ok, false);
  assert.equal(h.options.length, 0);
  assert.ok((await h.state()).items.every((i) => i.state === 'ready'));
});

test('erased or interrupted downloads release their slots and retain retry state', async () => {
  const h = harness();
  const state = await find(h, 4);
  await start(h, state);
  await h.until((s) => s.items.filter((i) => Number.isInteger(i.downloadId)).length === 3);
  h.erase(1);
  await h.until((s) => s.items[0].state === 'failed' && s.items[3].downloadId === 4);
  h.complete(2, { state: 'interrupted', error: 'NETWORK_FAILED' });
  h.complete(3);
  h.complete(4);
  const finished = await h.until((s) => !h.context.VideoDownloader.isBusy(s.items));
  assert.equal(finished.items[1].error, 'NETWORK_FAILED');
  assert.equal(finished.items[1].selected, true);
});

test('canonical URLs deduplicate, and stale tabs cannot edit a removed video', async () => {
  const h = harness();
  const first = await h.command({ type: 'find', input: 'http://eporner.com/video-1/\nhttps://www.eporner.com/video-1/' });
  assert.equal(first.state.items.length, 1);
  await h.until((s) => s.items[0].state === 'ready');
  await find(h, 2);
  await h.command({ type: 'remove', batchId: first.state.batchId, id: first.state.items[0].id });
  const result = await h.command({ type: 'edit', batchId: first.state.batchId,
    id: first.state.items[0].id, filename: 'Stale edit' });
  assert.equal(result.ok, false);
});

test('a delayed ID response from a completed attempt cannot overwrite its retry', async () => {
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const h = harness({ downloadHook: (record) => record.id === 1 ? delayed : undefined });
  let state = await find(h);
  await start(h, state);
  await h.until((s) => s.items[0].downloadId === 1);
  h.complete(1, { mime: 'text/html' });
  state = await h.until((s) => s.items[0].state === 'failed');
  await start(h, state);
  await h.until((s) => s.items[0].downloadId === 2);
  release();
  await tick();
  const current = await h.state();
  assert.equal(current.items[0].downloadId, 2);
  assert.equal(current.items[0].state, 'downloading');
  h.complete(2);
  await h.until((s) => s.items[0].state === 'done');
});

test('a failed metadata lookup does not release an active transfer slot', async () => {
  const h = harness({ created: false });
  const state = await find(h, 4);
  const search = h.browser.downloads.search;
  let failOnce = true;
  h.browser.downloads.search = async (query) => {
    if (failOnce) { failOnce = false; throw new Error('Temporary API failure'); }
    return search(query);
  };
  await start(h, state);
  await h.until((s) => s.items.filter((i) => Number.isInteger(i.downloadId)).length === 3);
  assert.equal(h.options.length, 3);
  assert.equal(h.maxActive, 3);
  h.complete(1);
  await h.until((s) => s.items[3].downloadId === 4);
  for (const id of [2, 3, 4]) h.complete(id);
  await h.until((s) => s.items.every((i) => i.state === 'done'));
});

test('private-session downloads use private cookies instead of the normal login session', async () => {
  // Reproduce a site whose login exists only in Firefox's private cookie jar.
  const h = harness({ downloadHook: (record, options) => {
    record.mime = options.incognito ? 'video/mp4' : 'text/html';
    record.state = 'complete';
  } });
  let state = await find(h);
  await start(h, state);
  state = await h.until((s) => s.items[0].state === 'failed');
  assert.match(state.items[0].error, /normal session/);
  state = await find(h, 1, true);
  await start(h, state, false, state.items, true);
  state = await h.until((s) => s.items[0].state === 'done', true);
  assert.equal(h.options[0].incognito, false);
  assert.equal(h.options[1].incognito, true);
  assert.equal(state.items[0].incognito, true);
  assert.equal(state.incognito, true);
});

test('automatic private session survives background recovery for queued files', async () => {
  const original = harness();
  const state = await find(original, 4, true);
  await start(original, state, false, state.items, true);
  await original.until((s) => s.items.filter((i) => Number.isInteger(i.downloadId)).length === 3, true);
  const restored = harness({ storage: original.storage, sessionStorage: original.sessionStorage, records: original.records });
  await restored.state(true);
  restored.complete(1);
  await restored.until((s) => s.items[3].downloadId === 4, true);
  assert.equal(restored.options[0].incognito, true);
  for (const id of [2, 3, 4]) restored.complete(id);
  await restored.until((s) => s.items.every((i) => i.state === 'done'), true);
});

test('private download permission and an open private window are required before queueing', async () => {
  const h = harness();
  const state = await find(h, 1, true);
  h.browser.extension.isAllowedIncognitoAccess = async () => false;
  let result = await start(h, state, false, state.items, true);
  assert.equal(result.ok, false);
  assert.match(result.error, /Allow this extension/);
  assert.equal(h.options.length, 0);
  h.browser.extension.isAllowedIncognitoAccess = async () => true;
  h.browser.windows.getAll = async () => [];
  result = await start(h, state, false, state.items, true);
  assert.equal(result.ok, false);
  assert.match(result.error, /Keep a private Firefox window/);
  assert.equal((await h.state(true)).items[0].state, 'ready');
});

test('toolbar clicks open or focus the downloader in the clicked window', async () => {
  const h = harness();
  const queries = [];
  const opened = [];
  const focused = [];
  h.browser.tabs.query = async (query) => { queries.push(query); return []; };
  h.browser.tabs.create = async (value) => { opened.push(value); };
  h.browser.action.onClicked.emit({ windowId: 9, incognito: true });
  await tick();
  assert.equal(queries[0].windowId, 9);
  assert.equal(opened[0].windowId, 9);
  h.browser.tabs.query = async (query) => [{ id: 20, windowId: query.windowId,
    url: h.browser.runtime.getURL('app.html') }];
  h.browser.tabs.update = async (id) => { focused.push(id); };
  h.browser.action.onClicked.emit({ windowId: 9, incognito: true });
  await tick();
  assert.equal(focused[0], 20);
  assert.equal(opened.length, 1);
});

test('the UI identifies its actual tab automatically without a session checkbox', async () => {
  const { Element } = require('./dom-helpers.cjs');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  for (const inIncognitoContext of [false, true]) {
    const elements = Object.fromEntries(['urls', 'find', 'download', 'rows', 'summary', 'message',
      'ask', 'clear', 'session', 'saved-rows', 'select-all', 'select-all-saved', 'cancel-selected', 'remove-selected', 'download-saved', 'remove-saved', 'import-file', 'export-found', 'import-found', 'export-saved', 'import-saved', 'found-format', 'saved-format'].map((id) => [id, new Element()]));
    const messages = [];
    let value = { revision: 1, batchId: 'ui-test', saveAs: false, incognito: inIncognitoContext, input: '',
      items: [{ id: 'ui-test:0', state: 'ready', selected: true, filename: 'Video',
        pageUrl: 'https://www.eporner.com/video-test/' }] };
    const context = vm.createContext({
      document: { getElementById: (id) => elements[id], createElement: () => new Element(), createElementNS: () => new Element(), addEventListener() {} },
      window: { addEventListener() {} }, setTimeout, clearTimeout,
      browser: {
        tabs: { getCurrent: async () => ({ id: inIncognitoContext ? 200 : 100, incognito: inIncognitoContext }) },
        storage: { onChanged: new Event() },
        runtime: { sendMessage: async (message) => {
          messages.push(clone(message));
          if (message.type === 'download') {
            value = { ...value, revision: 2,
              items: value.items.map((item) => ({ ...item, state: 'queued' })) };
          }
          return { ok: true, state: clone(value) };
        } },
      },
    });
    vm.runInContext(sharedSource, context);
    vm.runInContext(appSource, context);
    await tick();
    assert.match(elements.session.textContent, inIncognitoContext ? /Private window/ : /Normal window/);
    elements.download.listeners.click();
    await tick();
    assert.equal(messages.find((message) => message.type === 'download').tabId, inIncognitoContext ? 200 : 100);
    assert.equal(messages.find((message) => message.type === 'download').incognito, undefined);
  }
});

test('progress polling reports independent file sizes and speeds without byte-change events or storage writes', async () => {
  let time = Date.now();
  const h = harness({ now: () => time });
  const state = await find(h, 2);
  await start(h, state);
  await h.until((s) => s.items.every((i) => Number.isInteger(i.downloadId)));
  await tick();
  await h.state();
  const persisted = JSON.stringify(h.storage.downloaderState);
  time += 1000;
  Object.assign(h.records.get(1), { bytesReceived: 10 * 1024 ** 2, totalBytes: 40 * 1024 ** 2 });
  Object.assign(h.records.get(2), { bytesReceived: 2 * 1024 ** 2, totalBytes: -1 });
  const polled = await h.command({ type: 'get-progress' });
  assert.equal(polled.ok, true);
  assert.equal(polled.state.items[0].progress.bytesPerSecond, 10 * 1024 ** 2);
  assert.equal(polled.state.items[0].progress.totalBytes, 40 * 1024 ** 2);
  assert.equal(polled.state.items[0].progress.etaSeconds, 3);
  assert.equal(polled.state.items[1].progress.bytesPerSecond, 2 * 1024 ** 2);
  assert.equal(polled.state.items[1].progress.totalBytes, null);
  assert.equal(polled.state.items[1].progress.etaSeconds, null);
  assert.equal(JSON.stringify(h.storage.downloaderState), persisted);
  time += 1000;
  const idle = await h.command({ type: 'get-progress' });
  assert.equal(idle.state.items[0].progress.bytesPerSecond, 0);
  Object.assign(h.records.get(2), { paused: true });
  time += 1000;
  const paused = await h.command({ type: 'get-progress' });
  assert.equal(paused.state.items[1].progress.paused, true);
  assert.equal(paused.state.items[1].progress.bytesPerSecond, 0);
  assert.equal(paused.state.items[1].progress.etaSeconds, null);
  h.complete(1);
  h.complete(2);
  await h.until((s) => s.items.every((i) => i.state === 'done'));
});

test('progress polling reconciles missed completion and resets speed when retrying', async () => {
  let time = Date.now();
  const h = harness({ now: () => time });
  let state = await find(h);
  await start(h, state);
  await h.until((s) => s.items[0].downloadId === 1);
  time += 1000;
  Object.assign(h.records.get(1), { bytesReceived: 5000, totalBytes: 10000, state: 'interrupted', error: 'NETWORK_FAILED' });
  const polled = await h.command({ type: 'get-progress' });
  assert.equal(polled.state.items[0].state, 'failed');
  assert.equal(polled.state.items[0].progress.bytesPerSecond, 0);
  state = polled.state;
  await start(h, state);
  const restarted = await h.until((s) => s.items[0].downloadId === 2);
  assert.equal(restarted.items[0].bytesReceived, 0);
  assert.equal(restarted.items[0].progress.bytesPerSecond, null);
  h.records.get(2).state = 'complete';
  const complete = await h.command({ type: 'get-progress' });
  assert.equal(complete.state.items[0].state, 'done');
});

test('the progress UI refreshes byte counts, handles unknown size and stops polling when hidden or finished', async () => {
  const { Element } = require('./dom-helpers.cjs');
  const elements = Object.fromEntries(['urls', 'find', 'download', 'rows', 'summary', 'message',
    'ask', 'clear', 'session', 'saved-rows', 'select-all', 'select-all-saved', 'cancel-selected', 'remove-selected', 'download-saved', 'remove-saved', 'import-file', 'export-found', 'import-found', 'export-saved', 'import-saved', 'found-format', 'saved-format'].map((id) => [id, new Element()]));
  const documentEvents = {};
  const timers = new Map();
  let timerId = 0;
  let polls = 0;
  let value = { revision: 1, batchId: 'progress-ui', saveAs: false, input: '',
    items: [{ id: 'progress-ui:0', attempt: 'one', downloadId: 1, state: 'downloading',
      filename: 'Video', pageUrl: 'https://www.eporner.com/video-test/', totalBytes: 10 * 1024 ** 2,
      progress: { bytesReceived: 5 * 1024 ** 2, totalBytes: 10 * 1024 ** 2,
        bytesPerSecond: 1024 ** 2, sampledAt: 1000 } }] };
  const storage = new Event();
  const doc = { hidden: false, getElementById: (id) => elements[id], createElement: () => new Element(), createElementNS: () => new Element(),
    addEventListener: (type, listener) => { documentEvents[type] = listener; } };
  const context = vm.createContext({ document: doc, window: { addEventListener() {} },
    setTimeout: (callback) => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    browser: { tabs: { getCurrent: async () => ({ id: 100, incognito: false }) }, storage: { onChanged: storage },
      runtime: { sendMessage: async (message) => {
        if (message.type === 'get-progress') polls++;
        return { ok: true, state: clone(value) };
      } } },
  });
  vm.runInContext(sharedSource, context);
  vm.runInContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), context);
  await tick();
  const progressCell = elements.rows.children[0].children[4];
  const [bar, size, rate] = progressCell.children;
  const [speed, eta] = rate.children;
  assert.equal(bar.value, 50);
  assert.equal(size.textContent, '50.0% · 5.0 MiB / 10.0 MiB');
  assert.equal(speed.textContent, '1.0 MiB/s');
  assert.equal(timers.size, 1);
  value.items[0].progress = { bytesReceived: 6 * 1024 ** 2, totalBytes: null,
    bytesPerSecond: 1024 ** 2, sampledAt: 2000 };
  const [id, callback] = [...timers][0];
  timers.delete(id);
  callback();
  await tick();
  assert.equal(polls, 1);
  assert.equal(bar.value, undefined, 'An unknown total must use an indeterminate bar');
  assert.match(size.textContent, /6.0 MiB downloaded · size unknown/);
  assert.equal(timers.size, 1);
  doc.hidden = true;
  documentEvents.visibilitychange();
  assert.equal(timers.size, 0);
  doc.hidden = false;
  documentEvents.visibilitychange();
  await tick();
  assert.equal(polls, 2);
  assert.equal(timers.size, 1);
  value = { ...value, revision: 2, items: value.items.map((item) => ({ ...item, state: 'done' })) };
  storage.emit({ downloaderState: { newValue: clone(value) } }, 'local');
  assert.equal(timers.size, 0);
  assert.equal(bar.value, 100);
  assert.equal(rate.hidden, true);
});

test('normal and private pasted inputs, lists, settings, and history are isolated', async () => {
  const h = harness();
  const normal = await find(h);
  await h.command({ type: 'input', input: 'normal draft' });
  await h.command({ type: 'find', input: 'https://www.eporner.com/video-private/' }, true);
  const privateState = await h.until((s) => s.items[0]?.state === 'ready', true);
  await h.command({ type: 'input', input: 'private draft' }, true);
  await h.command({ type: 'settings', saveAs: false }, true);
  assert.equal((await h.state()).input, 'normal draft');
  assert.equal((await h.state()).items[0].id, normal.items[0].id);
  assert.equal((await h.state(true)).input, 'private draft');
  assert.equal((await h.state()).saveAs, false);
  assert.equal((await h.state(true)).saveAs, false);
  assert.ok(!JSON.stringify(h.storage).includes('video-private'));
  assert.ok(JSON.stringify(h.sessionStorage).includes('video-private'));
  const crossEdit = await h.command({ type: 'edit', batchId: privateState.batchId,
    id: privateState.items[0].id, filename: 'Cross-session edit' });
  assert.equal(crossEdit.ok, false);
  // A caller's requested cookie mode never overrides its actual tab context.
  const spoof = await h.command({ type: 'download', batchId: normal.batchId,
    incognito: true, saveAs: false, items: [{ id: normal.items[0].id, filename: 'Normal' }] });
  assert.equal(spoof.ok, true);
  await h.until((s) => s.items[0].downloadId === 1);
  assert.equal(h.options[0].incognito, false);
  h.complete(1);
  await h.until((s) => s.items[0].state === 'done');
  assert.equal((await h.state(true)).items[0].history.length, 0);
});

test('normal state persists on browser restart while private state lives only in session storage', async () => {
  const h = harness();
  await find(h);
  await find(h, 2, true);
  await h.command({ type: 'input', input: 'Unsaved-to-Find private draft' }, true);
  const awake = harness({ storage: h.storage, sessionStorage: h.sessionStorage });
  assert.equal((await awake.state()).items.length, 1);
  assert.equal((await awake.state(true)).items.length, 2);
  assert.equal((await awake.state(true)).input, 'Unsaved-to-Find private draft');
  const restarted = harness({ storage: h.storage });
  assert.equal((await restarted.state()).items.length, 1);
  assert.equal((await restarted.state(true)).items.length, 0);
});

test('closing the last private window clears private state and cancels its transfers only', async () => {
  const h = harness();
  const normal = await find(h);
  const privateState = await find(h, 1, true);
  await start(h, normal);
  await start(h, privateState, false, privateState.items, true);
  await h.until((s) => Number.isInteger(s.items[0].downloadId), true);
  const privateId = (await h.state(true)).items[0].downloadId;
  const normalId = (await h.state()).items[0].downloadId;
  h.browser.windows.onRemoved.emit(8); // A private window remains open.
  await tick();
  assert.equal((await h.state(true)).items.length, 1);
  h.browser.windows.getAll = async () => [{ id: 2, incognito: false }];
  h.browser.windows.onRemoved.emit(1);
  await h.until((s) => s.items.length === 0, true);
  assert.equal((await h.state(true)).input, '');
  assert.equal(h.sessionStorage.privateDownloaderState, undefined);
  assert.equal(h.records.get(privateId).state, 'interrupted');
  assert.equal(h.records.get(normalId).state, 'in_progress');
  h.complete(normalId);
  await h.until((s) => s.items[0].state === 'done');
});

test('clearing or replacing pasted text never removes found rows or cancels a transfer', async () => {
  const h = harness();
  const state = await find(h, 4);
  await start(h, state);
  await h.until((s) => s.items.filter((i) => Number.isInteger(i.downloadId)).length === 3);
  await h.command({ type: 'clear-input' });
  assert.equal((await h.state()).input, '');
  assert.equal((await h.state()).items.length, 4);
  assert.equal(h.records.get(1).state, 'in_progress');
  await h.command({ type: 'input', input: 'https://www.eporner.com/video-new/' });
  await h.command({ type: 'find', input: 'https://www.eporner.com/video-new/' });
  const expanded = await h.until((s) => s.items.length === 5 && s.items[4].state === 'ready');
  assert.equal(expanded.items[0].id, state.items[0].id);
  assert.equal(expanded.items[3].state, 'queued');
  for (const id of [1, 2, 3]) h.complete(id);
  await h.until((s) => s.items[3].downloadId === 4);
  h.complete(4);
  await h.until((s) => s.items.filter((i) => i.state === 'done').length === 4);
});

test('queue cancellation prevents the target from starting and keeps it retryable', async () => {
  const h = harness();
  const state = await find(h, 4);
  await start(h, state);
  await h.until((s) => s.items[2].downloadId === 3);
  const result = await h.command({ type: 'cancel', batchId: state.batchId, id: state.items[3].id });
  assert.equal(result.ok, true);
  assert.equal(result.state.items[3].state, 'cancelled');
  assert.equal(h.options.length, 3);
  for (const id of [1, 2, 3]) h.complete(id);
  await h.until((s) => s.items.slice(0, 3).every((i) => i.state === 'done'));
  await tick();
  assert.equal(h.options.length, 3);
  assert.equal(h.context.VideoDownloader.isSelectable((await h.state()).items[3]), true);
});

test('active cancellation calls Firefox, releases the slot, and does not affect other downloads', async () => {
  const h = harness();
  const state = await find(h, 4);
  await start(h, state);
  await h.until((s) => s.items[2].downloadId === 3);
  const result = await h.command({ type: 'cancel', batchId: state.batchId, id: state.items[0].id });
  assert.equal(result.ok, true);
  await h.until((s) => s.items[0].state === 'cancelled' && s.items[3].downloadId === 4);
  assert.equal(h.records.get(1).error, 'USER_CANCELED');
  assert.equal(h.records.get(2).state, 'in_progress');
  for (const id of [2, 3, 4]) h.complete(id);
  await h.until((s) => !h.context.VideoDownloader.isBusy(s.items));
});

test('cancel requested before a download ID arrives cancels the eventual transfer', async () => {
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const h = harness({ created: false, downloadHook: () => delayed });
  const state = await find(h);
  await start(h, state);
  await h.until((s) => s.items[0].startedAt && !Number.isInteger(s.items[0].downloadId));
  await h.command({ type: 'cancel', batchId: state.batchId, id: state.items[0].id });
  assert.equal((await h.state()).items[0].state, 'cancelling');
  release();
  await h.until((s) => s.items[0].state === 'cancelled');
  assert.equal(h.records.get(1).state, 'interrupted');
});

test('removing a pending start hides its row but still cancels the eventual transfer', async () => {
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const h = harness({ created: false, downloadHook: () => delayed });
  const state = await find(h);
  await start(h, state);
  await h.until((s) => s.items[0].startedAt);
  const removed = await h.command({ type: 'remove', batchId: state.batchId, id: state.items[0].id });
  assert.equal(removed.state.items.length, 0);
  release();
  await h.until((s) => s.items.length === 0 && h.records.get(1).state === 'interrupted');
  assert.equal(h.storage.downloaderState.items.length, 0);
});

test('removing a row during page lookup cannot resurrect it when the response arrives late', async () => {
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const h = harness({ fetchPage: async (url) => {
    await delayed;
    return { ok: true, url, text: async () => JSON.stringify({ title: 'Late video', links: ['/dload/x/2160/a.mp4'] }) };
  } });
  const found = await h.command({ type: 'find', input: 'https://www.eporner.com/video-late/' });
  await h.command({ type: 'remove', batchId: found.state.batchId, id: found.state.items[0].id });
  release();
  await tick();
  await tick();
  assert.equal((await h.state()).items.length, 0);
});

test('saved rows retain history across new finds and repeated downloads without deleting saved files', async () => {
  const h = harness();
  let state = await find(h);
  await start(h, state);
  await h.until((s) => s.items[0].downloadId === 1);
  h.complete(1);
  state = await h.until((s) => s.items[0].state === 'done');
  assert.equal(state.items[0].history.length, 1);
  assert.equal(state.items[0].selected, false);
  const originalId = state.items[0].id;
  await h.command({ type: 'find', input: 'https://www.eporner.com/video-1/another-title/?playlist_id=other' });
  state = await h.state();
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].id, originalId);
  assert.equal(state.items[0].state, 'done');
  await start(h, state);
  await h.until((s) => s.items[0].downloadId === 2);
  h.complete(2);
  h.browser.downloads.onChanged.emit({ id: 2, state: { current: 'complete' } });
  state = await h.until((s) => s.items[0].state === 'done');
  assert.equal(state.items[0].history.length, 2, 'Repeated completion events must not duplicate history');
  await h.command({ type: 'remove', batchId: state.batchId, id: originalId });
  assert.equal((await h.state()).items.length, 0);
  assert.equal(h.records.get(1).state, 'complete');
  assert.equal(h.records.get(2).state, 'complete');
});

test('the previous shared storage migrates into separate normal and private lists', async () => {
  const legacy = { schemaVersion: 1, revision: 12, batchId: 'legacy', input: 'Private old input', incognito: true,
    saveAs: false, items: [
      { id: 'normal-old', pageUrl: 'https://www.eporner.com/video-normal/', filename: 'Normal', state: 'done', incognito: false, downloadId: 1 },
      { id: 'private-old', pageUrl: 'https://www.eporner.com/video-private/', filename: 'Private', state: 'ready', incognito: true }
    ] };
  const h = harness({ storage: { downloaderState: legacy } });
  const normal = await h.state();
  const privateState = await h.state(true);
  assert.equal(normal.items[0].id, 'normal-old');
  assert.equal(normal.items[0].history.length, 1);
  assert.equal(normal.input, '');
  assert.equal(privateState.items[0].id, 'private-old');
  assert.equal(privateState.input, 'Private old input');
  assert.ok(!JSON.stringify(h.storage).includes('video-private'));
  assert.equal(h.storage.downloaderState.schemaVersion, 3);
});

test('mixed normal/private save options still enforce one save-dialog download at a time', async () => {
  const h = harness();
  const normal = await find(h, 2);
  const privateState = await find(h, 1, true);
  await start(h, normal);
  await start(h, privateState, true, privateState.items, true);
  await h.until((s) => s.items[1].downloadId === 2);
  assert.equal((await h.state(true)).items[0].state, 'queued');
  h.complete(1); h.complete(2);
  await h.until((s) => s.items[0].downloadId === 3, true);
  assert.equal(h.options[2].saveAs, true);
  h.complete(3);
  await h.until((s) => s.items[0].state === 'done', true);
});

test('ETA display handles seconds, minutes, hours and unavailable speeds', () => {
  const { formatDuration } = harness().context.VideoDownloader;
  assert.equal(formatDuration(59.2), '1m 0s');
  assert.equal(formatDuration(3670), '1h 1m');
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(Infinity), '—');
});

function liveUi(backend, incognito = false) {
  const { Element } = require('./dom-helpers.cjs');
  const elements = Object.fromEntries(['urls', 'find', 'clear', 'download', 'rows', 'summary', 'message',
    'ask', 'session', 'saved-rows', 'select-all', 'select-all-saved', 'cancel-selected', 'remove-selected', 'download-saved', 'remove-saved', 'import-file', 'export-found', 'import-found', 'export-saved', 'import-saved', 'found-format', 'saved-format'].map((id) => [id, new Element()]));
  const timers = new Map(); let nextTimer = 0;
  const links = [];
  const context = vm.createContext({
    URL, Blob,
    document: { getElementById: (id) => elements[id], createElement: (name) => {
      const element = new Element(); if (name === 'a') links.push(element); return element;
    }, createElementNS: () => new Element(), addEventListener() {} },
    window: { addEventListener() {} },
    setTimeout: (fn) => { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: (id) => timers.delete(id),
    browser: {
      tabs: { getCurrent: async () => ({ id: incognito ? 200 : 100, incognito }) },
      runtime: { sendMessage: (message) => backend.command(message, incognito) },
      storage: { onChanged: backend.browser.storage.onChanged },
    },
  });
  vm.runInContext(sharedSource, context);
  vm.runInContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), context);
  return { elements, timers, links };
}

test('UI clear, per-row cancel, remove and empty-list controls work with the real queue', async () => {
  const h = harness();
  await find(h);
  const { elements } = liveUi(h);
  await tick();
  assert.equal(elements.rows.children.length, 1);
  elements.clear.listeners.click();
  await tick(); await h.state(); await tick();
  assert.equal(elements.urls.value, '');
  assert.equal((await h.state()).items.length, 1);
  let row = elements.rows.children[0];
  row.children[6].children[0].listeners.click();
  await h.until((s) => s.items[0].downloadId === 1);
  await tick();
  assert.equal(row.children[6].children[1].hidden, false);
  row.children[6].children[1].listeners.click();
  await h.until((s) => s.items[0].state === 'cancelled');
  await tick();
  assert.equal(row.children[5].children[0].textContent, 'Cancelled');
  row.children[6].children[2].listeners.click();
  await h.until((s) => s.items.length === 0);
  await tick();
  assert.equal(elements.rows.children[0].className, 'empty');
});

test('private UI ignores normal storage updates and saved rows expose their page and re-download action', async () => {
  const h = harness();
  await find(h, 2);
  const state = await find(h, 1, true);
  await start(h, state, false, state.items, true);
  await h.until((s) => s.items[0].downloadId === 1, true);
  h.complete(1);
  await h.until((s) => s.items[0].state === 'done', true);
  const { elements } = liveUi(h, true);
  await tick();
  const privateInput = elements.urls.value;
  assert.equal(elements.rows.children.length, 1);
  assert.match(elements.session.textContent, /Private window/);
  const row = elements['saved-rows'].children[0];
  assert.equal(row.children[1].children[0].href, state.items[0].pageUrl);
  assert.match(row.children[1].children[1].textContent, /Saved 1 time/);
  assert.equal(row.children[6].children[0].title, 'Download again');
  assert.equal(elements.download.disabled, true, 'History rows are not selected automatically');
  await h.command({ type: 'input', input: 'Normal-only draft' });
  await find(h, 3);
  await tick();
  assert.equal(elements.urls.value, privateInput);
  assert.equal(elements.rows.children.length, 1);
  row.children[6].children[0].listeners.click();
  await h.until((s) => s.items[0].downloadId === 2, true);
  assert.equal(h.options[1].incognito, true);
  h.complete(2);
  await h.until((s) => s.items[0].state === 'done', true);
});

test('select-all supports active found rows, while bulk cancel/remove skip running downloads', async () => {
  const h = harness();
  const state = await find(h, 4);
  await start(h, state);
  await h.until((s) => s.items[2].downloadId === 3);
  const ids = state.items.map((item) => item.id);
  await h.command({ type: 'select', batchId: state.batchId, ids, selected: false });
  assert.ok((await h.state()).items.every((item) => !item.selected));
  await h.command({ type: 'select', batchId: state.batchId, ids, selected: true });
  const cancelled = await h.command({ type: 'bulk-cancel', batchId: state.batchId, ids });
  assert.equal(cancelled.state.items[3].state, 'cancelled');
  assert.ok(cancelled.state.items.slice(0, 3).every((item) => item.state === 'downloading'));
  const removed = await h.command({ type: 'bulk-remove', batchId: state.batchId, ids });
  assert.equal(removed.state.items.length, 3);
  assert.ok([...h.records.values()].every((record) => record.state === 'in_progress'));
  for (const id of [1, 2, 3]) h.complete(id);
  await h.until((s) => s.items.every((item) => item.state === 'done'));
});

test('explicit deselection while links are being found survives the lookup callback', async () => {
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const h = harness({ fetchPage: async (url) => {
    await delayed;
    return { ok: true, url, text: async () => JSON.stringify({ title: 'Video', links: ['/dload/x/2160/a.mp4'] }) };
  } });
  const result = await h.command({ type: 'find', input: 'https://www.eporner.com/video-lookup/' });
  await h.command({ type: 'select', batchId: result.state.batchId, ids: [result.state.items[0].id], selected: false });
  release();
  const found = await h.until((s) => s.items[0].state === 'ready');
  assert.equal(found.items[0].selected, false);
});

test('JSON and TXT exports separate found rows from saved history and omit transient download IDs', async () => {
  const h = harness();
  let state = await find(h, 2);
  await start(h, state, false, [state.items[0]]);
  await h.until((s) => s.items[0].downloadId === 1);
  h.complete(1);
  state = await h.until((s) => s.items[0].state === 'done');
  const found = await h.command({ type: 'export', section: 'found', format: 'json' });
  const saved = await h.command({ type: 'export', section: 'saved', format: 'json' });
  assert.equal(JSON.parse(found.state.exportText).items.length, 1);
  const history = JSON.parse(saved.state.exportText);
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].history.length, 1);
  assert.equal(history.items[0].downloadId, undefined);
  assert.equal(history.items[0].history[0].downloadId, undefined);
  const txt = await h.command({ type: 'export', section: 'saved', format: 'txt' });
  assert.equal(txt.state.exportText.trim(), state.items[0].pageUrl);
  const privateExport = await h.command({ type: 'export', section: 'saved', format: 'json' }, true);
  assert.equal(JSON.parse(privateExport.state.exportText).items.length, 0);
});

test('found JSON import refreshes links without auto-downloading and preserves custom names', async () => {
  const source = harness();
  let state = await find(source);
  await source.command({ type: 'edit', batchId: state.batchId, id: state.items[0].id, filename: 'Custom name' });
  const exported = await source.command({ type: 'export', section: 'found', format: 'json' });
  const target = harness();
  const imported = await target.command({ type: 'import', section: 'found', format: 'json', text: exported.state.exportText });
  assert.equal(imported.ok, true);
  state = await target.until((s) => s.items[0].state === 'ready');
  assert.equal(state.items[0].filename, 'Custom name');
  assert.equal(target.options.length, 0);
  assert.equal(target.context.VideoDownloader.isSaved(state.items[0]), false);
});

test('saved JSON/TXT imports restore history in the current session only and deduplicate URLs', async () => {
  const h = harness();
  const text = JSON.stringify({ format: 'video-bulk-downloader', version: 1, section: 'saved', items: [
    { pageUrl: 'https://www.eporner.com/video-archive/', title: 'Archived', filename: 'My file',
      state: 'downloading', downloadId: 999, history: [{ savedAt: '2026-10-09T00:00:00.000Z', filename: 'My file.mp4' }] }
  ] });
  assert.equal((await h.command({ type: 'import', section: 'saved', format: 'json', text }, true)).ok, true);
  const privateState = await h.state(true);
  assert.equal(privateState.items[0].state, 'done');
  assert.equal(privateState.items[0].downloadId, undefined);
  assert.equal(privateState.items[0].history[0].savedAt, '2026-10-09T00:00:00.000Z');
  assert.equal(h.options.length, 0);
  assert.equal((await h.state()).items.length, 0);
  await h.command({ type: 'import', section: 'saved', format: 'txt',
    text: 'https://www.eporner.com/video-archive/\nhttps://www.eporner.com/video-txt/' }, true);
  assert.equal((await h.state(true)).items.length, 2);
  assert.equal((await h.state(true)).items[1].history[0].imported, true);
});

test('invalid or wrong-section imports do not mutate lists or accept foreign URLs', async () => {
  const h = harness();
  await find(h);
  const before = await h.state();
  for (const request of [
    { format: 'json', text: '{invalid' },
    { format: 'txt', text: 'https://evil.test/video-1/' },
    { format: 'txt', text: 'https://www.eporner.com/video-valid/\nhttps://evil.test/video-invalid/' },
    { format: 'json', text: JSON.stringify({ format: 'video-bulk-downloader', version: 1, section: 'saved', items: [] }) },
  ]) {
    const result = await h.command({ type: 'import', section: 'found', ...request });
    assert.equal(result.ok, false);
    assert.deepEqual((await h.state()).items, before.items);
  }
});

test('save dialogs default off after upgrading but preserve new explicit preferences and queued options', async () => {
  const legacy = { schemaVersion: 2, revision: 1, batchId: 'old', input: '', inputRevision: 0,
    incognito: false, saveAs: true, items: [] };
  const h = harness({ storage: { downloaderState: legacy } });
  assert.equal((await h.state()).saveAs, false);
  assert.equal((await h.state(true)).saveAs, false);
  await h.command({ type: 'settings', saveAs: true });
  const restored = harness({ storage: h.storage });
  assert.equal((await restored.state()).saveAs, true);
});

test('UI selects rows by background click, shows partial select-all, and moves completed rows to saved', async () => {
  const h = harness();
  const state = await find(h, 2);
  const { elements } = liveUi(h);
  await tick();
  assert.equal(elements['select-all'].checked, true);
  const row = elements.rows.children[0];
  row.listeners.click({ target: { closest: () => null } });
  await tick(); await h.state(); await tick();
  assert.equal((await h.state()).items[0].selected, false);
  assert.equal(elements['select-all'].indeterminate, true);
  row.listeners.click({ target: { closest: () => ({ tagName: 'A' }) } });
  await tick();
  assert.equal((await h.state()).items[0].selected, false, 'A link click must not toggle row selection');
  elements['select-all'].checked = true;
  elements['select-all'].listeners.change();
  await tick(); await h.state(); await tick();
  assert.ok((await h.state()).items.every((item) => item.selected));
  assert.equal(elements['select-all'].indeterminate, false);
  await start(h, state, false, [state.items[0]]);
  await h.until((s) => s.items[0].downloadId === 1);
  h.complete(1);
  await h.until((s) => s.items[0].state === 'done');
  await tick();
  assert.equal(elements.rows.children.filter((node) => node.className.startsWith('video-row')).length, 1);
  assert.equal(elements['saved-rows'].children.filter((node) => node.className.startsWith('video-row')).length, 1);
  const savedRow = elements['saved-rows'].children[0];
  assert.equal(savedRow.children[6].children[0].title, 'Download again');
  assert.equal(savedRow.children[6].children[0].children[0].children.length, 1, 'The action button contains an SVG icon');
});

test('UI file import uses the chosen saved section and format without starting transfers', async () => {
  const h = harness();
  const { elements } = liveUi(h);
  await tick();
  elements['saved-format'].value = 'txt';
  elements['import-saved'].listeners.click();
  assert.match(elements['import-file'].accept, /txt/);
  elements['import-file'].files = [{ size: 50, text: async () => 'https://www.eporner.com/video-imported/' }];
  elements['import-file'].listeners.change();
  await h.until((s) => s.items.length === 1);
  await tick();
  assert.equal(elements['saved-rows'].children[0].className.startsWith('video-row'), true);
  assert.equal(elements.rows.children[0].className, 'empty');
  assert.equal(h.options.length, 0);
  assert.match(elements['saved-rows'].children[0].children[1].children[1].textContent, /Imported saved entry/);
});

test('UI JSON export creates a downloadable file for only the chosen section', async () => {
  const h = harness();
  await find(h);
  const { elements, timers, links } = liveUi(h);
  await tick();
  elements['found-format'].value = 'json';
  elements['export-found'].listeners.click();
  await tick(); await h.state(); await tick();
  const fileLink = links.find((link) => link.download);
  assert.ok(fileLink.download.startsWith('found-videos-'));
  assert.ok(fileLink.download.endsWith('.json'));
  const file = JSON.parse(await (await fetch(fileLink.href)).text());
  assert.equal(file.section, 'found');
  assert.equal(file.items.length, 1);
  assert.equal(h.options.length, 0);
  for (const fn of timers.values()) fn();
});

test('action icons draw inline geometry without external SVG references or stylesheet-dependent strokes', () => {
  class Node {
    children = []; attributes = {};
    constructor(tag) { this.tag = tag; }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(child) { this.children.push(child); }
  }
  const { createActionIcon } = harness().context.VideoDownloader;
  const document = { createElementNS: (_, name) => new Node(name) };
  for (const icon of ['search', 'download', 'retry', 'cancel', 'trash', 'clear', 'export', 'import']) {
    const svg = createActionIcon(document, icon);
    assert.ok(svg.children.length > 0);
    assert.ok(svg.children.every((node) => ['path', 'circle'].includes(node.tag)));
    assert.equal(svg.attributes.stroke, 'currentColor');
    assert.equal(svg.attributes.fill, 'none');
    assert.equal(svg.attributes.width, '18');
    assert.equal(svg.attributes.height, '18');
    assert.equal(svg.attributes.viewBox, '0 0 24 24');
    assert.ok(svg.children.every((node) => !node.attributes.href));
  }
  const html = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
  assert.ok(!html.includes('<use'));
  assert.ok(!html.includes('icons/actions.svg#'));
  const toolbarIcons = html.match(/<svg[^>]*class="action-icon"[^>]*>.*?<\/svg>/gs);
  assert.equal(toolbarIcons.length, 12);
  assert.ok(toolbarIcons.every((svg) => svg.includes('stroke="currentColor"') && /<(path|circle)\b/.test(svg)));
  assert.match(html, /app\.css\?v=[a-z-]+\d+/);
});
