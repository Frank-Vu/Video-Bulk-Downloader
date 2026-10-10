const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, find, start, tick, clone } = require('./backend-helpers.cjs');

const bounded = (promise) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Command queue blocked')), 1000);
  })]).finally(() => clearTimeout(timer));
};

async function pausedDownload(h) {
  const ready = await find(h);
  await start(h, ready);
  const running = await h.until((s) => Number.isInteger(s.items[0].downloadId));
  return (await h.command({ type: 'pause', batchId: running.batchId, id: running.items[0].id })).state;
}

test('Firefox resume promise can stay pending throughout transfer without blocking commands or events', async () => {
  const h = harness();
  const state = await pausedDownload(h), item = state.items[0];
  let rejectResume;
  const originalResume = h.browser.downloads.resume;
  h.browser.downloads.resume = async (id) => {
    await originalResume(id);
    await new Promise((_, reject) => { rejectResume = reject; });
  };
  const result = await bounded(h.command({ type: 'resume', batchId: state.batchId, id: item.id }));
  assert.equal(result.ok, true);
  assert.equal(result.state.items[0].paused, false);
  assert.equal(result.state.items[0].downloadIdentity.startTime, h.records.get(item.downloadId).startTime);
  assert.equal((await bounded(h.command({ type: 'input', input: 'Still usable' }))).ok, true);
  assert.equal((await bounded(h.command({ type: 'get-progress' }))).ok, true);
  assert.equal((await bounded(h.command({ type: 'pause', batchId: state.batchId, id: item.id }))).ok, true);
  rejectResume(new Error('Download paused again'));
  await tick();
  const paused = await bounded(h.state());
  assert.equal(paused.items[0].paused, true);
  assert.equal(paused.items[0].resumeError, undefined, 'late rejection must not overwrite the new pause');
});

test('slow resume initiations deduplicate and rejection leaves the row paused and retryable', async () => {
  const h = harness();
  const state = await pausedDownload(h), item = state.items[0];
  let rejectResume, calls = 0;
  h.browser.downloads.resume = () => { calls++; return new Promise((_, reject) => { rejectResume = reject; }); };
  const message = { type: 'resume', batchId: state.batchId, id: item.id };
  const result = await bounded(h.command(message));
  assert.equal(result.state.items[0].resuming, true);
  assert.equal(result.state.items[0].paused, true);
  await bounded(h.command(message));
  assert.equal(calls, 1);
  const tags = await bounded(h.command({ type: 'name-tag', kind: 'channel', action: 'add', name: 'Channel' }));
  assert.equal(tags.ok, true);
  rejectResume(new Error('Cannot resume'));
  const failed = await h.until((s) => s.items[0].resumeError);
  assert.equal(failed.items[0].resuming, undefined);
  assert.equal(failed.items[0].paused, true);
  assert.match(failed.items[0].resumeError, /Cannot resume/);
  h.browser.downloads.resume = async (id) => {
    Object.assign(h.records.get(id), { paused: false, state: 'in_progress' });
    h.browser.downloads.onChanged.emit({ id, paused: { current: false } });
  };
  assert.equal((await bounded(h.command(message))).state.items[0].paused, false);
});

test('late successful resume settlement cannot undo cancellation or resurrect a removed row', async () => {
  const h = harness();
  const state = await pausedDownload(h), item = state.items[0];
  let resolveResume;
  h.browser.downloads.resume = () => new Promise((resolve) => { resolveResume = resolve; });
  await bounded(h.command({ type: 'resume', batchId: state.batchId, id: item.id }));
  await bounded(h.command({ type: 'remove', batchId: state.batchId, id: item.id }));
  resolveResume();
  await tick();
  assert.equal((await h.state()).items.length, 0);
});

test('tag imports merge once, preserve filenames and history, isolate private libraries, and roll back failed writes', async () => {
  const h = harness();
  const state = await find(h);
  await h.command({ type: 'name-tag', kind: 'author', action: 'add', name: 'Alice' });
  const imported = await h.command({ type: 'import-name-tags', format: 'txt', text: '[Authors]\nalice\nBeth\n[Channels]\nChannel A\n' });
  assert.equal(imported.ok, true);
  assert.deepEqual(imported.state.namingPresets, { author: ['Alice', 'Beth'], channel: ['Channel A'] });
  assert.match(imported.state.notice, /2 reusable/);
  assert.deepEqual(imported.state.items, state.items);
  assert.equal((await h.state(true)).namingPresets, undefined);
  const exported = await h.command({ type: 'export-name-tags', format: 'json' });
  assert.equal(JSON.parse(exported.state.exportText).format, 'video-bulk-downloader-name-tags');
  assert.deepEqual((await harness({ storage: clone(h.storage) }).state()).namingPresets, imported.state.namingPresets);
  const set = h.browser.storage.local.set;
  h.browser.storage.local.set = async () => { throw new Error('Disk full'); };
  assert.equal((await h.command({ type: 'import-name-tags', format: 'txt', text: '[Channels]\nNew Channel' })).ok, false);
  assert.deepEqual((await h.state()).namingPresets, imported.state.namingPresets);
  h.browser.storage.local.set = set;
  const privateImport = await h.command({ type: 'import-name-tags', format: 'json', text: exported.state.exportText }, true);
  assert.equal(privateImport.ok, true);
  assert.equal(h.storage.downloaderState.incognito, false);
  assert.equal(h.sessionStorage.privateDownloaderState.incognito, true);
});

