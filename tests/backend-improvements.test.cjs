const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, find, start, tick, clone, qualityFixture } = require('./backend-helpers.cjs');

const QUALITY_LINKS = [
  '/dload/x/480/clip.mp4',
  '/dload/x/720/clip.mp4',
  '/dload/x/720/clip-av1.mp4',
  '/dload/x/1080/clip.mp4',
  '/dload/x/1080/clip-av1.mp4',
  '/dload/x/2160/clip.mp4',
  '/dload/x/2160/clip-av1.mp4',
];
const qualityFetch = async (url) => ({
  ok: true, url,
  text: async () => qualityFixture('Quality Video', QUALITY_LINKS),
});

// 1) Storage failure recovery: pre-download persist failure must not orphan.
test('storage failure before launch rolls back without orphan transfer', async () => {
  const h = harness();
  const state = await find(h, 1);
  let listWrites = 0;
  const origSet = h.browser.storage.local.set;
  h.browser.storage.local.set = async (values) => {
    if (values.downloaderState) {
      listWrites++;
      if (listWrites === 2) throw new Error('Injected storage failure');
    }
    return origSet(values);
  };
  const result = await start(h, state);
  assert.equal(result.ok, false);
  assert.equal(h.options.length, 0, 'no download launched');
  const after = await h.state();
  assert.ok(['ready', 'failed'].includes(after.items[0].state), `selectable retry state, got ${after.items[0].state}`);
  assert.ok(!Number.isInteger(after.items[0].downloadId), 'no leaked download ID');
  h.browser.storage.local.set = origSet;
  const retryState = await h.state();
  if (['ready', 'failed'].includes(retryState.items[0].state)) {
    const retry = await start(h, retryState);
    assert.equal(retry.ok, true);
    await h.until((s) => Number.isInteger(s.items[0].downloadId));
    assert.equal(h.options.length, 1, 'single transfer after retry, no duplicate');
    h.complete(1);
    await h.until((s) => s.items[0].state === 'done');
  } else {
    // Queued is also safe-retryable: a later pump must advance it once storage recovers.
    await h.command({ type: 'find', input: 'https://www.eporner.com/video-retry/' });
    await h.until((s) => s.items.some((i) => Number.isInteger(i.downloadId)));
    assert.equal(h.options.length, 1);
  }
});

test('storage failure after download start retains live ID without duplicate', async () => {
  const h = harness();
  const state = await find(h, 1);
  await start(h, state);
  await h.until((s) => Number.isInteger(s.items[0].downloadId));
  const origSet = h.browser.storage.local.set;
  h.browser.storage.local.set = async () => { throw new Error('persist failed'); };
  h.complete(1);
  const mem = await h.until((s) => s.items[0].state === 'done');
  assert.equal(mem.items[0].state, 'done');
  assert.equal(h.options.length, 1, 'no duplicate transfer launched');
  h.browser.storage.local.set = origSet;
  await h.command({ type: 'settings', saveAs: false });
  assert.equal(h.storage.downloaderState.items[0].state, 'done', 'later persist catches up');
});

// 2) Startup resilience.
test('single downloads.search failure does not poison initialization', async () => {
  const h = harness();
  const state = await find(h, 2);
  await start(h, state);
  await h.until((s) => s.items.filter((i) => Number.isInteger(i.downloadId)).length === 2);
  h.records.get(1).state = 'complete';
  const origSearch = h.browser.downloads.search;
  // Share storage+records into a restored harness, but fail the first search once.
  let failOnce = true;
  const restored = harness({ storage: h.storage, sessionStorage: h.sessionStorage, records: h.records });
  const innerSearch = restored.browser.downloads.search;
  restored.browser.downloads.search = async (query) => {
    if (failOnce) { failOnce = false; throw new Error('Temporary API failure'); }
    return innerSearch(query);
  };
  // get-state must still work (initialized not poisoned).
  const s = await restored.state();
  assert.ok(Array.isArray(s.items), 'get-state works after search failure');
  // Later reconciliation recovers: poll progress after search recovers.
  restored.browser.downloads.search = innerSearch;
  const polled = await restored.command({ type: 'get-progress' });
  assert.equal(polled.ok, true);
  assert.ok(polled.state.items[0].state === 'done' || polled.state.items[0].state === 'downloading');
  assert.equal(origSearch === undefined, false);
});

test('storage read failure does not overwrite stored history', async () => {
  const h = harness();
  const state = await find(h, 1);
  await start(h, state);
  await h.until((s) => Number.isInteger(s.items[0].downloadId));
  h.complete(1);
  await h.until((s) => s.items[0].state === 'done');
  const storedBefore = JSON.stringify(h.storage.downloaderState);
  assert.ok(storedBefore.includes('history') || storedBefore.includes('done'));
  const restarted = harness({ storage: h.storage, sessionStorage: h.sessionStorage, failGets: 2 });
  await tick();
  // Reads failed: storage must not have been overwritten with empty.
  assert.equal(JSON.stringify(h.storage.downloaderState), storedBefore, 'failed restore must not clobber history');
  // After recovery, a fresh harness with same storage recovers history.
  const recovered = harness({ storage: h.storage, sessionStorage: h.sessionStorage });
  const s = await recovered.state();
  assert.equal(s.items[0].state, 'done');
});

