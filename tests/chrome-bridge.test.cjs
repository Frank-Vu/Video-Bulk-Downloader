const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.join(__dirname, '..');
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  for (let count = 0; count < 200; count++) { if (predicate()) return; await tick(); }
  throw new Error('Bridge did not finish the expected operation');
}
class Event {
  listeners = [];
  addListener(listener) { this.listeners.push(listener); }
  emit(...args) { return this.listeners.map((listener) => listener(...args)); }
}
function epochDatabase(data) {
  return { open() {
    const request = {};
    const database = {
      createObjectStore() {}, close() {},
      transaction() {
        const transaction = { objectStore: () => ({
          get(key) { const read = {}; queueMicrotask(() => {
            read.result = data.get(key); read.onsuccess(); queueMicrotask(() => transaction.oncomplete());
          }); return read; },
          put(value, key) { data.set(key, value); },
        }) };
        return transaction;
      },
    };
    queueMicrotask(() => { request.result = database; request.onupgradeneeded?.(); request.onsuccess(); });
    return request;
  } };
}
function harness(t, { pendingDownload = false, fastProbeTimeout = false } = {}) {
  const data = {};
  const contexts = new Set();
  const records = new Map();
  const downloadCalls = [];
  const errors = [];
  let nextId = 0;
  const privateDb = new Map();
  function make(role, database = privateDb) {
    const storageEvent = new Event();
    const windowsRemoved = new Event();
    const created = new Event();
    const changed = new Event();
    const erased = new Event();
    const timers = new Set();
    const windows = [{ id: role === 'incognito' ? 200 : 100, incognito: role === 'incognito' }];
    const removeWindow = windowsRemoved.emit.bind(windowsRemoved);
    windowsRemoved.emit = (id) => {
      const index = windows.findIndex((window) => window.id === id);
      if (index >= 0) windows.splice(index, 1);
      return removeWindow(id);
    };
    let disposed = false;
    const entry = { storageEvent };
    contexts.add(entry);
    const storage = {
      async get(keys) {
        if (keys === null) return structuredClone(data);
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in data).map((key) => [key, structuredClone(data[key])]));
      },
      async set(values) {
        const changes = {};
        for (const [key, value] of Object.entries(values)) { changes[key] = { oldValue: data[key], newValue: structuredClone(value) }; data[key] = structuredClone(value); }
        for (const context of contexts) queueMicrotask(() => context.storageEvent.emit(changes, 'session'));
      },
      async remove(keys) {
        const changes = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) { if (key in data) { changes[key] = { oldValue: data[key] }; delete data[key]; } }
        for (const context of contexts) queueMicrotask(() => context.storageEvent.emit(changes, 'session'));
      },
    };
    const api = {
      runtime: { id: 'extension', getURL: (name) => `chrome-extension://extension/${name}`,
        onMessage: new Event(), getPlatformInfo: async () => ({}),
        getContexts: async () => [], sendMessage: async () => ({ ok: true, value: { height: 2160 } }) },
      extension: { inIncognitoContext: role === 'incognito' },
      storage: { session: storage, onChanged: storageEvent },
      windows: { getAll: async () => structuredClone(windows),
        onCreated: new Event(), onRemoved: windowsRemoved },
      action: { onClicked: new Event() },
      tabs: { get: async (id) => ({ id, url: 'chrome-extension://extension/app.html', incognito: role === 'incognito' }) },
      alarms: { onAlarm: new Event(), create: async () => {} },
      offscreen: { createDocument: async () => {} },
      downloads: {
        onCreated: created, onChanged: changed, onErased: erased,
        async search(query) { return [...records.values()].filter((item) => (role === 'incognito' || !item.incognito) && (query.id === undefined || query.id === item.id)); },
        async download(options) {
          assert.equal('incognito' in options, false, 'Chrome rejects the Firefox-only option');
          const id = ++nextId;
          const item = { id, url: options.url, incognito: role === 'incognito', byExtensionId: 'extension', state: 'in_progress' };
          records.set(id, item); downloadCalls.push({ role, options });
          if (pendingDownload) return new Promise(() => {});
          created.emit(item); return id;
        },
        async cancel(id) { records.get(id).state = 'interrupted'; changed.emit({ id }); },
        async pause(id) { records.get(id).paused = true; changed.emit({ id }); },
        async resume(id) { records.get(id).paused = false; changed.emit({ id }); },
        show() {},
      },
    };
    const context = vm.createContext({ browser: api, VideoDownloaderBrowser: { isChrome: true }, indexedDB: epochDatabase(database),
      crypto: webcrypto, Blob, Response, CompressionStream, DecompressionStream, btoa, atob,
      setTimeout(callback, ms) { if (disposed) return null; const timer = setTimeout(() => { timers.delete(timer); callback(); }, fastProbeTimeout && ms === 15000 ? 5 : ms); timers.add(timer); return timer; },
      clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
      setInterval(callback, ms) { if (disposed) return null; const timer = setInterval(callback, ms); timers.add(timer); return timer; },
      clearInterval(timer) { timers.delete(timer); clearInterval(timer); }, console: { error: (...args) => errors.push(args) },
    });
    for (const file of ['platform.js', 'chrome-bridge.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
    return { api, platform: context.VideoDownloaderPlatform, bridge: context.VideoDownloaderBridge,
      dispose() { disposed = true; contexts.delete(entry); storageEvent.listeners = []; created.listeners = []; changed.listeners = []; erased.listeners = [];
        for (const timer of timers) clearInterval(timer); },
      async command(message) {
        const sender = { id: api.runtime.id, url: api.runtime.getURL('app.html'), tab: { id: 200, incognito: true, url: api.runtime.getURL('app.html') } };
        return api.runtime.onMessage.emit(message, sender).find((value) => value !== undefined);
      },
    };
  }
  const normal = make('normal');
  let privateWorker = make('incognito');
  t.after(() => { normal.dispose(); privateWorker.dispose(); });
  return { data, records, downloadCalls, errors, normal, privateDb,
    get private() { return privateWorker; },
    async start() { await normal.bridge.start(); await privateWorker.bridge.start(); await tick(); await tick(); },
    async restartPrivate(freshSession = false) { privateWorker.dispose(); privateWorker = make('incognito', freshSession ? new Map() : privateDb);
      await privateWorker.bridge.start(); await tick(); await tick(); },
  };
}