test('invalid and excessive merged tag imports are atomic', async () => {
  const h = harness();
  await h.state();
  const tags = Array.from({ length: 100 }, (_, i) => `P${i}`);
  await h.command({ type: 'import-name-tags', format: 'txt', text: '[Authors]\n' + tags.join('\n') });
  for (const text of ['[Channels]\nValid\n[Authors]\nExtra', 'Unlabelled', '[Channels]\n' + 'a'.repeat(101)]) {
    assert.equal((await h.command({ type: 'import-name-tags', format: 'txt', text })).ok, false);
    assert.deepEqual((await h.state()).namingPresets, { author: tags, channel: [] });
  }
});

test('discovery stores thumbnails and saved JSON imports retain them', async () => {
  const thumbnail = 'https://static.eporner.com/thumbs/sample.jpg';
  const h = harness({ fetchPage: async (url) => ({ ok: true, url, text: async () => JSON.stringify({
    title: 'Video', thumbnail, links: ['/dload/x/1080/clip.mp4'] }) }) });
  assert.equal((await find(h)).items[0].thumbnail, thumbnail);
  const imported = await h.command({ type: 'import', section: 'saved', format: 'json', text: JSON.stringify({
    format: 'video-bulk-downloader', version: 1, section: 'saved', items: [
      { pageUrl: 'https://www.eporner.com/video-old/title/', title: 'Older', thumbnail }
    ] }) });
  assert.equal(imported.state.items.find((item) => item.title === 'Older').thumbnail, thumbnail);
});

test('older saved thumbnails load without download links, deduplicate lookup and keep queue responsive', async () => {
  let release;
  const thumbnail = 'https://static.eporner.com/thumbs/old.jpg';
  const h = harness({ fetchPage: async (url) => {
    await new Promise((resolve) => { release = resolve; });
    return { ok: true, url, text: async () => JSON.stringify({ title: 'Old', thumbnail, links: [] }) };
  } });
  const imported = await h.command({ type: 'import', section: 'saved', format: 'txt', text: 'https://www.eporner.com/video-old/title/' });
  const state = imported.state, item = state.items[0];
  const message = { type: 'thumbnail', batchId: state.batchId, id: item.id };
  const first = h.command(message), second = h.command(message);
  await tick();
  assert.equal((await bounded(h.command({ type: 'input', input: 'Usable during hover lookup' }))).ok, true);
  assert.equal(h.requests.length, 1);
  release();
  assert.equal((await first).state.items[0].thumbnail, thumbnail);
  assert.equal((await second).state.items[0].thumbnail, thumbnail);
  assert.equal((await h.command(message)).ok, true);
  assert.equal(h.requests.length, 1, 'persisted thumbnails do not refetch');
  assert.equal(h.options.length, 0);
  assert.equal((await h.state()).items[0].state, 'done');
});

test('private thumbnail lookup omits login cookies and cache, removed rows cannot reappear', async () => {
  let release;
  const h = harness({ fetchPage: async (url) => {
    await new Promise((resolve) => { release = resolve; });
    return { ok: true, url, text: async () => JSON.stringify({ thumbnail: '/poster.jpg', links: [] }) };
  } });
  const state = (await h.command({ type: 'import', section: 'saved', format: 'txt', text: 'https://www.eporner.com/video-old/title/' }, true)).state;
  const message = { type: 'thumbnail', batchId: state.batchId, id: state.items[0].id };
  const lookup = h.command(message, true);
  await tick();
  assert.equal(h.requests[0].credentials, 'omit');
  assert.equal(h.requests[0].cache, 'no-store');
  await h.command({ type: 'remove', batchId: state.batchId, id: state.items[0].id }, true);
  release();
  assert.equal((await lookup).ok, false);
  assert.equal((await h.state(true)).items.length, 0);
  assert.equal((await h.command(message)).ok, false, 'private rows are not accessible from normal tabs');
});