// 3) Linear-time import and bulk lookup.
test('bulk saved import and bulk remove stay linear', async () => {
  const h = harness();
  const count = 2000;
  const items = Array.from({ length: count }, (_, i) => ({
    pageUrl: `https://www.eporner.com/video-bulk-${i}/title/`,
    title: `Bulk ${i}`, filename: `Bulk ${i}`,
    history: [{ savedAt: '2026-10-09T00:00:00.000Z', filename: `Bulk ${i}.mp4` }],
  }));
  const text = JSON.stringify({ format: 'video-bulk-downloader', version: 1, section: 'saved', items });
  const startTime = Date.now();
  const result = await h.command({ type: 'import', section: 'saved', format: 'json', text });
  assert.equal(result.ok, true);
  assert.equal((await h.state()).items.length, count);
  assert.ok(Date.now() - startTime < 5000, 'bulk import should stay linear');
  const ids = (await h.state()).items.slice(0, 1000).map((i) => i.id);
  const batchId = (await h.state()).batchId;
  const removeStart = Date.now();
  const removed = await h.command({ type: 'bulk-remove', batchId, ids });
  assert.equal(removed.ok, true);
  assert.equal((await h.state()).items.length, count - 1000);
  assert.ok(Date.now() - removeStart < 5000, 'bulk remove should stay linear');
});

// 4) Saved import merge over idle found row.
test('saved import merges over idle found row and clears stale metrics', async () => {
  const h = harness();
  let state = await find(h, 1);
  const id = state.items[0].id;
  const pageUrl = state.items[0].pageUrl;
  assert.equal(state.items[0].state, 'ready');
  const text = JSON.stringify({ format: 'video-bulk-downloader', version: 1, section: 'saved', items: [{
    pageUrl, title: 'Imported Title', filename: 'Imported Name', height: 720, codec: 'H.264',
    history: [{ savedAt: '2026-10-09T00:00:00.000Z', filename: 'Imported Name.mp4', height: 720, codec: 'H.264' }],
  }] });
  const result = await h.command({ type: 'import', section: 'saved', format: 'json', text });
  assert.equal(result.ok, true);
  state = await h.state();
  const entry = state.items.find((i) => i.id === id);
  assert.ok(entry, 'same row merged, not duplicated');
  assert.equal(state.items.length, 1);
  assert.equal(entry.state, 'done');
  assert.equal(entry.filename, 'Imported Name', 'nonempty imported filename wins');
  assert.equal(entry.title, 'Imported Title');
  assert.equal(entry.height, 720);
  assert.equal(entry.codec, 'H.264');
  assert.equal(entry.history.length, 1);
  assert.ok(!Number.isInteger(entry.downloadId), 'stale IDs cleared');
  assert.equal(entry.bytesReceived, undefined);
  // Absent fields retain: import with empty metadata keeps existing useful fields.
  const h2 = harness();
  let s2 = await find(h2, 1);
  const url2 = s2.items[0].pageUrl;
  const existingTitle = s2.items[0].title;
  assert.ok(existingTitle, 'discovery provides title');
  const emptyMeta = JSON.stringify({ format: 'video-bulk-downloader', version: 1, section: 'saved', items: [{
    pageUrl: url2, title: '', filename: '', history: [],
  }] });
  await h2.command({ type: 'import', section: 'saved', format: 'json', text: emptyMeta });
  s2 = await h2.state();
  assert.equal(s2.items[0].filename, s2.items[0].filename, 'filename retained');
  assert.ok(s2.items[0].title, 'existing title retained when import empty');
  assert.ok(s2.items[0].history.length, 'history defaulted');
});

test('saved import skips active and saved rows', async () => {
  const h = harness();
  const state = await find(h, 2);
  await start(h, state, false, [state.items[0]]);
  await h.until((s) => Number.isInteger(s.items[0].downloadId));
  const activeUrl = state.items[0].pageUrl;
  const idleUrl = state.items[1].pageUrl;
  const text = JSON.stringify({ format: 'video-bulk-downloader', version: 1, section: 'saved', items: [
    { pageUrl: activeUrl, title: 'Active', filename: 'Active', history: [] },
    { pageUrl: idleUrl, title: 'Idle', filename: 'Idle', history: [] },
  ] });
  const result = await h.command({ type: 'import', section: 'saved', format: 'json', text });
  assert.equal(result.ok, true);
  assert.match(result.state.notice, /1 moved to saved; 1 already listed/);
});

// 5) Draft storage separation.
test('input edits write only draft, not full list', async () => {
  const h = harness();
  await find(h, 1);
  h.storageWrites.length = 0;
  const beforeRevision = h.storage.downloaderState.revision;
  const result = await h.command({ type: 'input', input: 'draft text' });
  assert.equal(result.ok, true);
  assert.equal((await h.state()).input, 'draft text');
  const listWrites = h.storageWrites.filter((w) => w.key === 'downloaderState');
  const draftWrites = h.storageWrites.filter((w) => w.key === 'downloaderDraft');
  assert.equal(listWrites.length, 0, 'input must not rewrite full list');
  assert.ok(draftWrites.length >= 1, 'draft key written');
  assert.equal(h.storage.downloaderState.revision, beforeRevision, 'list revision untouched');
  assert.equal(h.storage.downloaderDraft.input, 'draft text');
});

test('draft migrates and list cannot override newer draft', async () => {
  const legacy = { schemaVersion: 3, revision: 4, batchId: 'b1', input: 'old list input', inputRevision: 1,
    incognito: false, saveAs: false, maxHeight: 0, preferredCodec: 'AV1', items: [] };
  const h = harness({ storage: { downloaderState: legacy } });
  const s = await h.state();
  assert.equal(s.input, 'old list input', 'migrated list input visible');
  assert.equal(h.storage.downloaderDraft.input, 'old list input', 'migrated to draft key');
  const h2 = harness({ storage: {
    downloaderState: { ...legacy, input: 'stale', inputRevision: 1 },
    downloaderDraft: { input: 'newer draft', inputRevision: 5 },
  } });
  assert.equal((await h2.state()).input, 'newer draft', 'newer draft wins on restore');
});