test('private commands reach the single normal dispatcher with their true tab context', async (t) => {
  const h = harness(t);
  h.normal.platform.setCommandDispatcher(async (message, sender) => ({ ok: true, state: { input: message.input, incognito: sender.tab.incognito } }));
  await h.start();
  const result = await h.private.command({ type: 'input', input: 'private draft' });
  assert.equal(result.state.input, 'private draft');
  assert.equal(result.state.incognito, true);
  await tick();
  assert.ok(Object.keys(h.data).every((key) => !key.startsWith('vbdrRequest:') && !key.startsWith('vbdrResponse:')));
});

test('private transfers and controls execute in the incognito worker', async (t) => {
  const h = harness(t);
  await h.start();
  const id = await h.normal.platform.downloads(true).download({ url: 'https://www.eporner.com/dload/private/2160/clip.mp4', incognito: true });
  assert.equal(h.downloadCalls[0].role, 'incognito');
  assert.equal(h.records.get(id).incognito, true);
  await h.normal.platform.downloads(true).pause(id);
  assert.equal(h.records.get(id).paused, true);
  await h.normal.platform.downloads(true).resume(id);
  assert.equal(h.records.get(id).paused, false);
  await h.normal.platform.downloads(true).cancel(id);
  assert.equal(h.records.get(id).state, 'interrupted');
});

test('private queries exclude normal records, and combined recovery searches include both', async (t) => {
  const h = harness(t);
  await h.start();
  h.records.set(41, { id: 41, incognito: false }); h.records.set(42, { id: 42, incognito: true });
  assert.deepEqual(Array.from(await h.normal.platform.downloads(true).search({}), (item) => item.id), [42]);
  assert.deepEqual(Array.from(await h.normal.platform.searchAllDownloads({}), (item) => item.id), [41, 42]);
});

test('large backup messages compress and round-trip without writing persistent storage', async (t) => {
  const h = harness(t);
  const text = 'Unicode backup 🐈 '.repeat(20000);
  h.normal.platform.setCommandDispatcher(async (message) => ({ ok: true, state: { exportText: message.text } }));
  await h.start();
  const result = await h.private.command({ type: 'restore-backup', text });
  assert.equal(result.state.exportText, text);
  assert.equal(h.normal.api.storage.local, undefined);
});

test('private worker suspension preserves its session, and a new private session drops old data', async (t) => {
  const h = harness(t);
  await h.start();
  await until(() => Boolean(h.data.vbdrPrivateDataEpoch));
  const previous = h.data.vbdrPrivateControl.epoch;
  h.data.privateDownloaderState = { input: 'keep during worker suspension' };
  await h.restartPrivate();
  assert.equal(h.data.vbdrPrivateControl.epoch, previous);
  assert.equal(h.data.privateDownloaderState.input, 'keep during worker suspension');
  await h.restartPrivate(true);
  await until(() => h.data.privateDownloaderState === undefined);
  assert.notEqual(h.data.vbdrPrivateControl.epoch, previous);
});

