const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, find, start, tick, clone, qualityFixture } = require('./backend-helpers.cjs');

test('failed settings save preserves the identity of an in-flight lookup', async () => {
  let release;
  const h = harness({ fetchPage: async (url) => new Promise((resolve) => {
    release = () => resolve({ ok: true, url, text: async () => qualityFixture('Held lookup', ['/dload/held/1080/a.mp4']) });
  }) });
  await h.command({ type: 'find', input: 'https://www.eporner.com/video-held/' });
  await tick();
  const originalSet = h.browser.storage.local.set;
  h.browser.storage.local.set = async () => { throw new Error('Storage fault'); };
  assert.equal((await h.command({ type: 'settings', saveAs: true })).ok, false);
  h.browser.storage.local.set = originalSet;
  release();
  const state = await h.until((s) => s.items[0].state === 'ready');
  assert.equal(state.items[0].title, 'Held lookup');
  assert.equal(h.requests.length, 1, 'rollback must not restart an unrelated lookup');
});

test('failed settings save does not orphan a download awaiting its ID', async () => {
  let release;
  const h = harness({ created: false, downloadHook: () => new Promise((resolve) => { release = resolve; }) });
  const initial = await find(h);
  await start(h, initial, true);
  await h.until(() => h.options.length === 1);
  const originalSet = h.browser.storage.local.set;
  h.browser.storage.local.set = async () => { throw new Error('Storage fault'); };
  assert.equal((await h.command({ type: 'settings', saveAs: false })).ok, false);
  h.browser.storage.local.set = originalSet;
  release();
  const active = await h.until((s) => Number.isInteger(s.items[0].downloadId));
  assert.equal(active.items[0].state, 'downloading');
  assert.equal(h.records.get(active.items[0].downloadId).state, 'in_progress');
  assert.equal(h.options.length, 1);
});

test('storage recovery reapplies the newer draft and preserves completed history', async () => {
  const seed = harness();
  const state = await find(seed);
  await start(seed, state);
  await seed.until((s) => Number.isInteger(s.items[0].downloadId));
  seed.records.get(1).state = 'complete';
  await seed.command({ type: 'input', input: 'Newer separately saved draft' });
  const storage = clone(seed.storage);
  let fail = true;
  const recovered = harness({ storage, records: seed.records, getHook: async (area, key) => {
    if (area === 'local' && key === 'downloaderState' && fail) { fail = false; throw new Error('Transient read failure'); }
  } });
  const restored = await recovered.state();
  assert.equal(restored.input, 'Newer separately saved draft');
  assert.equal(restored.items[0].state, 'done');
  assert.equal(restored.items[0].history.length, 1);
  assert.equal(recovered.options.length, 0);
});

test('a temporarily unreadable list never exposes an editable empty snapshot', async () => {
  const h = harness({ failGets: 100 });
  const result = await h.command({ type: 'get-state' });
  assert.equal(result.ok, false);
  assert.match(result.error, /storage read/i);
  assert.equal(h.storageWrites.length, 0);
});

test('late storage recovery restarts persisted pre-launch work once', async () => {
  const seed = harness();
  const ready = await find(seed);
  const storage = clone(seed.storage);
  Object.assign(storage.downloaderState.items[0], { state: 'downloading', startedAt: null, saveAs: false });
  let fail = true;
  const h = harness({ storage, getHook: async (area, key) => {
    if (area === 'local' && key === 'downloaderState' && fail) { fail = false; throw new Error('Transient read failure'); }
  } });
  await h.state();
  const running = await h.until((s) => Number.isInteger(s.items[0].downloadId));
  assert.equal(running.items[0].state, 'downloading');
  assert.equal(h.options.length, 1);
  assert.equal(running.items[0].pageUrl, ready.items[0].pageUrl);
});

test('cancelling discovery while permission lookup is pending prevents the fetch', async () => {
  let allow;
  const h = harness({ permissionsContains: () => new Promise((resolve) => { allow = resolve; }) });
  const added = await h.command({ type: 'find', input: 'https://www.eporner.com/video-pending/' });
  await tick();
  await h.command({ type: 'bulk-cancel', batchId: added.state.batchId, ids: [added.state.items[0].id] });
  allow(true);
  await tick(); await tick();
  assert.equal(h.requests.length, 0);
  assert.equal((await h.state()).items[0].state, 'cancelled');
});

test('uncertain started work without a matching download requires explicit retry', async () => {
  const seed = harness(); await find(seed);
  const storage = clone(seed.storage);
  Object.assign(storage.downloaderState.items[0], { state: 'downloading', startedAt: Date.now() });
  const h = harness({ storage });
  const originalSearch = h.browser.downloads.search;
  let fail = true;
  h.browser.downloads.search = async (query) => {
    if (fail) { fail = false; throw new Error('Transient search failure'); }
    return originalSearch(query);
  };
  const state = await h.state();
  assert.equal(state.items[0].state, 'failed');
  assert.equal(h.options.length, 0);
});