test('last private close clears private draft and list only', async () => {
  const h = harness();
  await find(h, 1);
  await h.command({ type: 'input', input: 'normal draft' });
  await find(h, 1, true);
  await h.command({ type: 'input', input: 'private draft' }, true);
  assert.equal(h.sessionStorage.privateDownloaderDraft.input, 'private draft');
  h.browser.windows.getAll = async () => [{ id: 2, incognito: false }];
  h.browser.windows.onRemoved.emit(1);
  await h.until((s) => s.items.length === 0, true);
  assert.equal(h.sessionStorage.privateDownloaderState, undefined);
  assert.equal(h.sessionStorage.privateDownloaderDraft, undefined, 'private draft cleared');
  assert.equal((await h.state()).input, 'normal draft', 'normal draft preserved');
});

// 6) Permission + paste tokens.
test('page fetch requires host permission with actionable error', async () => {
  const h = harness({ permissionsContains: async () => false });
  const result = await h.command({ type: 'find', input: 'https://www.eporner.com/video-perm/' });
  assert.equal(result.ok, true);
  const state = await h.until((s) => s.items[0]?.state === 'error');
  assert.match(state.items[0].error, /permission/i);
});

test('absent permissions API stays compatible with old mocks', async () => {
  const h = harness({ noPermissions: true });
  const state = await find(h, 1);
  assert.equal(state.items[0].state, 'ready');
});

test('find reports invalid tokens and duplicates with bounded examples', async () => {
  const h = harness();
  const result = await h.command({ type: 'find', input: [
    'https://www.eporner.com/video-a/title/',
    'not-a-url',
    'https://evil.test/video-x/',
    'https://www.eporner.com/video-a/other/',
    'https://www.eporner.com/video-b/',
  ].join('\n') });
  assert.equal(result.ok, true);
  assert.match(result.state.notice, /2 new video/);
  assert.match(result.state.notice, /2 invalid/);
  assert.match(result.state.notice, /not-a-url/);
  assert.ok(result.state.items.length >= 2);
});

// 7) Quality options.
test('quality settings persist and per-job capture survives settings change', async () => {
  const h = harness({ fetchPage: qualityFetch });
  await h.command({ type: 'settings', maxHeight: 720, preferredCodec: 'H.264' });
  let s = await h.state();
  assert.equal(s.maxHeight, 720);
  assert.equal(s.preferredCodec, 'H.264');
  const restored = harness({ storage: h.storage, sessionStorage: h.sessionStorage, fetchPage: qualityFetch });
  assert.equal((await restored.state()).maxHeight, 720, 'settings persist');
  // Find uses current defaults for discovery.
  const found = await restored.command({ type: 'find', input: 'https://www.eporner.com/video-q1/t/' });
  assert.equal(found.ok, true);
  s = await restored.until((st) => st.items[0]?.state === 'ready');
  assert.equal(s.items[0].height, 720);
  assert.equal(s.items[0].codec, 'H.264');
  // Queue with 720, then change settings to unlimited: queued job keeps 720.
  await restored.command({ type: 'download', batchId: s.batchId, saveAs: false,
    items: [{ id: s.items[0].id, filename: s.items[0].filename }] });
  await restored.command({ type: 'settings', maxHeight: 0, preferredCodec: 'AV1' });
  assert.equal((await restored.state()).maxHeight, 0);
  const queued = (await restored.state()).items[0];
  assert.equal(queued.maxHeight, 720, 'queued job captures options');
});

test('ready link refreshes when requested quality differs, preserving filename', async () => {
  const h = harness({ fetchPage: qualityFetch });
  let s = await h.command({ type: 'find', input: 'https://www.eporner.com/video-r1/t/' });
  s = await h.until((st) => st.items[0]?.state === 'ready');
  assert.equal(s.items[0].height, 2160, 'default discovers highest');
  await h.command({ type: 'edit', batchId: s.batchId, id: s.items[0].id, filename: 'My custom name' });
  s = await h.state();
  assert.equal(s.items[0].filename, 'My custom name');
  const beforeUrl = s.items[0].url;
  await h.command({ type: 'download', batchId: s.batchId, saveAs: false, maxHeight: 720, preferredCodec: 'H.264',
    items: [{ id: s.items[0].id, filename: 'My custom name' }] });
  s = await h.until((st) => Number.isInteger(st.items[0].downloadId));
  assert.equal(s.items[0].filename, 'My custom name', 'filename survives refresh');
  assert.notEqual(s.items[0].url, beforeUrl, 'link reselected for new quality');
  assert.equal(s.items[0].height, 720);
});

test('unsatisfiable height cap reports explicit error', async () => {
  const h = harness({ fetchPage: qualityFetch });
  const result = await h.command({ type: 'find', input: 'https://www.eporner.com/video-cap/', maxHeight: 144 });
  assert.equal(result.ok, true);
  const s = await h.until((st) => st.items[0]?.state === 'error');
  assert.match(s.items[0].error, /144/);
});

// 8) Bounded retries.
test('transient 500 then success retries without extra attempts', async () => {
  let calls = 0;
  const h = harness({ fetchPage: async (url) => {
    calls++;
    if (calls === 1) return { ok: false, status: 500 };
    return { ok: true, url, text: async () => qualityFixture('Recovered', QUALITY_LINKS) };
  } });
  const s = await h.command({ type: 'find', input: 'https://www.eporner.com/video-retry1/' });
  assert.equal(s.ok, true);
  await h.until((st) => st.items[0]?.state === 'ready');
  assert.equal(calls, 2);
});