test('native download request is never replayed after private worker termination', async (t) => {
  const h = harness(t, { pendingDownload: true });
  await h.start();
  const result = h.normal.platform.downloads(true).download({ url: 'https://www.eporner.com/dload/private/2160/clip.mp4', incognito: true });
  await until(() => h.downloadCalls.length === 1);
  await h.restartPrivate();
  assert.equal(h.downloadCalls.length, 1);
  assert.equal(await result, 1);
  h.private.api.downloads.onCreated.emit(h.records.get(1));
  assert.equal(h.downloadCalls.length, 1);
});

test('last private window marker clears private state, drafts, and mailbox payloads', async (t) => {
  const h = harness(t);
  await h.start();
  h.data.privateDownloaderState = { input: 'private list' }; h.data.privateDownloaderDraft = { input: 'private draft' };
  h.private.api.windows.onRemoved.emit(200);
  await until(() => h.data.privateDownloaderState === undefined && h.data.privateDownloaderDraft === undefined);
  assert.equal(h.data.vbdrPrivateControl.closing, true);
});

test('private teardown releases an API wait before entering background cleanup', async (t) => {
  const h = harness(t);
  await h.start();
  h.private.api.downloads.search = () => new Promise(() => {});
  const held = h.normal.platform.downloads(true).search({}).catch(() => 'released');
  let cleaned = false;
  h.normal.bridge.onPrivateSessionEnd(async () => { assert.equal(await held, 'released'); cleaned = true; });
  await until(() => Object.entries(h.data).some(([key, value]) => key.startsWith('vbdrRequest:') && value.status === 'started'));
  h.private.api.windows.onRemoved.emit(200);
  await until(() => cleaned);
});

test('delayed closing events and foreign closing epochs preserve the current private payload', async (t) => {
  const h = harness(t);
  await h.start();
  const old = structuredClone(h.data.vbdrPrivateControl);
  await h.restartPrivate(true);
  await until(() => h.data.vbdrPrivateDataEpoch === h.data.vbdrPrivateControl.epoch);
  const currentEpoch = h.data.vbdrPrivateDataEpoch;
  h.data.privateDownloaderState = { input: 'new session' };
  h.normal.api.storage.onChanged.emit({ vbdrPrivateControl: { newValue: { ...old, closing: true, windowIds: [] } } }, 'session');
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(h.data.privateDownloaderState.input, 'new session');
  await h.normal.api.storage.session.set({ vbdrPrivateControl: { ...old, closing: true, windowIds: [] } });
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(h.data.privateDownloaderState.input, 'new session');
  assert.equal(h.data.vbdrPrivateDataEpoch, currentEpoch);
});

test('a worker whose IDB identity has changed cannot publish its old session', async (t) => {
  const h = harness(t);
  await h.start();
  const original = h.data.vbdrPrivateControl.epoch;
  h.privateDb.set('epoch', 'new-partition-identity');
  await assert.rejects(h.private.command({ type: 'state' }), /private Chrome window/);
  assert.equal(h.data.vbdrPrivateControl.epoch, original);
});

test('unrelated removals and a remaining private window do not close the session', async (t) => {
  const h = harness(t);
  await h.start();
  h.data.privateDownloaderState = { input: 'keep' };
  h.private.api.windows.onRemoved.emit(100);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(h.data.vbdrPrivateControl.closing, false);
  h.private.api.windows.getAll = async () => [{ id: 201, incognito: true }];
  h.private.api.windows.onRemoved.emit(200);
  await until(() => h.data.vbdrPrivateControl.windowIds[0] === 201);
  assert.equal(h.data.vbdrPrivateControl.closing, false);
  assert.equal(h.data.privateDownloaderState.input, 'keep');
});

test('cleanup errors still delete stored private data and block commands until memory cleanup succeeds', async (t) => {
  const h = harness(t);
  await h.start();
  let fail = true;
  h.normal.bridge.onPrivateSessionEnd(() => { if (fail) throw new Error('memory cleanup failed'); });
  h.normal.platform.setCommandDispatcher(() => ({ ok: true }));
  h.data.privateDownloaderState = { input: 'old' };
  h.data.privateDownloaderDraft = { input: 'old draft' };
  await h.restartPrivate(true);
  await until(() => !h.data.privateDownloaderState && !h.data.privateDownloaderDraft);
  await assert.rejects(h.private.command({ type: 'state' }), /cleanup failed/);
  fail = false;
  assert.equal((await h.private.command({ type: 'state' })).ok, true);
});

