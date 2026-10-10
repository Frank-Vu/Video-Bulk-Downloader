const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, find, start, tick, clone } = require('./backend-helpers.cjs');

const HOUR = 3600 * 1000;

// 1. A reused ID pointing to a manual same-URL download started 24h later must
// neither be adopted nor cancelled, even when the restored row is cancelling.
test('reused ID pointing to a manual same-URL download 24h later is never adopted or cancelled', async () => {
  const original = harness();
  const state = await find(original, 1);
  await start(original, state);
  const running = await original.until((s) => Number.isInteger(s.items[0].downloadId));
  const row = running.items[0];
  assert.ok(row.downloadIdentity && row.downloadIdentity.startTime, 'launch must persist an identity');
  const url = row.url;
  const filename = original.records.get(row.downloadId).filename;
  const originalStart = Date.parse(row.downloadIdentity.startTime);
  const storage = clone(original.storage);
  // The restored row is awaiting cancellation, as in the reported bug.
  Object.assign(storage.downloaderState.items[0], { state: 'cancelling', cancelRequested: true });
  const manualStart = new Date(originalStart + 24 * HOUR).toISOString();
  const manual = {
    id: 1, state: 'in_progress', mime: 'video/mp4', error: null, paused: false,
    incognito: false, url, filename, byExtensionId: undefined, startTime: manualStart,
    endTime: null, bytesReceived: 0, totalBytes: null,
  };
  const restored = harness({
    storage, sessionStorage: clone(original.sessionStorage),
    records: new Map([[1, manual]]),
  });
  const s = await restored.until((st) => st.items[0].state === 'cancelled');
  assert.notEqual(s.items[0].downloadId, 1, 'the manual transfer must not be adopted');
  assert.equal(restored.records.get(1).state, 'in_progress', 'cancelling the row must not cancel the manual transfer');
  assert.equal(restored.records.get(1).url, url);
  assert.equal(restored.options.length, 0, 'no duplicate transfer may launch');
});

// 2. The original transfer receiving a new ID after restart recovers via its
// verified identity, not the unrelated same-URL manual download.
test('original transfer with a new ID after restart recovers via verified identity', async () => {
  const original = harness();
  const state = await find(original, 1);
  await start(original, state);
  const running = await original.until((s) => Number.isInteger(s.items[0].downloadId));
  const row = running.items[0];
  const url = row.url;
  const identityStart = row.downloadIdentity.startTime;
  const filename = original.records.get(row.downloadId).filename;
  const storage = clone(original.storage);
  const ours = {
    ...clone(original.records.get(row.downloadId)),
    id: 2, byExtensionId: undefined,
  };
  assert.equal(ours.startTime, identityStart);
  const manual = {
    id: 1, state: 'in_progress', mime: 'video/mp4', error: null, paused: false,
    incognito: false, url, filename, byExtensionId: undefined,
    startTime: new Date(Date.parse(identityStart) + 24 * HOUR).toISOString(),
    endTime: null, bytesReceived: 0, totalBytes: null,
  };
  const restored = harness({
    storage, sessionStorage: clone(original.sessionStorage),
    records: new Map([[1, manual], [2, ours]]),
  });
  const s = await restored.until((st) => Number.isInteger(st.items[0].downloadId));
  assert.equal(s.items[0].downloadId, 2, 'must adopt the verified original, not the manual same-URL transfer');
  assert.equal(restored.records.get(1).state, 'in_progress', 'manual transfer untouched');
  restored.complete(2);
  await restored.until((st) => st.items[0].state === 'done');
  assert.equal(restored.options.length, 0, 'no duplicate transfer');
});

