// Chrome background integration: background.js delegates the runtime seam to
// globalThis.VideoDownloaderPlatform (platform.js in the extension). These
// tests inject a fake platform before loading background.js and check that the
// adapter is used correctly: contextual downloads calls route to the right
// session, page parsing needs no DOM in the worker, work runs inside runTask,
// startup reconciliation merges both sessions, and the command/download-event
// and private-session hooks are registered. Bridge transport is out of scope.
const test = require('node:test');
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

// The fallback seam parses with a DOM parser, so the no-platform test needs one.
class FixtureParser {
  parseFromString(html) {
    const fixture = JSON.parse(html);
    return {
      querySelectorAll: () => fixture.links.map((href) => ({ getAttribute: () => href })),
      querySelector: (selector) => (selector === 'h1' && fixture.title != null
        ? { childNodes: [{ nodeType: 3, textContent: fixture.title }] } : null),
    };
  }
}

function harness({ storage = {}, sessionStorage = {}, records = new Map(), privateOpen = true,
  parsePage, pageInfo, created = true, withPlatform = true } = {}) {
  const runtimeId = 'video-bulk-downloader@local';
  const getURL = (name) => `moz-extension://test/${name}`;
  const onMessage = new Event();
  const events = { created: new Event(), changed: new Event(), erased: new Event() };
  const calls = [];
  const options = [];
  const errors = [];
  const backend = {
    runtimeId, storage, sessionStorage, records, calls, options, events, created,
    privateOpen, nextId: Math.max(0, ...records.keys()),
    parseCalls: [], searchAllCalls: [], downloadsCalls: [],
    runTaskDepth: 0, runTaskCalls: 0,
    commandDispatcher: null, downloadEventHandlers: {}, privateEndHandler: null, wakeHandler: null,
    parsePage,
    pageInfo: pageInfo || ((baseUrl) => ({
      url: `${baseUrl.replace(/\/$/, '')}/file.mp4`, height: 1080, codec: 'AV1',
      title: 'Title', availableHeights: [720, 1080], thumbnail: '',
    })),
  };
  function makeApi(label) {
    const mine = () => [...records.values()].filter((record) => (label === 'private') === (record.incognito === true));
    return {
      search: async (query) => {
        calls.push({ label, method: 'search', query: clone(query) });
        return clone(query.id === undefined ? mine() : mine().filter((record) => record.id === query.id));
      },
      download: async (value) => {
        calls.push({ label, method: 'download', options: clone(value), inTask: backend.runTaskDepth > 0 });
        const stored = value.incognito ? sessionStorage.privateDownloaderState : storage.downloaderState;
        if (!stored || !stored.items.some((item) =>
          item.state === 'downloading' && item.url === value.url && item.startedAt)) {
          throw new Error('The download must have a persisted owner before starting');
        }
        const id = ++backend.nextId;
        const record = { id, state: 'in_progress', mime: 'video/mp4', url: value.url,
          filename: `/downloads/${value.filename}`, byExtensionId: runtimeId,
          startTime: new Date().toISOString(), endTime: null, error: null, paused: false,
          incognito: value.incognito };
        records.set(id, record);
        options.push(clone(value));
        if (created) events.created.emit(clone(record));
        return id;
      },
      cancel: async (id) => {
        calls.push({ label, method: 'cancel', id });
        const record = records.get(id);
        if (!record) throw new Error(`Invalid download id ${id}`);
        if (record.state === 'complete') throw new Error(`Download ${id} is already complete`);
        Object.assign(record, { state: 'interrupted', error: 'USER_CANCELED', paused: false });
        events.changed.emit({ id, state: { current: 'interrupted' } });
      },
      pause: async (id) => {
        calls.push({ label, method: 'pause', id });
        const record = records.get(id);
        if (!record || record.state !== 'in_progress') throw new Error(`Download ${id} cannot be paused`);
        Object.assign(record, { state: 'interrupted', error: 'USER_CANCELED', paused: true });
        events.changed.emit({ id, paused: { current: true }, state: { current: 'interrupted' } });
      },
      resume: async (id) => {
        calls.push({ label, method: 'resume', id });
        const record = records.get(id);
        if (!record || !record.paused) throw new Error(`Download ${id} cannot be resumed`);
        Object.assign(record, { state: 'in_progress', error: null, paused: false,
          startTime: new Date(Date.now() + 1).toISOString() });
        events.changed.emit({ id, paused: { current: false }, state: { current: 'in_progress' } });
      },
      show: (id) => { calls.push({ label, method: 'show', id }); },
    };
  }
  backend.normalApi = makeApi('normal');
  backend.privateApi = makeApi('private');
  function storageArea(data, area) {
    return {
      get: async (key) => (data[key] ? { [key]: clone(data[key]) } : {}),
      set: async (values) => {
        for (const [key, value] of Object.entries(values)) data[key] = clone(value);
      },
      remove: async (key) => { delete data[key]; },
    };
  }
  const browser = {
    runtime: { id: runtimeId, getURL, onMessage, onStartup: new Event() },
    extension: { isAllowedIncognitoAccess: async () => true },
    action: { onClicked: new Event() },
    tabs: { query: async () => [], create: async () => {}, update: async () => {},
      get: async (id) => ({ id, url: getURL('app.html'), incognito: id === 200 }) },
    windows: { update: async () => {}, getAll: async () => [{ id: 1, incognito: privateOpen }], onRemoved: new Event() },
    storage: { onChanged: new Event(), local: storageArea(storage, 'local'), session: storageArea(sessionStorage, 'session') },
    downloads: { ...backend.normalApi, onCreated: events.created, onChanged: events.changed, onErased: events.erased },
    permissions: { contains: async () => true, request: async () => true },
  };
  const platform = {
    isChrome: true,
    role: 'normal',
    messages: {
      privateAccess: 'Allow this extension to run in Incognito, then retry.',
      privateWindow: 'Keep a private Chrome window open while downloading.',
      downloadMissing: 'This download no longer exists. Retry this file.',
      verifyFailed: 'Previous download could not be verified. Retry this file.',
      checkDownloads: 'Could not check downloads. Retry this action.',
      showUnsupported: 'Showing files is not supported in this browser.',
      pauseUnsupported: 'Pausing downloads is not supported in this browser.',
      resumeUnsupported: 'Resuming downloads is not supported in this browser.',
      privateChannelLost: 'The private session did not answer. Keep a private window open, then retry.',
      outcomeUnknown: 'The private transfer was requested but its result is unknown.',
    },
    parsePage(text, baseUrl, quality, thumbnailOnly) {
      backend.parseCalls.push({ text, baseUrl, quality, thumbnailOnly, inTask: backend.runTaskDepth > 0 });
      return Promise.resolve().then(() => (backend.parsePage
        ? backend.parsePage(text, baseUrl, quality, thumbnailOnly)
        : (thumbnailOnly === true ? { thumbnail: 'thumb.jpg' } : backend.pageInfo(baseUrl, quality))));
    },
    runTask(work) {
      backend.runTaskCalls++;
      backend.runTaskDepth++;
      return Promise.resolve().then(work).finally(() => { backend.runTaskDepth--; });
    },
    downloads(incognito) {
      backend.downloadsCalls.push(incognito === true);
      return incognito === true ? backend.privateApi : backend.normalApi;
    },
    searchAllDownloads(query) {
      backend.searchAllCalls.push(clone(query));
      return backend.normalApi.search(query).then((normal) =>
        (privateOpen ? backend.privateApi.search(query).then((privateRecords) => [...normal, ...privateRecords]) : normal));
    },
    async privateSessionOpen() { return backend.privateOpen; },
    onPrivateSessionEnd(handler) { backend.privateEndHandler = handler; },
    onAlarmWake(handler) { backend.wakeHandler = handler; },
    setCommandDispatcher(dispatcher) { backend.commandDispatcher = dispatcher; },
    setDownloadEventHandler(kind, handler) { backend.downloadEventHandlers[kind] = handler; },
  };
  const context = vm.createContext({ browser, URL, Node: { TEXT_NODE: 3 }, crypto: webcrypto,
    AbortController, setTimeout, clearTimeout,
    ...(withPlatform ? {} : { DOMParser: FixtureParser }),
    console: { error: (...args) => errors.push(args) },
    fetch: async (url) => {
      const id = new URL(url).pathname.split('/')[1];
      return { ok: true, url, text: async () => JSON.stringify({ title: `Title ${id}`,
        links: [`/dload/${id}/1080/clip.mp4`, `/dload/${id}/2160/clip-av1.mp4`] }) };
    } });
  if (withPlatform) context.VideoDownloaderPlatform = platform;
  vm.runInContext(sharedSource, context, { filename: 'shared.js' });
  vm.runInContext(backgroundSource, context, { filename: 'background.js' });
  return {
    browser, backend, context, storage, sessionStorage, records, options, errors,
    calls, platform,
    async command(message, incognito = false) {
      return clone(await onMessage.listeners[0]({ ...message, tabId: incognito ? 200 : 100 },
        { id: runtimeId, url: getURL('app.html'), tab: { id: incognito ? 200 : 100, incognito, url: getURL('app.html') } }));
    },
    async state(incognito = false) { return (await this.command({ type: 'get-state' }, incognito)).state; },
    async until(predicate, incognito = false) {
      const deadline = Date.now() + 8000;
      for (;;) {
        await tick();
        const state = await this.state(incognito);
        if (predicate(state)) return state;
        if (Date.now() > deadline) throw new Error('Background did not reach the expected state');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    complete(id) {
      Object.assign(records.get(id), { state: 'complete', mime: 'video/mp4' });
      events.changed.emit({ id, state: { current: 'complete' } });
    },
  };
}

async function find(h, count = 1, incognito = false) {
  const result = await h.command({ type: 'find', input: Array.from({ length: count },
    (_, i) => `https://www.eporner.com/video-${i + 1}/title/`).join('\n') }, incognito);
  if (!result.ok) throw new Error(`find failed: ${result.error}`);
  return h.until((s) => s.items.every((item) => item.state !== 'finding'), incognito);
}

test('unclaimed Chrome transfers reserve global slots across both browsing modes', async () => {
  for (const incognito of [false, true]) {
    const records = new Map([[88, { id: 88, incognito, state: 'in_progress', byExtensionId: 'video-bulk-downloader@local' }]]);
    const h = harness({ records });
    await h.command({ type: 'concurrency', value: 1 });
    const found = await find(h);
    assert.equal((await start(h, found)).ok, true);
    assert.equal((await h.state()).items[0].state, 'queued');
    assert.equal(h.options.length, 0, 'a native transfer without a verified row still owns its slot');
    h.complete(88);
    await h.until((state) => Number.isInteger(state.items[0].downloadId));
    assert.equal(h.options.length, 1);
    assert.equal(h.calls.filter((call) => call.method === 'cancel').length, 0, 'unclaimed transfers must not be controlled without identity verification');
  }
});

test('other extensions downloads do not consume this extension concurrency slots', async () => {
  const records = new Map([[88, { id: 88, incognito: false, state: 'in_progress', byExtensionId: 'another-extension' }]]);
  const h = harness({ records });
  await h.command({ type: 'concurrency', value: 1 });
  const found = await find(h);
  await start(h, found);
  await h.until((state) => Number.isInteger(state.items[0].downloadId));
  assert.equal(h.options.length, 1);
});

function start(h, state, items = state.items, incognito = false, extra = {}) {
  return h.command({ type: 'download', batchId: state.batchId, saveAs: false,
    items: items.map((item) => ({ id: item.id, filename: item.filename || 'Retry name' })), ...extra }, incognito);
}

test('contextual downloads calls route through the platform to the right session', async () => {
  const h = harness();
  const normal = await find(h);
  const priv = await find(h, 1, true);
  await start(h, normal);
  await start(h, priv, priv.items, true);
  await h.until((s) => Number.isInteger(s.items[0].downloadId));
  await h.until((s) => Number.isInteger(s.items[0].downloadId), true);

  const launches = h.calls.filter((call) => call.method === 'download');
  assert.equal(launches.length, 2);
  const normalLaunch = launches.find((call) => call.label === 'normal');
  const privateLaunch = launches.find((call) => call.label === 'private');
  assert.ok(normalLaunch, 'the normal session download uses the normal API');
  assert.ok(privateLaunch, 'the private session download uses the private API');
  assert.equal(normalLaunch.options.incognito, false, 'the Firefox incognito flag still rides along');
  assert.equal(privateLaunch.options.incognito, true);
  assert.ok(launches.every((call) => call.inTask), 'the bridged Save As launch runs inside runTask');
  assert.ok(h.backend.downloadsCalls.includes(false) && h.backend.downloadsCalls.includes(true),
    'platform.downloads is asked for both contexts');

  h.calls.length = 0;
  await h.command({ type: 'get-progress' });
  assert.ok(h.calls.length > 0);
  assert.ok(h.calls.every((call) => call.label === 'normal'), 'normal refresh never touches the private API');
  h.calls.length = 0;
  await h.command({ type: 'get-progress' }, true);
  assert.ok(h.calls.length > 0);
  assert.ok(h.calls.every((call) => call.label === 'private'), 'private refresh never touches the normal API');

  h.calls.length = 0;
  const cancelled = await h.command({ type: 'cancel', batchId: normal.batchId, id: normal.items[0].id });
  assert.equal(cancelled.ok, true);
  assert.ok(h.calls.some((call) => call.label === 'normal' && call.method === 'cancel'));
  assert.ok(h.calls.every((call) => call.label === 'normal'), 'cancelling a normal transfer stays on the normal API');
});

test('worker page parsing goes through the platform with no DOM and inside runTask', async () => {
  const h = harness({ pageInfo: (baseUrl) => ({ url: `${baseUrl}1080/clip.mp4`, height: 1080,
    codec: 'H264', title: 'No DOM', availableHeights: [720, 1080], thumbnail: '' }) });
  assert.equal(h.context.DOMParser, undefined, 'the worker VM has no DOM parser');
  const state = await find(h, 2);
  assert.equal(state.items.length, 2);
  for (const item of state.items) {
    assert.equal(item.state, 'ready');
    assert.equal(item.title, 'No DOM');
    assert.equal(item.height, 1080);
  }
  assert.equal(h.backend.parseCalls.length, 2);
  for (const call of h.backend.parseCalls) {
    assert.equal(typeof call.text, 'string');
    assert.match(call.baseUrl, /eporner\.com/);
    assert.equal(typeof call.quality, 'object');
    assert.equal(call.thumbnailOnly, undefined);
    assert.equal(call.inTask, true, 'discovery parsing runs inside platform.runTask');
  }
  assert.ok(h.backend.runTaskCalls >= 2);

  const thumb = await h.command({ type: 'thumbnail', batchId: state.batchId, id: state.items[0].id });
  assert.equal(thumb.ok, true);
  const thumbCall = h.backend.parseCalls.at(-1);
  assert.equal(thumbCall.thumbnailOnly, true);
  assert.equal(thumb.state.items[0].thumbnail, 'thumb.jpg');
});

test('parser errors keep their availableHeights for the quality picker', async () => {
  const h = harness({ parsePage: () => {
    throw Object.assign(new Error('No download links found for these qualities.'),
      { availableHeights: [720, 1080] });
  } });
  const state = await find(h, 1);
  assert.equal(state.items[0].state, 'error');
  assert.match(state.items[0].error, /No download links found/);
  assert.deepEqual(state.items[0].availableHeights, [720, 1080]);
});

test('startup reconciliation merges both sessions through searchAllDownloads', async () => {
  const startTime = '2026-01-02T03:04:05.000Z';
  const itemUrl = 'https://cdn.example.com/video-1/1080/clip.mp4';
  const stored = { schemaVersion: 3, revision: 4, batchId: 'batch', incognito: false,
    input: '', inputRevision: 0, saveAs: false, maxHeight: 0, preferredCodec: 'AV1',
    concurrency: 3, items: [{ id: 'row', pageUrl: 'https://www.eporner.com/video-1/title/',
      incognito: false, state: 'downloading', selected: false, filename: 'Clip', history: [],
      maxHeight: 0, preferredCodec: 'AV1', discoveredMaxHeight: 0, discoveredPreferredCodec: 'AV1',
      url: itemUrl, startedAt: 1, downloadId: 9,
      downloadIdentity: { startTime, url: itemUrl, filename: '/downloads/Clip.mp4', incognito: false } }] };
  const records = new Map([
    [9, { id: 9, state: 'complete', mime: 'video/mp4', url: 'https://cdn.example.com/other.mp4',
      filename: '/downloads/Other.mp4', byExtensionId: undefined, startTime, endTime: null,
      error: null, paused: false, incognito: false }],
    [7, { id: 7, state: 'in_progress', mime: 'video/mp4', url: itemUrl,
      filename: '/downloads/Clip.mp4', byExtensionId: undefined, startTime, endTime: null,
      error: null, paused: false, incognito: false }],
  ]);
  const h = harness({ storage: { downloaderState: stored }, records });
  const state = await h.state();
  assert.ok(h.backend.searchAllCalls.some((query) => Object.keys(query).length === 0),
    'the startup search spans both sessions');
  assert.equal(state.items[0].downloadId, 7, 'the fingerprint match is adopted');
  assert.equal(state.items[0].state, 'downloading');
  assert.equal(h.records.get(7).state, 'in_progress');
});

test('the private-session end hook clears private state and cancels only its transfers', async () => {
  const h = harness();
  const normal = await find(h);
  const priv = await find(h, 1, true);
  await start(h, normal);
  await start(h, priv, priv.items, true);
  await h.until((s) => Number.isInteger(s.items[0].downloadId));
  await h.until((s) => Number.isInteger(s.items[0].downloadId), true);
  const privateId = (await h.state(true)).items[0].downloadId;
  const normalId = (await h.state()).items[0].downloadId;

  assert.equal(typeof h.backend.privateEndHandler, 'function');
  await h.backend.privateEndHandler();
  const cleared = await h.state(true);
  assert.equal(cleared.items.length, 0);
  assert.equal(h.sessionStorage.privateDownloaderState, undefined);
  assert.ok(h.calls.some((call) => call.label === 'private' && call.method === 'cancel' && call.id === privateId));
  assert.equal(h.records.get(privateId).state, 'interrupted');
  assert.equal(h.records.get(normalId).state, 'in_progress');
  assert.equal((await h.state()).items[0].state, 'downloading', 'the normal transfer is untouched');
});

test('commands and download events are registered with the platform dispatcher', async () => {
  const h = harness();
  assert.equal(typeof h.backend.commandDispatcher, 'function');
  assert.equal(typeof h.backend.downloadEventHandlers.created, 'function');
  assert.equal(typeof h.backend.downloadEventHandlers.changed, 'function');
  assert.equal(typeof h.backend.downloadEventHandlers.erased, 'function');
  assert.equal(h.browser.downloads.onCreated.listeners.length, 1, 'native listeners stay registered');
  assert.equal(h.browser.downloads.onChanged.listeners.length, 1);
  assert.equal(h.browser.downloads.onErased.listeners.length, 1);

  const sender = { id: h.backend.runtimeId, url: h.browser.runtime.getURL('app.html'),
    tab: { id: 100, incognito: false, url: h.browser.runtime.getURL('app.html') } };
  const reply = await h.backend.commandDispatcher({ type: 'get-state' }, sender);
  assert.equal(reply.ok, true);
  assert.equal(reply.state.items.length, 0);
  const rejected = await h.backend.commandDispatcher({ type: 'get-state' }, { id: 'someone-else' });
  assert.equal(rejected, undefined, 'non-own senders are ignored synchronously');

  const state = await find(h);
  await start(h, state);
  await h.until((s) => Number.isInteger(s.items[0].downloadId));
  const id = (await h.state()).items[0].downloadId;
  h.records.get(id).state = 'complete';
  h.calls.length = 0;
  await h.backend.downloadEventHandlers.changed({ id, state: { current: 'complete' } });
  const after = await h.state();
  assert.equal(after.items[0].state, 'done');
  assert.ok(h.calls.every((call) => call.label === 'normal'), 'event handling routes by owner context');
});

test('the alarm wake handler clears a gone private session and refreshes the rest', async () => {
  const info = (baseUrl) => ({ url: `${baseUrl}1080/clip.mp4`, height: 1080,
    codec: 'AV1', title: 'Wake', availableHeights: [720, 1080], thumbnail: '' });
  const h = harness({ privateOpen: true, parsePage: (text, baseUrl, quality, thumbnailOnly) => {
    if (baseUrl.includes('video-9')) throw new Error('Page request failed. Retry this file.');
    return thumbnailOnly === true ? { thumbnail: '' } : info(baseUrl);
  } });
  const normal = await find(h);
  const priv = await find(h, 1, true);
  await start(h, normal);
  await start(h, priv, priv.items, true);
  await h.until((s) => Number.isInteger(s.items[0].downloadId));
  await h.until((s) => Number.isInteger(s.items[0].downloadId), true);
  const failed = await h.command({ type: 'find', input: 'https://www.eporner.com/video-9/title/' });
  assert.equal(failed.ok, true);
  await h.until((s) => s.items.length === 2 && s.items[1].state === 'error');
  h.calls.length = 0;
  h.backend.privateOpen = false;

  assert.equal(typeof h.backend.wakeHandler, 'function');
  await h.backend.wakeHandler();
  const normalState = await h.state();
  assert.equal(normalState.items.length, 2, 'the normal session is untouched');
  assert.equal(normalState.items[0].state, 'downloading', 'the active transfer is re-verified, not restarted');
  assert.equal(normalState.items[1].state, 'error', 'a failed transfer is never auto-retried');
  assert.equal((await h.state(true)).items.length, 0, 'a gone private session is cleared');
  assert.ok(h.calls.some((call) => call.label === 'private' && call.method === 'cancel'),
    'the private transfer is cancelled through the private API');
  assert.ok(h.calls.some((call) => call.label === 'normal' && call.method === 'search'),
    'the normal session is reconciled and refreshed');
  const launches = h.calls.filter((call) => call.method === 'download');
  assert.equal(launches.length, 0, 'nothing is auto-retried or re-launched');
});

test('without the seam a fallback platform preserves the Firefox private-window error', async () => {
  const h = harness({ withPlatform: false });
  assert.equal(vm.runInContext('typeof platform', h.context), 'object');
  assert.match(vm.runInContext('platform.messages.privateWindow', h.context), /Keep a private Firefox window/);
  const state = await find(h, 1, true);
  h.browser.windows.getAll = async () => [];
  const result = await start(h, state, state.items, true);
  assert.equal(result.ok, false);
  assert.match(result.error, /Keep a private Firefox window/);
  const launches = h.calls.filter((call) => call.method === 'download');
  assert.equal(launches.length, 0);
});