test('private erasure relays exclude normal IDs and include IDs inventoried on startup', async (t) => {
  const h = harness(t);
  h.records.set(41, { id: 41, incognito: false });
  h.records.set(42, { id: 42, incognito: true });
  const erased = [];
  h.normal.platform.setDownloadEventHandler('erased', (id) => erased.push(id));
  await h.start();
  h.private.api.downloads.onErased.emit(41);
  h.private.api.downloads.onErased.emit(42);
  await until(() => erased.length === 1);
  assert.deepEqual(erased, [42]);
});

test('concurrent same-URL calls resolve through their own native callbacks', async (t) => {
  const h = harness(t);
  await h.start();
  const results = await Promise.all([1, 2].map(() => h.normal.platform.downloads(true).download({ url: 'https://www.eporner.com/dload/same.mp4' })));
  assert.equal(new Set(results).size, 2);
  assert.equal(h.downloadCalls.length, 2);
});

test('an interrupted direct-save invocation without a native identity fails without replay', async (t) => {
  const h = harness(t, { pendingDownload: true });
  await h.start();
  const result = h.normal.platform.downloads(true).download({ url: 'https://www.eporner.com/dload/gap.mp4', saveAs: false }).catch((error) => error.message);
  await until(() => h.downloadCalls.length === 1);
  h.records.clear();
  await h.restartPrivate();
  assert.match(await result, /could not be verified/);
  assert.equal(h.downloadCalls.length, 1);
});

test('a restarted Save As request remains pending until its own creation event', async (t) => {
  const h = harness(t, { pendingDownload: true });
  await h.start();
  const result = h.normal.platform.downloads(true).download({ url: 'https://www.eporner.com/dload/dialog.mp4', saveAs: true });
  await until(() => h.downloadCalls.length === 1);
  const item = h.records.get(1);
  h.records.clear();
  await h.restartPrivate();
  assert.ok(Object.values(h.data).some((value) => value?.status === 'started'));
  h.records.set(1, item);
  h.private.api.downloads.onCreated.emit(item);
  assert.equal(await result, 1);
  assert.equal(h.downloadCalls.length, 1);
});

test('ambiguous same-URL restart recovery releases callers without guessing IDs or replaying', async (t) => {
  const h = harness(t, { pendingDownload: true });
  await h.start();
  const results = [1, 2].map(() => h.normal.platform.downloads(true).download({ url: 'https://www.eporner.com/dload/same.mp4' }).catch((error) => error.message));
  await until(() => h.downloadCalls.length === 2);
  await h.restartPrivate();
  for (const result of await Promise.all(results)) assert.match(result, /could not be verified/);
  assert.equal(h.downloadCalls.length, 2);
});

test('watchdog preserves data after one failed probe, then clears on a second failure', async (t) => {
  const h = harness(t, { fastProbeTimeout: true });
  await h.start();
  h.data.privateDownloaderState = { input: 'private' };
  h.data.vbdrPrivateControl.lastSeen -= 60000;
  h.private.dispose();
  h.normal.api.alarms.onAlarm.emit({ name: 'vbdr-wake' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.data.vbdrPrivateProbe.count, 1);
  assert.equal(h.data.privateDownloaderState.input, 'private');
  h.normal.api.alarms.onAlarm.emit({ name: 'vbdr-wake' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.data.privateDownloaderState, undefined);
  assert.equal(h.data.vbdrPrivateControl.closing, true);
});

test('a failed old probe cannot close a private worker that has just restarted', async (t) => {
  const h = harness(t, { fastProbeTimeout: true });
  await h.start();
  h.data.vbdrPrivateControl.lastSeen -= 60000;
  h.private.dispose();
  h.normal.api.alarms.onAlarm.emit({ name: 'vbdr-wake' });
  await until(() => Object.entries(h.data).some(([key, value]) => key.startsWith('vbdrRequest:') && value.kind === 'probe'));
  await h.restartPrivate(true);
  await until(() => h.data.vbdrPrivateDataEpoch === h.data.vbdrPrivateControl.epoch);
  h.data.privateDownloaderState = { input: 'new session' };
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.data.vbdrPrivateControl.closing, false);
  assert.equal(h.data.privateDownloaderState.input, 'new session');
});

test('completed orphan mailbox entries are removed together after their retention period', async (t) => {
  const h = harness(t);
  await h.start();
  h.data['vbdrRequest:orphan'] = { to: 'incognito', from: 'normal', kind: 'download', status: 'started', deadline: null };
  h.data['vbdrResponse:orphan'] = { at: Date.now() - 360000 };
  h.normal.api.alarms.onAlarm.emit({ name: 'vbdr-wake' });
  await until(() => !h.data['vbdrRequest:orphan'] && !h.data['vbdrResponse:orphan']);
  assert.equal(h.downloadCalls.length, 0);
});