// 3. Multiple same-URL candidates: no arbitrary match is adopted.
test('multiple same-URL candidates are never adopted arbitrarily', async () => {
  const seed = harness();
  const found = await find(seed, 1);
  const url = found.items[0].url;
  const storage = clone(seed.storage);
  // Simulate a legacy row without identity that is actively downloading.
  Object.assign(storage.downloaderState.items[0], {
    state: 'downloading', startedAt: Date.now(), saveAs: false,
  });
  delete storage.downloaderState.items[0].downloadId;
  delete storage.downloaderState.items[0].downloadIdentity;
  const now = Date.now();
  const a = {
    id: 1, state: 'in_progress', mime: 'video/mp4', error: null, paused: false,
    incognito: false, url, filename: '/downloads/Video Bulk Downloads/A.mp4',
    byExtensionId: undefined, startTime: new Date(now - 5000).toISOString(),
    endTime: null, bytesReceived: 0, totalBytes: null,
  };
  const b = {
    id: 2, state: 'in_progress', mime: 'video/mp4', error: null, paused: false,
    incognito: false, url, filename: '/downloads/Video Bulk Downloads/B.mp4',
    byExtensionId: undefined, startTime: new Date(now - 1000).toISOString(),
    endTime: null, bytesReceived: 0, totalBytes: null,
  };
  const h = harness({ storage, records: new Map([[1, a], [2, b]]) });
  const s = await h.until((st) => st.items[0].state === 'failed');
  assert.equal(s.items[0].downloadId, undefined, 'ambiguous candidates must not be adopted');
  assert.equal(h.records.get(1).state, 'in_progress');
  assert.equal(h.records.get(2).state, 'in_progress');
  assert.equal(h.options.length, 0, 'no duplicate transfer');
});

// 4. Legacy records without identity metadata are handled conservatively.
test('legacy record without identity never adopts a same-URL transfer', async () => {
  const original = harness();
  const state = await find(original, 1);
  await start(original, state);
  const running = await original.until((s) => Number.isInteger(s.items[0].downloadId));
  const row = running.items[0];
  const url = row.url;
  const startedAt = row.startedAt;
  const storage = clone(original.storage);
  // Strip the new identity fields to simulate a pre-fix record.
  delete storage.downloaderState.items[0].downloadIdentity;
  const manual = {
    id: 1, state: 'in_progress', mime: 'video/mp4', error: null, paused: false,
    incognito: false, url, filename: '/downloads/Video Bulk Downloads/Legacy.mp4',
    byExtensionId: undefined,
    startTime: new Date(startedAt + 5000).toISOString(),
    endTime: null, bytesReceived: 0, totalBytes: null,
  };
  const h = harness({
    storage, sessionStorage: clone(original.sessionStorage),
    records: new Map([[1, manual]]),
  });
  const s = await h.until((st) => st.items[0].state === 'failed');
  assert.equal(s.items[0].downloadId, undefined, 'legacy row must not adopt by URL/time');
  assert.match(s.items[0].error, /verif/i);
  assert.equal(h.records.get(1).state, 'in_progress', 'unrelated transfer untouched');
  assert.equal(h.options.length, 0, 'no automatic duplicate transfer');
});

// 5a. Paused-transfer recovery uses verified identity under a new ID.
test('paused transfer recovers under its new ID via verified identity', async () => {
  const original = harness();
  const state = await find(original, 1);
  await start(original, state);
  await original.until((s) => Number.isInteger(s.items[0].downloadId));
  await original.command({ type: 'pause', batchId: state.batchId, id: state.items[0].id });
  const pausedState = await original.until((s) => s.items[0].paused === true);
  const row = pausedState.items[0];
  const url = row.url;
  const identityStart = row.downloadIdentity.startTime;
  const storage = clone(original.storage);
  const ours = {
    ...clone(original.records.get(row.downloadId)),
    id: 2, byExtensionId: undefined,
  };
  assert.equal(ours.startTime, identityStart);
  assert.equal(ours.paused, true);
  const manual = {
    id: 1, state: 'in_progress', mime: 'video/mp4', error: null, paused: false,
    incognito: false, url, filename: ours.filename,
    byExtensionId: undefined,
    startTime: new Date(Date.parse(identityStart) + 24 * HOUR).toISOString(),
    endTime: null, bytesReceived: 0, totalBytes: null,
  };
  const restored = harness({
    storage, sessionStorage: clone(original.sessionStorage),
    records: new Map([[1, manual], [2, ours]]),
  });
  const s = await restored.until((st) => st.items[0].downloadId === 2 && st.items[0].paused === true);
  assert.equal(s.items[0].state, 'downloading');
  assert.equal(restored.records.get(1).state, 'in_progress', 'manual same-URL transfer untouched');
  assert.equal((await restored.command({ type: 'resume', batchId: s.batchId, id: s.items[0].id })).ok, true);
  restored.complete(2);
  await restored.until((st) => st.items[0].state === 'done');
  assert.equal(restored.options.length, 0, 'no duplicate transfer');
});

