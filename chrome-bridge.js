/* Split incognito workers share storage.session, but browser API calls keep
 * their own cookie/download context. This mailbox never writes storage.local.
 */
(() => {
  const api = browser;
  const platform = VideoDownloaderPlatform;
  const role = platform.role;
  const CONTROL = 'vbdrPrivateControl';
  const DATA_EPOCH = 'vbdrPrivateDataEpoch';
  const PROBE = 'vbdrPrivateProbe';
  const REQUEST = 'vbdrRequest:';
  const RESPONSE = 'vbdrResponse:';
  const pending = new Map();
  const processing = new Set();
  const endHandlers = [];
  const knownPrivateIds = new Set();
  let epoch = null;
  let control = null;
  let initialization;
  let lifecycle = Promise.resolve();
  let lifecycleRevision = 0;
  let lifecycleFailure = null;
  let collecting = null;
  const privateWindows = new Set();
  const log = (error) => console.error('Video Bulk Downloader bridge:', error);
  const requestKey = (id) => REQUEST + id;
  const responseKey = (id) => RESPONSE + id;

  async function encode(value) {
    const json = JSON.stringify({ value });
    if (json.length < 32768 || typeof CompressionStream === 'undefined') return { json };
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    }
    return { gzip: btoa(binary) };
  }

  async function decode(value) {
    if (typeof value?.json === 'string') return JSON.parse(value.json).value;
    if (typeof value?.gzip !== 'string') throw new Error('Invalid session message.');
    const bytes = Uint8Array.from(atob(value.gzip), (character) => character.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text()).value;
  }

  async function respond(id, value, error, record) {
    const data = await encode(error ? { ok: false, error: error.message || String(error) } : { ok: true, value });
    const current = () => !record || (control && !control.closing && control.epoch === record.epoch);
    if (!current()) return;
    if (!(await api.storage.session.get(requestKey(id)))[requestKey(id)]) return;
    await api.storage.session.set({ [responseKey(id)]: { data, epoch: record?.epoch, at: Date.now() } });
    if (!current() || !(await api.storage.session.get(requestKey(id)))[requestKey(id)]) await api.storage.session.remove(responseKey(id));
  }

  function settle(id, response) {
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    if (waiter.timer) clearTimeout(waiter.timer);
    void decode(response.data).then((result) => {
      if (result.ok) waiter.resolve(result.value);
      else waiter.reject(new Error(result.error));
    }, waiter.reject).finally(() => {
      void api.storage.session.remove([requestKey(id), responseKey(id)]).catch(log);
    });
  }

  function rpc(to, kind, value, timeout = 15000) {
    return platform.runTask(async () => {
      await initialization;
      const id = crypto.randomUUID();
      const data = await encode(value);
      const record = { to, from: role, kind, data, epoch: role === 'incognito' ? epoch : control?.epoch,
        at: Date.now(), deadline: timeout ? Date.now() + timeout : null, status: 'queued' };
      return new Promise((resolve, reject) => {
        const timer = timeout ? setTimeout(() => {
          pending.delete(id);
          void api.storage.session.remove([requestKey(id), responseKey(id)]).catch(log);
          reject(new Error(to === 'incognito' ? platform.messages.privateChannelLost : 'The downloader did not answer. Retry this action.'));
        }, timeout) : null;
        pending.set(id, { resolve, reject, timer, to, epoch: record.epoch });
        api.storage.session.set({ [requestKey(id)]: record }).catch((error) => {
          pending.delete(id); if (timer) clearTimeout(timer); reject(error);
        });
      });
    });
  }

  // IndexedDB belongs to the incognito storage partition: its identity
  // survives worker suspension and disappears with that private session.
  function privateEpoch() {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('video-downloader-private-session', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('metadata');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction('metadata', 'readwrite');
        const store = transaction.objectStore('metadata');
        const read = store.get('epoch');
        let value;
        read.onsuccess = () => { value = read.result || crypto.randomUUID(); if (!read.result) store.put(value, 'epoch'); };
        transaction.oncomplete = () => { database.close(); resolve(value); };
        transaction.onabort = () => { database.close(); reject(transaction.error || new Error('Private session could not be initialized.')); };
      };
    });
  }

  async function publishControl({ refresh = false } = {}) {
    // An old worker must never claim windows belonging to a later OTR
    // partition. Worker suspension alone preserves the IDB identity.
    if (await privateEpoch() !== epoch) throw new Error(platform.messages.privateWindow);
    if (refresh) {
      const windows = await api.windows.getAll();
      privateWindows.clear();
      for (const window of windows) if (window.incognito) privateWindows.add(window.id);
    }
    const value = { epoch, windowIds: [...privateWindows], lastSeen: Date.now(), closing: privateWindows.size === 0 };
    control = value;
    await api.storage.session.set({ [CONTROL]: value });
    return value;
  }

  function queueLifecycle(next) {
    const revision = ++lifecycleRevision;
    const work = lifecycle.then(async () => {
      // Storage events and failed probes can arrive after a newer publish.
      // Always act on the current record, never the event's old snapshot.
      const stored = await api.storage.session.get([CONTROL, DATA_EPOCH]);
      if (revision !== lifecycleRevision) return;
      next = stored[CONTROL];
      const previous = stored[DATA_EPOCH];
      const ended = !next || next.closing || !next.windowIds?.length;
      if (ended && previous && next?.epoch && previous !== next.epoch) return;
      control = next || null;
      const changed = Boolean(previous && next?.epoch && previous !== next.epoch);
      if (ended || changed || lifecycleFailure) {
        // Release API waits before entering the serialized background cleanup.
        // A command already holding that queue may itself be awaiting a reply
        // from the private worker that just disappeared.
        for (const [id, waiter] of pending) {
          if (waiter.to !== 'incognito' || (!ended && waiter.epoch === next?.epoch)) continue;
          pending.delete(id); if (waiter.timer) clearTimeout(waiter.timer);
          waiter.reject(new Error(platform.messages.privateWindow));
          await api.storage.session.remove([requestKey(id), responseKey(id)]);
        }
        lifecycleFailure = null;
        for (const handler of endHandlers) {
          try { await handler(); }
          catch (error) { lifecycleFailure = error; log(error); }
        }
        // Delete the durable session payload even if a consumer's memory
        // cleanup failed. Private commands stay blocked until cleanup works.
        await api.storage.session.remove(['privateDownloaderState', 'privateDownloaderDraft']);
        const all = await api.storage.session.get(null);
        const stale = Object.entries(all).filter(([key, value]) =>
          ((key.startsWith(REQUEST) && (value.from === 'incognito' || value.to === 'incognito')) || key.startsWith(RESPONSE)) &&
          (ended || value.epoch !== next?.epoch)).flatMap(([key]) => key.startsWith(REQUEST)
            ? [key, responseKey(key.slice(REQUEST.length))] : [key]);
        if (stale.length) await api.storage.session.remove(stale);
      }
      if (revision !== lifecycleRevision) return;
      if (ended) await api.storage.session.remove(DATA_EPOCH);
      else if (!lifecycleFailure && previous !== next.epoch) await api.storage.session.set({ [DATA_EPOCH]: next.epoch });
    });
    lifecycle = work.catch((error) => { lifecycleFailure = error; log(error); });
    return work;
  }

  async function privateSessionOpen() {
    const data = await api.storage.session.get(CONTROL);
    const next = data[CONTROL];
    control = next || null;
    return Boolean(!lifecycleFailure && next && !next.closing && next.windowIds?.length);
  }

  async function downloadOp(name, args) {
    if (!await privateSessionOpen()) throw new Error(platform.messages.privateWindow);
    return rpc('incognito', 'download', { name, args }, name === 'download' ? 0 : 15000);
  }

  async function processRequest(id, record) {
    if (record?.to !== role || processing.has(id)) return;
    processing.add(id);
    try {
      await initialization;
      if (record.deadline && record.deadline < Date.now()) {
        await api.storage.session.remove([requestKey(id), responseKey(id)]); return;
      }
      if (role === 'incognito' && record.epoch !== epoch) throw new Error(platform.messages.privateWindow);
      const existing = await api.storage.session.get(responseKey(id));
      if (existing[responseKey(id)]) return;
      if (record.status === 'started') {
        // A native download may still have a Save As prompt open. Its next
        // creation event supplies the result; replaying would launch twice.
        if (record.kind === 'download') {
          const payload = await decode(record.data);
          if (payload.name === 'download') {
            const items = await api.downloads.search({});
            const candidates = items.filter((item) => item.incognito && item.byExtensionId === api.runtime.id &&
              item.url === payload.args[0]?.url && !record.beforeIds?.includes(item.id));
            const all = await api.storage.session.get(null);
            let owners = 0;
            for (const [key, other] of Object.entries(all)) {
              if (!key.startsWith(REQUEST) || other.to !== 'incognito' || other.kind !== 'download' || other.epoch !== epoch || other.status !== 'started' || all[responseKey(key.slice(REQUEST.length))]) continue;
              const operation = await decode(other.data);
              if (operation.name === 'download' && operation.args[0]?.url === payload.args[0]?.url) owners++;
            }
            if (record.beforeIds && candidates.length === 1 && owners === 1) await respond(id, candidates[0].id, null, record);
            else if (candidates.length > 1 || owners > 1 || payload.args[0]?.saveAs !== true) {
              // An interrupted invocation with no unique native identity is
              // never replayed. Save As alone may legitimately await a dialog.
              throw new Error(platform.messages.outcomeUnknown);
            }
            return;
          }
        }
        throw new Error('The previous action was interrupted. Check its status, then retry.');
      }
      const payload = await decode(record.data);
      if (role === 'normal') {
        await lifecycle;
        if (lifecycleFailure) throw new Error('Private session cleanup failed. Retry this action.');
      }
      if (role === 'incognito' && record.kind === 'download' && payload.name === 'download') {
        const items = await api.downloads.search({});
        record = { ...record, beforeIds: items.filter((item) => item.incognito && item.url === payload.args[0]?.url).map((item) => item.id) };
      }
      await api.storage.session.set({ [requestKey(id)]: { ...record, status: 'started' } });
      const result = await platform.runTask(async () => {
        if (role === 'normal' && record.kind === 'command') {
          if (!control || control.closing || record.epoch !== control.epoch) throw new Error(platform.messages.privateWindow);
          return platform.dispatchCommand(payload.message, payload.sender);
        }
        if (role === 'normal' && record.kind === 'event') {
          if (!control || control.closing || record.epoch !== control.epoch) throw new Error(platform.messages.privateWindow);
          return platform.dispatchDownloadEvent(payload.kind, payload.args);
        }
        if (role === 'incognito' && record.kind === 'probe') return publishControl({ refresh: true });
        if (role === 'incognito' && record.kind === 'download') {
          if (!['search', 'download', 'cancel', 'pause', 'resume', 'show'].includes(payload.name) || !Array.isArray(payload.args)) {
            throw new Error('Unknown private download operation.');
          }
          if (payload.name === 'download') {
            const options = { ...payload.args[0] }; delete options.incognito;
            return api.downloads.download(options);
          }
          if (payload.name === 'search') return (await api.downloads.search(...payload.args)).filter((item) => item.incognito === true);
          const [item] = await api.downloads.search({ id: payload.args[0] });
          if (!item?.incognito) throw new Error('This private download no longer exists.');
          return api.downloads[payload.name](...payload.args);
        }
        throw new Error('Unknown session message.');
      });
      await respond(id, result, null, record);
    } catch (error) { await respond(id, null, error, record).catch(log); }
    finally { processing.delete(id); }
  }

  async function drain() {
    const all = await api.storage.session.get(null);
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith(RESPONSE)) settle(key.slice(RESPONSE.length), value);
      else if (key.startsWith(REQUEST)) void processRequest(key.slice(REQUEST.length), value).catch(log);
    }
  }

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;
    if (role === 'normal' && changes[CONTROL]) void queueLifecycle(changes[CONTROL].newValue).catch(log);
    for (const [key, change] of Object.entries(changes)) {
      if (!change.newValue) continue;
      if (key.startsWith(RESPONSE)) settle(key.slice(RESPONSE.length), change.newValue);
      else if (key.startsWith(REQUEST) && change.newValue.status === 'queued') {
        void processRequest(key.slice(REQUEST.length), change.newValue).catch(log);
      }
    }
  });

  async function relayEvent(kind, args) {
    await initialization;
    return rpc('normal', 'event', { kind, args }, 60000);
  }

  if (role === 'incognito') {
    api.runtime.onMessage.addListener((message, sender) => {
      if (sender.id !== api.runtime.id || sender.url?.split('#')[0] !== api.runtime.getURL('app.html') || message?.target) return;
      return platform.runTask(async () => {
        await initialization;
        const tab = sender.tab || await api.tabs.get(message.tabId);
        if (!tab?.incognito || tab.url?.split('#')[0] !== api.runtime.getURL('app.html')) throw new Error('Open the downloader in an incognito window.');
        await publishControl();
        return rpc('normal', 'command', { message, sender: { id: api.runtime.id, url: api.runtime.getURL('app.html'), tab } }, 60000);
      });
    });
    api.action.onClicked.addListener((tab) => {
      void platform.runTask(async () => {
        const url = api.runtime.getURL('app.html');
        const existing = (await api.tabs.query({ windowId: tab.windowId })).find((entry) => entry.url === url);
        if (existing) { await api.tabs.update(existing.id, { active: true }); await api.windows.update(tab.windowId, { focused: true }); }
        else await api.tabs.create({ url, windowId: tab.windowId });
      }).catch(log);
    });
    api.windows.onCreated.addListener((window) => {
      if (!window.incognito) return;
      privateWindows.add(window.id); void initialization.then(() => publishControl({ refresh: true })).catch(log);
    });
    api.windows.onRemoved.addListener((id) => {
      if (!privateWindows.delete(id)) return;
      // Confirm the inventory before declaring that the last window closed.
      // If OTR teardown stops this worker first, the normal watchdog follows.
      if (epoch) void publishControl({ refresh: true }).catch(log);
    });
    api.downloads.onCreated.addListener((item) => {
      if (!item.incognito) return;
      knownPrivateIds.add(item.id);
      void platform.runTask(async () => {
        await initialization;
        if (item.byExtensionId === api.runtime.id) {
          const all = await api.storage.session.get(null);
          const matches = [];
          for (const [key, record] of Object.entries(all)) {
            if (!key.startsWith(REQUEST) || record.to !== 'incognito' || record.kind !== 'download' || record.epoch !== epoch || record.status !== 'started') continue;
            const payload = await decode(record.data);
            if (payload.name === 'download' && payload.args[0]?.url === item.url && !all[responseKey(key.slice(REQUEST.length))]) matches.push({ id: key.slice(REQUEST.length), record });
          }
          if (matches.length === 1) await respond(matches[0].id, item.id, null, matches[0].record);
        }
        await relayEvent('created', [item]);
      }).catch(log);
    });
    api.downloads.onChanged.addListener((delta) => {
      void platform.runTask(async () => {
        const [item] = await api.downloads.search({ id: delta.id });
        if (!item?.incognito) return;
        knownPrivateIds.add(delta.id);
        await relayEvent('changed', [delta]);
      }).catch(log);
    });
    api.downloads.onErased.addListener((id) => {
      if (knownPrivateIds.delete(id)) void relayEvent('erased', [id]).catch(log);
    });
  }

  async function collectNow() {
    if (role !== 'normal') return;
    const all = await api.storage.session.get(null);
    const next = all[CONTROL];
    if (next && !next.closing && next.windowIds?.length && Date.now() - next.lastSeen > 30000) {
      try {
        await rpc('incognito', 'probe', {}, 15000);
        await api.storage.session.remove(PROBE);
      } catch {
        const current = await api.storage.session.get([CONTROL, PROBE]);
        const latest = current[CONTROL];
        // A late failed probe must not override a worker that just answered
        // another request or a newly opened private session.
        if (latest && !latest.closing && latest.epoch === next.epoch && latest.lastSeen === next.lastSeen) {
          const previous = current[PROBE];
          const count = previous?.epoch === next.epoch && previous.lastSeen === next.lastSeen ? previous.count + 1 : 1;
          if (count < 2) await api.storage.session.set({ [PROBE]: { epoch: next.epoch, lastSeen: next.lastSeen, count } });
          else {
            await api.storage.session.set({ [CONTROL]: { ...latest, windowIds: [], closing: true } });
            await queueLifecycle();
            await api.storage.session.remove(PROBE);
          }
        }
      }
    }
    const stale = Object.entries(all).filter(([key, value]) =>
      (key.startsWith(RESPONSE) && Date.now() - value.at > 300000) ||
      (key.startsWith(REQUEST) && value.deadline && value.deadline < Date.now()));
    if (stale.length) await api.storage.session.remove(stale.flatMap(([key]) => key.startsWith(RESPONSE)
      ? [key, requestKey(key.slice(RESPONSE.length))] : [key, responseKey(key.slice(REQUEST.length))]));
  }

  function collect() {
    if (!collecting) collecting = collectNow().finally(() => { collecting = null; });
    return collecting;
  }

  function start() {
    if (initialization) return initialization;
    initialization = (async () => {
      if (role === 'incognito') {
        epoch = await privateEpoch();
        const windows = await api.windows.getAll();
        for (const window of windows) if (window.incognito) privateWindows.add(window.id);
        for (const item of await api.downloads.search({})) if (item.incognito) knownPrivateIds.add(item.id);
        if (privateWindows.size) await publishControl();
      } else {
        const data = await api.storage.session.get(CONTROL);
        // Do not await serialized background cleanup here: loadAll also asks
        // for private status and must finish before that cleanup can run.
        void queueLifecycle(data[CONTROL]).catch(log);
      }
    })();
    initialization.then(drain).catch(log);
    return initialization;
  }

  platform.onAlarmWake(() => { void collect().then(drain).catch(log); });
  globalThis.VideoDownloaderBridge = {
    start, downloadOp, privateSessionOpen,
    onPrivateSessionEnd(handler) { endHandlers.push(handler); },
  };
})();