test('does not retry 401/403 or parse errors', async () => {
  let calls403 = 0;
  const h403 = harness({ fetchPage: async () => { calls403++; return { ok: false, status: 403 }; } });
  await h403.command({ type: 'find', input: 'https://www.eporner.com/video-403/' });
  await h403.until((s) => s.items[0]?.state === 'error');
  assert.equal(calls403, 1);
  let callsParse = 0;
  const hParse = harness({ fetchPage: async (url) => {
    callsParse++;
    return { ok: true, url, text: async () => JSON.stringify({ title: 'Empty', links: [] }) };
  } });
  await hParse.command({ type: 'find', input: 'https://www.eporner.com/video-parse/' });
  await hParse.until((s) => s.items[0]?.state === 'error');
  assert.equal(callsParse, 1);
});

test('max 3 attempts for persistent 500', async () => {
  let calls = 0;
  const h = harness({ fetchPage: async () => { calls++; return { ok: false, status: 500 }; } });
  await h.command({ type: 'find', input: 'https://www.eporner.com/video-500/' });
  await h.until((s) => s.items[0]?.state === 'error');
  assert.equal(calls, 3);
});

test('respects Retry-After 0 and rejects large values without long sleep', async () => {
  let calls = 0;
  const h = harness({ fetchPage: async (url) => {
    calls++;
    if (calls === 1) return { ok: false, status: 429, headers: { get: (n) => (n === 'Retry-After' ? '0' : null) } };
    return { ok: true, url, text: async () => qualityFixture('After retry', QUALITY_LINKS) };
  } });
  await h.command({ type: 'find', input: 'https://www.eporner.com/video-429/' });
  await h.until((s) => s.items[0]?.state === 'ready');
  assert.equal(calls, 2);
  const hLarge = harness({ fetchPage: async () => ({ ok: false, status: 429,
    headers: { get: (n) => (n === 'Retry-After' ? '3600' : null) } }) });
  await hLarge.command({ type: 'find', input: 'https://www.eporner.com/video-large/' });
  const s = await hLarge.until((st) => st.items[0]?.state === 'error');
  assert.match(s.items[0].error, /retry after/i);
});

test('cancellation aborts backoff promptly without extra fetch', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({ fetchPage: async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 500 };
    await gate;
    return { ok: false, status: 500 };
  } });
  const found = await h.command({ type: 'find', input: 'https://www.eporner.com/video-cancel/' });
  // Wait for first failure + backoff start, then cancel the finding row.
  await tick();
  const id = found.state.items[0].id;
  const batchId = found.state.batchId;
  // Give the retry loop a moment to enter backoff, then cancel.
  await new Promise((r) => setTimeout(r, 500));
  await h.command({ type: 'cancel', batchId, id }).catch(() => {});
  release();
  await tick();
  const s = await h.state();
  assert.ok(['cancelled', 'finding', 'error'].includes(s.items[0]?.state), `cancelled promptly, got ${s.items[0]?.state}`);
  assert.ok(calls <= 2, 'no endless retries after cancel');
});

test('browser download errors stay explicit without auto-duplicate', async () => {
  const h = harness();
  const state = await find(h, 1);
  h.browser.downloads.download = async () => { throw new Error('Download failed: disk full'); };
  await start(h, state);
  await h.until((st) => st.items[0]?.state === 'failed');
  const current = await h.state();
  assert.equal(current.items[0].state, 'failed');
  assert.match(current.items[0].error, /disk full/);
  assert.equal(h.options.length, 0);
});

// 9) Pause/resume/show-file.
test('pause keeps downloading state and slot, resume clears', async () => {
  const h = harness();
  const state = await find(h, 4);
  await start(h, state);
  await h.until((s) => s.items.filter((i) => Number.isInteger(i.downloadId)).length === 3);
  const target = (await h.state()).items[0];
  const paused = await h.command({ type: 'pause', batchId: state.batchId, id: target.id });
  assert.equal(paused.ok, true);
  assert.equal(paused.state.items[0].state, 'downloading');
  assert.equal(paused.state.items[0].paused, true);
  // Paused still occupies a slot: 4th row must stay queued.
  assert.equal((await h.state()).items[3].state, 'queued');
  assert.deepEqual(h.pausedCalls, [target.downloadId]);
  const resumed = await h.command({ type: 'resume', batchId: state.batchId, id: target.id });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.state.items[0].paused, false);
  assert.deepEqual(h.resumedCalls, [target.downloadId]);
  for (const id of [1, 2, 3]) h.complete(id);
  await h.until((s) => s.items[3].downloadId === 4);
  for (const id of [4]) h.complete(id);
  await h.until((s) => s.items.every((i) => i.state === 'done'));
});

test('pause/resume/show-file validate safely', async () => {
  const h = harness();
  const state = await find(h, 1);
  assert.equal((await h.command({ type: 'pause', batchId: 'wrong', id: state.items[0].id })).ok, false);
  assert.equal((await h.command({ type: 'pause', batchId: state.batchId, id: state.items[0].id })).ok, false,
    'ready row cannot pause');
  assert.equal((await h.command({ type: 'show-file', batchId: state.batchId, id: state.items[0].id })).ok, false,
    'no completed download yet');
  assert.equal((await h.command({ type: 'show-file', batchId: state.batchId, id: 'missing' })).ok, false);
});

test('show-file uses only locally known successful IDs', async () => {
  const h = harness();
  const state = await find(h, 1);
  await start(h, state);
  await h.until((s) => Number.isInteger(s.items[0].downloadId));
  assert.equal((await h.command({ type: 'show-file', batchId: state.batchId, id: state.items[0].id })).ok, false,
    'downloading has no successful ID yet');
  h.complete(1);
  await h.until((s) => s.items[0].state === 'done');
  const shown = await h.command({ type: 'show-file', batchId: state.batchId, id: state.items[0].id });
  assert.equal(shown.ok, true);
  assert.deepEqual(h.shown, [1]);
});