// 5b. Delayed Save As completion is attributed without any time window, and
// ambiguous same-URL pendings adopt nothing.
test('delayed Save As completion waits indefinitely and never adopts ambiguously', async () => {
  const seed = harness();
  const found = await find(seed, 1);
  const url = found.items[0].url;
  const storage = clone(seed.storage);
  Object.assign(storage.downloaderState.items[0], {
    state: 'downloading', startedAt: Date.now(), saveAs: true,
  });
  delete storage.downloaderState.items[0].downloadId;
  delete storage.downloaderState.items[0].downloadIdentity;
  const h = harness({ storage, records: new Map() });
  // No matching download yet: a Save As row must stay downloading across
  // repeated polls, not fail on any short window.
  for (let i = 0; i < 3; i++) {
    await tick();
    const s = await h.state();
    assert.equal(s.items[0].state, 'downloading', 'Save As pending must wait, not fail');
    assert.equal(s.items[0].downloadId, undefined);
  }
  assert.equal(h.options.length, 0, 'no duplicate while the dialog is open');
  // The dialog completes much later: onCreated carries the true identity.
  const startTime = new Date().toISOString();
  const record = {
    id: 1, state: 'in_progress', mime: 'video/mp4', error: null, paused: false,
    incognito: false, url, filename: '/downloads/Delayed.mp4',
    byExtensionId: 'video-bulk-downloader@local', startTime,
    endTime: null, bytesReceived: 0, totalBytes: null,
  };
  h.records.set(1, { ...record });
  h.browser.downloads.onCreated.emit({ ...record });
  const adopted = await h.until((st) => Number.isInteger(st.items[0].downloadId));
  assert.equal(adopted.items[0].downloadId, 1);
  assert.equal(adopted.items[0].downloadIdentity.startTime, startTime);
  assert.equal(h.options.length, 0);

  // Ambiguous case: two Save As pendings for the same URL adopt nothing.
  const seed2 = harness();
  const found2 = await find(seed2, 2);
  const sharedUrl = found2.items[0].url;
  const storage2 = clone(seed2.storage);
  for (const entry of storage2.downloaderState.items) {
    Object.assign(entry, { state: 'downloading', startedAt: Date.now(), saveAs: true, url: sharedUrl });
    delete entry.downloadId;
    delete entry.downloadIdentity;
  }
  const h2 = harness({ storage: storage2, records: new Map() });
  const ambiguous = {
    id: 7, state: 'in_progress', mime: 'video/mp4', error: null, paused: false,
    incognito: false, url: sharedUrl, filename: '/downloads/Ambiguous.mp4',
    byExtensionId: 'video-bulk-downloader@local', startTime: new Date().toISOString(),
    endTime: null, bytesReceived: 0, totalBytes: null,
  };
  h2.records.set(7, { ...ambiguous });
  h2.browser.downloads.onCreated.emit({ ...ambiguous });
  await tick();
  await new Promise((r) => setTimeout(r, 50));
  const s2 = await h2.state();
  assert.ok(s2.items.every((item) => !Number.isInteger(item.downloadId)),
    'ambiguous same-URL Save As pendings must adopt nothing');
  assert.equal(h2.options.length, 0);
});
