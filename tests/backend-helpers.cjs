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

class FixtureParser {
  parseFromString(html) {
    const fixture = JSON.parse(html);
    return {
      querySelectorAll: () => fixture.links.map((href) => ({ getAttribute: () => href })),
      querySelector: (selector) => selector === 'h1' ? (fixture.title === null || fixture.title === undefined ? null :
        ({ childNodes: [{ nodeType: 3, textContent: fixture.title }] })) :
        selector === 'meta[property="og:image"]' && fixture.thumbnail ? { getAttribute: () => fixture.thumbnail } : null,
    };
  }
}

function harness({ storage = {}, sessionStorage = {}, records = new Map(), fetchPage, downloadHook,
  created = true, now, permissionsContains, noPermissions = false, noDownloadControls = false,
  failGets = 0, failSets = 0, getHook, setHook } = {}) {
  const onMessage = new Event();
  const onCreated = new Event();
  const onChanged = new Event();
  const onErased = new Event();
  const storageChanged = new Event();
  const errors = [];
  const requests = [];
  const options = [];
  const shown = [];
  const pausedCalls = [];
  const resumedCalls = [];
  const storageWrites = [];
  let maxActive = 0;
  let nextId = Math.max(0, ...records.keys());
  let remainingGetFailures = failGets;
  let remainingSetFailures = failSets;
  const runtimeId = 'video-bulk-downloader@local';
  const getURL = (name) => `moz-extension://test/${name}`;
  function storageArea(data, area) {
    return {
      get: async (key) => {
        if (typeof getHook === 'function') await getHook(area, key);
        if (remainingGetFailures > 0) { remainingGetFailures--; throw new Error('Storage read failed'); }
        return data[key] ? { [key]: clone(data[key]) } : {};
      },
      set: async (values) => {
        if (typeof setHook === 'function') await setHook(area, values);
        if (remainingSetFailures > 0) { remainingSetFailures--; throw new Error('Storage write failed'); }
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          storageWrites.push({ area, key });
          changes[key] = { oldValue: data[key], newValue: clone(value) }; data[key] = clone(value);
        }
        storageChanged.emit(changes, area);
      },
      remove: async (key) => {
        storageWrites.push({ area, key, removed: true });
        delete data[key]; storageChanged.emit({ [key]: {} }, area);
      },
    };
  }
  const permissions = noPermissions ? undefined : {
    contains: permissionsContains || (async () => true),
    request: async () => true,
  };
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
        if (!record) throw new Error(`Invalid download id ${id}`);
        if (record.state === 'complete') throw new Error(`Download ${id} is already complete`);
        Object.assign(record, { state: 'interrupted', error: 'USER_CANCELED', paused: false });
        onChanged.emit({ id, state: { current: 'interrupted' } });
      },
      search: async (query) => clone(query.id === undefined ? [...records.values()] :
        (records.has(query.id) ? [records.get(query.id)] : [])),
      download: async (value) => {
        const stored = value.incognito ? sessionStorage.privateDownloaderState : storage.downloaderState;
        if (!stored || !stored.items.some((item) =>
          item.state === 'downloading' && item.url === value.url && item.startedAt)) {
          throw new Error('The download must have a persisted owner before starting');
        }
        const id = ++nextId;
        const record = { id, state: 'in_progress', mime: 'video/mp4', url: value.url, filename: `/downloads/${value.filename}`,
          byExtensionId: runtimeId, startTime: new Date().toISOString(), endTime: null, error: null, paused: false,
          incognito: value.incognito };
        records.set(id, record);
        options.push(clone(value));
        maxActive = Math.max(maxActive, [...records.values()].filter((d) => d.state === 'in_progress').length);
        if (created) onCreated.emit(clone(record));
        if (downloadHook) await downloadHook(record, value);
        return id;
      },
    },
  };
  if (permissions) browser.permissions = permissions;
  if (!noDownloadControls) {
    // Firefox pauses by cancelling while keeping partial data, so a paused download reads as interrupted.
    browser.downloads.pause = async (id) => {
      pausedCalls.push(id);
      const record = records.get(id);
      if (!record || record.state !== 'in_progress') throw new Error(`Download ${id} cannot be paused since it is in state ${record?.state}`);
      Object.assign(record, { state: 'interrupted', error: 'USER_CANCELED', paused: true });
      onChanged.emit({ id, paused: { current: true }, state: { current: 'interrupted' } });
    };
    browser.downloads.resume = async (id) => {
      resumedCalls.push(id);
      const record = records.get(id);
      if (!record || !record.paused) throw new Error(`Download ${id} cannot be resumed`);
      // Firefox resets startTime when a paused transfer is resumed.
      const prevStart = Date.parse(record.startTime);
      const nowMs = Date.now();
      const nextStart = Number.isFinite(prevStart) ? Math.max(nowMs, prevStart + 1) : nowMs;
      Object.assign(record, { state: 'in_progress', error: null, paused: false, startTime: new Date(nextStart).toISOString() });
      onChanged.emit({ id, paused: { current: false }, state: { current: 'in_progress' } });
    };
    browser.downloads.show = async (id) => {
      shown.push(id);
      if (!records.has(id)) throw new Error('Unknown download');
    };
  }
  const context = vm.createContext({ browser, URL, DOMParser: FixtureParser,
    Date: class extends Date { static now() { return now ? now() : Date.now(); } },
    Node: { TEXT_NODE: 3 }, crypto: webcrypto, AbortController, setTimeout, clearTimeout,
    console: { error: (...args) => errors.push(args) },
    fetch: async (url, init) => {
      requests.push({ url, credentials: init.credentials, cache: init.cache });
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
    shown, pausedCalls, resumedCalls, storageWrites,
    get maxActive() { return maxActive; },
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
  if (!result.ok) throw new Error(`find failed: ${result.error}`);
  return h.until((s) => s.items.every((item) => item.state !== 'finding'), incognito);
}

function start(h, state, saveAs = false, items = state.items, incognito = false, extra = {}) {
  return h.command({ type: 'download', batchId: state.batchId, saveAs,
    items: items.map((item) => ({ id: item.id, filename: item.filename || 'Retry name' })), ...extra }, incognito);
}

function qualityFixture(title, links) {
  return JSON.stringify({ title, links });
}

module.exports = { harness, find, start, tick, clone, qualityFixture };