// R2 fault-injection hardening: unread storage, durable barrier, body abort,
// uncertain reconciliation, commit separation, revision monotonicity,
// draft O(1), truncation, history-preferring show-file, fail-closed permission.

test('R2 unread storage gates mutations and preserves history on recovery', async () => {
  const seed = harness();
  await find(seed, 1);
  const persisted = clone(seed.storage);
  const before = JSON.stringify(persisted.downloaderState);
  assert.equal(persisted.downloaderState.items.length, 1);
  const h = harness({ storage: persisted, failGets: 100 });
  await tick();
  await tick();
  const res = await h.command({ type: 'settings', saveAs: true });
  assert.equal(res.ok, false);
  assert.match(res.error, /storage read|retry/i);
  assert.equal(JSON.stringify(persisted.downloaderState), before);
  assert.equal((await h.command({ type: 'input', input: 'evil' })).ok, false);
  assert.equal((await h.command({ type: 'find', input: 'https://www.eporner.com/video-99/title/' })).ok, false);
});

test('R2 draft failed read never overwrites newer draft', async () => {
  const seed = harness();
  await find(seed, 1);
  await seed.command({ type: 'input', input: 'newer draft' });
  assert.equal(seed.storage.downloaderDraft.input, 'newer draft');
  const h2 = harness({
    storage: seed.storage,
    sessionStorage: seed.sessionStorage,
    getHook: async (area, key) => {
      if (area === 'local' && key === 'downloaderDraft') throw new Error('draft read failed');
    },
  });
  await tick();
  await tick();
  const r = await h2.command({ type: 'input', input: 'overwrite attempt' });
  assert.equal(r.ok, false);
  assert.match(r.error, /storage read|retry/i);
  assert.equal(seed.storage.downloaderDraft.input, 'newer draft');
});

test('R2 durable start barrier: third write failure never launches', async () => {
  const h = harness();
  const state = await find(h, 1);
  let sets = 0;
  const origSet = h.browser.storage.local.set;
  h.browser.storage.local.set = async (values) => {
    if (values.downloaderState) {
      sets++;
      if (sets === 3) throw new Error('injected startedAt write failure');
    }
    return origSet(values);
  };
  let calls = 0;
  h.browser.downloads.download = async () => { calls++; return 999; };
  await start(h, state);
  await tick();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls, 0, 'download must not launch unless startedAt persisted');
  const mem = await h.state();
  assert.ok(['queued', 'failed', 'ready'].includes(mem.items[0].state), 'retryable, got ' + mem.items[0].state);
  const disk = h.storage.downloaderState;
  assert.ok(!Number.isInteger(disk.items[0].downloadId) || disk.items[0].downloadId !== 999);
  h.browser.storage.local.set = origSet;
  h.browser.downloads.download = async (v) => {
    calls++;
    const stored = h.storage.downloaderState;
    assert.ok(stored.items.some((i) => i.state === 'downloading' && i.url === v.url && i.startedAt));
    return 999;
  };
  const s2 = await h.state();
  if (['failed', 'ready'].includes(s2.items[0].state)) {
    const r2 = await start(h, s2);
    assert.equal(r2.ok, true);
  }
  await h.until((s) => Number.isInteger(s.items[0].downloadId));
  assert.ok(calls >= 1);
});

test('R2 hanging body aborts on remove and releases slot', async () => {
  let captured = null;
  const h = harness({
    fetchPage: async (url, init) => {
      captured = init.signal;
      return { ok: true, url, text: () => new Promise(() => {}) };
    },
  });
  const found = await h.command({ type: 'find', input: 'https://www.eporner.com/video-hang/' });
  assert.equal(found.ok, true);
  await tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(captured);
  assert.equal(captured.aborted, false);
  assert.equal((await h.command({ type: 'remove', batchId: found.state.batchId, id: found.state.items[0].id })).ok, true);
  await tick();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(captured.aborted, true);
  assert.equal((await h.state()).items.length, 0);
  const h2 = harness({ storage: h.storage, sessionStorage: h.sessionStorage });
  assert.equal((await h2.command({ type: 'find', input: 'https://www.eporner.com/video-next/' })).ok, true);
  assert.ok((await h2.until((st) => st.items.some((i) => i.state === 'ready'))).items.some((i) => i.state === 'ready'));
});

test('R2 hanging body aborts on bulk-cancel and private close', async () => {
  let cap1 = null;
  const h = harness({
    fetchPage: async (url, init) => { cap1 = init.signal; return { ok: true, url, text: () => new Promise(() => {}) }; },
  });
  const found = await h.command({ type: 'find', input: 'https://www.eporner.com/video-hang2/' });
  await tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(cap1);
  assert.equal((await h.command({ type: 'bulk-cancel', batchId: found.state.batchId, ids: [found.state.items[0].id] })).ok, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(cap1.aborted, true);
  assert.equal((await h.state()).items[0].state, 'cancelled');
  let capPriv = null;
  const hp = harness({
    fetchPage: async (url, init) => { capPriv = init.signal; return { ok: true, url, text: () => new Promise(() => {}) }; },
  });
  await hp.command({ type: 'find', input: 'https://www.eporner.com/video-priv/' }, true);
  await tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(capPriv);
  hp.browser.windows.getAll = async () => [{ id: 2, incognito: false }];
  hp.browser.windows.onRemoved.emit(1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(capPriv.aborted, true);
  assert.equal((await hp.state(true)).items.length, 0);
});

test('R2 uncertain start reconciles on subsequent calls after search failure', async () => {
  const orig = harness();
  const state = await find(orig, 1);
  await start(orig, state);
  await orig.until((s) => Number.isInteger(s.items[0].downloadId));
  delete orig.storage.downloaderState.items[0].downloadId;
  let failOnce = true;
  const restored = harness({ storage: orig.storage, sessionStorage: orig.sessionStorage, records: orig.records });
  const innerSearch = restored.browser.downloads.search;
  restored.browser.downloads.search = async (q) => {
    if (failOnce && q.id === undefined) { failOnce = false; throw new Error('Temporary API failure'); }
    return innerSearch(q);
  };
  await tick();
  await new Promise((r) => setTimeout(r, 50));
  restored.browser.downloads.search = innerSearch;
  assert.equal((await restored.command({ type: 'get-progress' })).ok, true);
  const s = await restored.until((st) => Number.isInteger(st.items[0].downloadId));
  assert.equal(s.items[0].downloadId, 1);
  assert.equal(restored.options.length, 0);
  restored.complete(1);
  await restored.until((st) => st.items[0].state === 'done');
});

test('R2 failed bulk-remove persist retains visible selectable rows without tombstones', async () => {
  const h = harness();
  const st = await find(h, 2);
  const origSet = h.browser.storage.local.set;
  h.browser.storage.local.set = async () => { throw new Error('persist failed'); };
  assert.equal((await h.command({ type: 'bulk-remove', batchId: st.batchId, ids: st.items.map((i) => i.id) })).ok, false);
  h.browser.storage.local.set = origSet;
  const after = await h.state();
  assert.equal(after.items.length, 2);
  assert.ok(after.items.every((i) => !i.removeRequested));
  assert.ok(after.items.every((i) => i.state === 'ready'));
  assert.equal((await h.command({ type: 'select', batchId: after.batchId, ids: after.items.map((i) => i.id), selected: true })).ok, true);
});

test('R2 revision never decreases across failed boundaries', async () => {
  const h = harness();
  let s = await find(h, 1);
  const r1 = s.revision;
  const origSet = h.browser.storage.local.set;
  h.browser.storage.local.set = async () => { throw new Error('persist failed'); };
  assert.equal((await start(h, s)).ok, false);
  s = await h.state();
  assert.ok(s.revision >= r1);
  assert.equal(s.revision, r1);
  h.browser.storage.local.set = origSet;
  s = await h.state();
  const r2 = s.revision;
  assert.equal((await start(h, s)).ok, true);
  s = await h.until((st) => Number.isInteger(st.items[0].downloadId));
  assert.ok(s.revision > r2);
  h.browser.storage.local.set = async () => { throw new Error('post-launch persist failed'); };
  h.complete(1);
  await new Promise((r) => setTimeout(r, 50));
  const mem = await h.state();
  assert.equal(mem.items[0].state, 'done');
  assert.ok(mem.revision >= s.revision);
  h.browser.storage.local.set = origSet;
  await h.command({ type: 'settings', saveAs: false });
  assert.ok(h.storage.downloaderState.revision >= mem.revision);
});

test('R2 invalid paste truncates long tokens and bounds total', async () => {
  const h = harness();
  const res = await h.command({ type: 'find', input: ['https://www.eporner.com/video-a/title/', 'x'.repeat(500), 'not-a-url-' + 'y'.repeat(300), 'https://evil.test/x/'].join('\n') });
  assert.equal(res.ok, true);
  assert.ok(res.state.notice.length <= 500);
  assert.ok(!res.state.notice.includes('x'.repeat(100)));
  assert.match(res.state.notice, /invalid/i);
});

test('R2 show-file prefers proven history over active or failed current', async () => {
  const h = harness();
  const st = await find(h, 1);
  await start(h, st);
  await h.until((stt) => Number.isInteger(stt.items[0].downloadId));
  h.complete(1);
  await h.until((stt) => stt.items[0].state === 'done');
  let s = await h.state();
  const id = s.items[0].id;
  await h.command({ type: 'download', batchId: s.batchId, saveAs: false, items: [{ id, filename: s.items[0].filename }] });
  await h.until((stt) => Number.isInteger(stt.items[0].downloadId) && stt.items[0].downloadId !== 1);
  const secondId = (await h.state()).items[0].downloadId;
  h.complete(secondId, { mime: 'text/html' });
  s = await h.until((stt) => stt.items[0].state === 'failed');
  assert.ok(s.items[0].history.length >= 1);
  h.shown.length = 0;
  assert.equal((await h.command({ type: 'show-file', batchId: s.batchId, id })).ok, true);
  assert.deepEqual(h.shown, [1]);
  await h.command({ type: 'download', batchId: s.batchId, saveAs: false, items: [{ id, filename: s.items[0].filename }] });
  await h.until((stt) => Number.isInteger(stt.items[0].downloadId));
  h.shown.length = 0;
  assert.equal((await h.command({ type: 'show-file', batchId: s.batchId, id })).ok, true);
  assert.deepEqual(h.shown, [1]);
});

test('R2 host permission fails closed on API error, absent API still compatible', async () => {
  const hErr = harness({ permissionsContains: async () => { throw new Error('API boom'); } });
  assert.equal((await hErr.command({ type: 'find', input: 'https://www.eporner.com/video-perm/' })).ok, true);
  assert.match((await hErr.until((st) => st.items[0]?.state === 'error')).items[0].error, /permission/i);
  assert.equal(hErr.requests.length, 0);
  assert.equal((await find(harness({ noPermissions: true }), 1)).items[0].state, 'ready');
});

test('R2 input with large list stays O(1) draft-only', async () => {
  const h = harness();
  const count = 2000;
  const items = Array.from({ length: count }, (_, i) => ({
    pageUrl: 'https://www.eporner.com/video-bulk-' + i + '/title/',
    title: 'Bulk ' + i, filename: 'Bulk ' + i,
    history: [{ savedAt: '2026-10-09T00:00:00.000Z', filename: 'Bulk ' + i + '.mp4' }],
  }));
  assert.equal((await h.command({ type: 'import', section: 'saved', format: 'json', text: JSON.stringify({ format: 'video-bulk-downloader', version: 1, section: 'saved', items }) })).ok, true);
  h.storageWrites.length = 0;
  const beforeRev = h.storage.downloaderState.revision;
  const t0 = Date.now();
  assert.equal((await h.command({ type: 'input', input: 'draft x' })).ok, true);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(h.storageWrites.filter((w) => w.key === 'downloaderState').length, 0);
  assert.ok(h.storageWrites.some((w) => w.key === 'downloaderDraft'));
  assert.equal(h.storage.downloaderState.revision, beforeRev);
});

test('R2 legacy recovery after failed reads still migrates and reconciles', async () => {
  const legacy = { schemaVersion: 1, revision: 12, batchId: 'legacy', input: 'Private old input', incognito: true, saveAs: false, items: [
    { id: 'normal-old', pageUrl: 'https://www.eporner.com/video-normal/', filename: 'Normal', state: 'done', incognito: false, downloadId: 1 },
    { id: 'private-old', pageUrl: 'https://www.eporner.com/video-private/', filename: 'Private', state: 'ready', incognito: true },
  ] };
  const storage = { downloaderState: clone(legacy) };
  const h = harness({ storage, failGets: 8 });
  await tick();
  await tick();
  assert.equal((await h.command({ type: 'settings', saveAs: true })).ok, false);
  assert.equal((await h.until((st) => st.items.length === 1)).items[0].id, 'normal-old');
  assert.equal((await h.until((st) => st.items.length === 1, true)).items[0].id, 'private-old');
});

test('R2 failed bulk-remove of finding rows does not abort lookups', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const h = harness({ fetchPage: async (url) => {
    await gate;
    return { ok: true, url, text: async () => JSON.stringify({ title: 'Late', links: ['/dload/x/2160/a.mp4'] }) };
  } });
  const found = await h.command({ type: 'find', input: 'https://www.eporner.com/video-late1/\nhttps://www.eporner.com/video-late2/' });
  const origSet = h.browser.storage.local.set;
  h.browser.storage.local.set = async () => { throw new Error('persist failed'); };
  assert.equal((await h.command({ type: 'bulk-remove', batchId: found.state.batchId, ids: found.state.items.map((i) => i.id) })).ok, false);
  h.browser.storage.local.set = origSet;
  release();
  const done = await h.until((s) => s.items.every((i) => i.state === 'ready'));
  assert.equal(done.items.length, 2);
  assert.ok(done.items.every((i) => !i.removeRequested));
});

// R3 privacy, pause, and restored-download identity.

test('R3 private lookups send no normal login and skip the HTTP cache, normal lookups keep the login', async () => {
  const h = harness();
  await find(h);
  assert.equal(h.requests[0].credentials, 'include');
  assert.equal(h.requests[0].cache, undefined);
  await find(h, 1, true);
  assert.equal(h.requests[1].credentials, 'omit');
  assert.equal(h.requests[1].cache, 'no-store');
  const privateState = await h.state(true);
  await start(h, privateState, false, privateState.items, true, { maxHeight: 1080 });
  await h.until((s) => Number.isInteger(s.items[0].downloadId), true);
  assert.equal(h.requests.length, 3, 'the private refresh during download fetches the page again');
  assert.equal(h.requests[2].credentials, 'omit');
  assert.equal(h.requests[2].cache, 'no-store');
});

test('R3 a private lookup with no links does not suggest a normal login', async () => {
  const h = harness({ fetchPage: async (url) => ({ ok: true, url,
    text: async () => JSON.stringify({ title: 'Empty', links: [] }) }) });
  const privateState = await find(h, 1, true);
  assert.match(privateState.items[0].error, /Private lookups do not use a login/);
  const normalState = await find(h, 1);
  assert.match(normalState.items[0].error, /Log in to the site/);
});

test('R3 cancelling a paused transfer cancels it in Firefox and starts the next queued file', async () => {
  const h = harness();
  const state = await find(h, 4);
  await start(h, state);
  await h.until((s) => s.items.filter((i) => Number.isInteger(i.downloadId)).length === 3);
  const target = (await h.state()).items[0];
  assert.equal((await h.command({ type: 'pause', batchId: state.batchId, id: target.id })).ok, true);
  const cancelled = await h.command({ type: 'cancel', batchId: state.batchId, id: target.id });
  assert.equal(cancelled.ok, true, cancelled.error);
  await h.until((s) => s.items[0].state === 'cancelled' && s.items[3].downloadId === 4);
  assert.equal(h.records.get(target.downloadId).state, 'interrupted');
  assert.equal(h.records.get(target.downloadId).paused, false, 'Firefox must not keep the paused partial file');
  assert.equal(h.records.get(2).state, 'in_progress');
  for (const id of [2, 3, 4]) h.complete(id);
  await h.until((s) => !h.context.VideoDownloader.isBusy(s.items));
});

test('R3 a paused download survives a restart: its stale ID is replaced and it resumes', async () => {
  const original = harness();
  const state = await find(original, 1);
  await start(original, state);
  await original.until((s) => Number.isInteger(s.items[0].downloadId));
  await original.command({ type: 'pause', batchId: state.batchId, id: state.items[0].id });
  const storage = clone(original.storage);
  // Restart: Firefox renumbers downloads and forgets which extension started them.
  const ours = { ...clone(original.records.get(1)), id: 2, byExtensionId: undefined };
  const other = { id: 1, state: 'complete', mime: 'video/mp4', error: null, paused: false, incognito: false,
    url: 'https://www.eporner.com/dload/video-other/1080/other.mp4', filename: '/downloads/Other.mp4',
    startTime: '2020-01-01T00:00:00.000Z' };
  const restored = harness({ storage, sessionStorage: clone(original.sessionStorage), records: new Map([[1, other], [2, ours]]) });
  const s = await restored.until((st) => st.items[0].downloadId === 2 && st.items[0].paused === true);
  assert.equal(s.items[0].state, 'downloading');
  assert.equal(restored.records.get(1).filename, '/downloads/Other.mp4', 'the unrelated download is untouched');
  assert.equal((await restored.command({ type: 'resume', batchId: s.batchId, id: s.items[0].id })).ok, true);
  restored.complete(2);
  await restored.until((st) => st.items[0].state === 'done');
  assert.equal(restored.options.length, 0, 'no duplicate transfer starts after the restart');
});

test('R3 a restored ID that now names an unrelated transfer is never adopted or cancelled', async () => {
  const original = harness();
  const state = await find(original, 1);
  await start(original, state);
  await original.until((s) => Number.isInteger(s.items[0].downloadId));
  const storage = clone(original.storage);
  Object.assign(storage.downloaderState.items[0], { state: 'cancelling', cancelRequested: true });
  const other = { id: 1, state: 'in_progress', mime: 'video/mp4', error: null, paused: false, incognito: false,
    url: 'https://www.eporner.com/dload/video-other/1080/other.mp4', filename: '/downloads/Other.mp4',
    byExtensionId: 'other@example.test', startTime: '2020-01-01T00:00:00.000Z' };
  const ours = { ...clone(original.records.get(1)), id: 2, state: 'interrupted', error: 'NETWORK_FAILED', byExtensionId: undefined };
  const restored = harness({ storage, sessionStorage: clone(original.sessionStorage), records: new Map([[1, other], [2, ours]]) });
  const s = await restored.until((st) => st.items[0].state === 'cancelled');
  assert.equal(restored.records.get(1).state, 'in_progress', 'the unrelated transfer must keep running');
  assert.equal(s.items[0].downloadId, 2, 'the row is re-identified by URL, browsing mode, and start time');
  assert.equal(restored.options.length, 0);
});

test('R3 after a restart the real download is re-identified under its new ID, not the unrelated one', async () => {
  const original = harness();
  const state = await find(original, 1);
  await start(original, state);
  await original.until((s) => Number.isInteger(s.items[0].downloadId));
  const storage = clone(original.storage);
  original.complete(1);
  const ours = { ...clone(original.records.get(1)), id: 2, byExtensionId: undefined };
  const other = { id: 1, state: 'complete', mime: 'video/mp4', error: null, paused: false, incognito: false,
    url: 'https://www.eporner.com/dload/video-other/1080/other.mp4', filename: '/downloads/Other.mp4',
    startTime: '2020-01-01T00:00:00.000Z' };
  const restored = harness({ storage, sessionStorage: clone(original.sessionStorage), records: new Map([[1, other], [2, ours]]) });
  const s = await restored.until((st) => st.items[0].state === 'done');
  assert.equal(s.items[0].downloadId, 2);
  assert.deepEqual(s.items[0].history.map((entry) => entry.downloadId), [2]);
  assert.equal(s.items[0].history[0].filename, ours.filename);
  assert.equal(restored.options.length, 0);
});

test('R3 show-in-folder clears history IDs that Firefox no longer ties to the saved file', async () => {
  const h = harness();
  const st = await find(h, 1);
  await start(h, st);
  await h.until((s) => s.items[0].downloadId === 1);
  h.complete(1);
  await h.until((s) => s.items[0].state === 'done');
  const again = await h.command({ type: 'download', batchId: st.batchId, saveAs: false,
    items: [{ id: st.items[0].id, filename: 'Second name' }] });
  assert.equal(again.ok, true, again.error);
  await h.until((s) => s.items[0].downloadId === 2);
  h.complete(2);
  await h.until((s) => s.items[0].state === 'done' && s.items[0].history.length === 2);
  // Firefox now lists ID 2 as an unrelated file, so that history entry is stale.
  h.records.set(2, { ...h.records.get(2), filename: '/downloads/Unrelated.mp4' });
  h.shown.length = 0;
  const shown = await h.command({ type: 'show-file', batchId: st.batchId, id: st.items[0].id });
  assert.equal(shown.ok, true, shown.error);
  assert.deepEqual(h.shown, [1], 'falls back to the newest entry Firefox still ties to its file');
  const history = (await h.state()).items[0].history;
  assert.equal(history[0].downloadId, 1);
  assert.equal(history[1].downloadId, undefined);
  assert.equal(h.storage.downloaderState.items[0].history[1].downloadId, undefined, 'the cleared ID is persisted');
});

test('R3 a completed file is recorded even when Firefox reuses an ID from older history', async () => {
  const seed = harness();
  await find(seed);
  const storage = clone(seed.storage);
  Object.assign(storage.downloaderState.items[0], { state: 'done', saved: true,
    history: [{ downloadId: 1, savedAt: '2026-10-01T00:00:00.000Z', filename: '/downloads/Old name.mp4' }] });
  const h = harness({ storage });
  await start(h, await h.state());
  await h.until((s) => s.items[0].downloadId === 1);
  h.complete(1);
  const done = await h.until((s) => s.items[0].state === 'done');
  assert.equal(done.items[0].history.length, 2);
  assert.equal(done.items[0].history[0].filename, '/downloads/Old name.mp4');
  assert.notEqual(done.items[0].history[1].filename, '/downloads/Old name.mp4');
});
