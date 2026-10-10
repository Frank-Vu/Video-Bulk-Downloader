const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, find, start, qualityFixture, clone } = require('./backend-helpers.cjs');

const LINKS = ['/dload/x/480/clip.mp4', '/dload/x/720/clip.mp4',
  '/dload/x/1080/clip.mp4', '/dload/x/2160/clip.mp4', '/dload/x/2160/clip-av1.mp4'];
const response = (url) => ({ ok: true, url, text: async () => qualityFixture('Video Title', LINKS) });

test('discovery records the true maximum even under a global quality limit', async () => {
  const h = harness({ fetchPage: async (url) => response(url) });
  await h.command({ type: 'settings', maxHeight: 720 });
  const state = await find(h);
  assert.equal(state.items[0].height, 720);
  assert.deepEqual(state.items[0].availableHeights, [2160, 1080, 720, 480]);
});

test('row quality overrides global settings, survives restart, and captures mixed queued qualities', async () => {
  const h = harness({ fetchPage: async (url) => response(url) });
  let state = await find(h, 2);
  await h.command({ type: 'quality', batchId: state.batchId, id: state.items[0].id, height: 480 });
  const restored = harness({ storage: h.storage, fetchPage: async (url) => response(url) });
  state = await restored.state();
  assert.equal(state.items[0].qualityHeight, 480);
  await start(restored, state, false, state.items, false, { maxHeight: 1080 });
  await restored.until((s) => s.items.every((item) => Number.isInteger(item.downloadId)));
  assert.match(restored.options[0].url, /\/480\//);
  assert.match(restored.options[1].url, /\/1080\//);
  const active = await restored.command({ type: 'quality', batchId: state.batchId, id: state.items[0].id, height: 720 });
  assert.equal(active.ok, false);
  restored.complete(1); restored.complete(2);
  state = await restored.until((s) => s.items.every((item) => item.state === 'done'));
  await restored.command({ type: 'quality', batchId: state.batchId, id: state.items[0].id, height: 2160 });
  await start(restored, state, false, [state.items[0]], false, { maxHeight: 480 });
  await restored.until((s) => s.items[0].downloadId === 3);
  assert.match(restored.options[2].url, /\/2160\//);
  restored.complete(3);
  state = await restored.until((s) => s.items[0].state === 'done');
  assert.deepEqual(state.items[0].history.map((entry) => entry.height), [480, 2160]);
});

test('unknown saved qualities can be checked without downloads or history changes', async () => {
  const h = harness({ fetchPage: async (url) => response(url) });
  await h.command({ type: 'import', section: 'saved', format: 'txt', text: 'https://www.eporner.com/video-saved/' });
  let state = await h.state();
  const history = clone(state.items[0].history), filename = state.items[0].filename;
  await h.command({ type: 'check-quality', batchId: state.batchId, id: state.items[0].id });
  state = await h.until((s) => s.items[0].state === 'done');
  assert.deepEqual(state.items[0].availableHeights, [2160, 1080, 720, 480]);
  assert.equal(state.items[0].selected, false);
  assert.equal(state.items[0].filename, filename);
  assert.deepEqual(state.items[0].history, history);
  assert.equal(h.options.length, 0);
  assert.equal(h.context.VideoDownloader.importStatus(state).busy, false, 'finished import stays finished during subsequent lookups');
  const invalid = await h.command({ type: 'quality', batchId: state.batchId, id: state.items[0].id, height: 1440 });
  assert.equal(invalid.ok, false);
  const valid = await h.command({ type: 'quality', batchId: state.batchId, id: state.items[0].id, height: 480 });
  assert.equal(valid.ok, true);
});

test('import progress persists through outstanding lookups and reports failures without downloading', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const h = harness({ fetchPage: async (url) => {
    await pending;
    return url.includes('bad') ? { ok: true, url, text: async () => qualityFixture('Bad', []) } : response(url);
  } });
  const result = await h.command({ type: 'import', section: 'found', format: 'txt',
    text: 'https://www.eporner.com/video-good/\nhttps://www.eporner.com/video-bad/' });
  assert.equal(result.ok, true);
  let progress = h.context.VideoDownloader.importStatus(result.state);
  assert.equal(progress.busy, true);
  assert.equal(progress.completed, 0);
  assert.equal(progress.total, 2);
  assert.equal(h.storage.downloaderState.importTask.total, 2);
  const duplicate = await h.command({ type: 'import', section: 'saved', format: 'txt', text: 'https://www.eporner.com/video-other/' });
  assert.equal(duplicate.ok, false);
  release();
  const state = await h.until((s) => s.items.every((item) => item.state !== 'finding'));
  progress = h.context.VideoDownloader.importStatus(state);
  assert.equal(progress.busy, false);
  assert.equal(progress.completed, 2);
  assert.equal(progress.failed, 1);
  assert.equal(h.options.length, 0);
  const restored = harness({ storage: h.storage });
  assert.equal(restored.context.VideoDownloader.importStatus(await restored.state()).completed, 2);
});

test('rename fields and recent names persist, remain isolated by session, and round-trip in JSON', async () => {
  const h = harness({ fetchPage: async (url) => response(url) });
  let state = await find(h);
  const command = { type: 'rename', batchId: state.batchId, id: state.items[0].id,
    author: 'Author Name', videoTitle: 'Video Title', channel: 'Channel Name' };
  assert.equal((await h.command(command)).ok, true);
  state = await h.state();
  assert.equal(state.items[0].filename, 'Author Name - Video Title [Channel Name]');
  assert.deepEqual(state.namingPresets, { author: ['Author Name'], channel: ['Channel Name'] });
  assert.equal((await h.state(true)).namingPresets, undefined);
  const restored = harness({ storage: h.storage });
  assert.deepEqual((await restored.state()).namingPresets, state.namingPresets);
  const exported = await h.command({ type: 'export', section: 'found', format: 'json' });
  const imported = harness({ fetchPage: async (url) => response(url) });
  assert.equal((await imported.command({ type: 'import', section: 'found', format: 'json', text: exported.state.exportText })).ok, true);
  const importedState = await imported.until((s) => s.items[0].state === 'ready');
  assert.deepEqual(importedState.items[0].naming, state.items[0].naming);
  assert.equal(importedState.items[0].filename, state.items[0].filename);
  const setter = h.browser.storage.local.set;
  h.browser.storage.local.set = async () => { throw new Error('Storage failed'); };
  assert.equal((await h.command({ ...command, author: 'Other' })).ok, false);
  h.browser.storage.local.set = setter;
  state = await h.state();
  assert.equal(state.items[0].filename, 'Author Name - Video Title [Channel Name]');
  assert.deepEqual(state.namingPresets.author, ['Author Name']);
});

test('export names include timestamp and remain unique for same-millisecond exports', async () => {
  const h = harness();
  const vd = h.context.VideoDownloader;
  const time = Date.parse('2026-10-10T14:32:05.123Z');
  const first = vd.exportFilename('found', 'json', false, time);
  const second = vd.exportFilename('found', 'json', false, time);
  assert.equal(first, 'found-videos-2026-10-10_14-32-05-123.json');
  assert.notEqual(first, second);
  assert.match(vd.exportFilename('saved', 'txt', true, time), /^saved-videos-private-2026-10-10_14-32-05-\d{3}\.txt$/);
  assert.equal(vd.structuredFilename({ author: '', videoTitle: 'Title', channel: '' }), 'Title');
  assert.throws(() => vd.structuredFilename({ videoTitle: ' ' }), /video title/);
  const long = vd.structuredFilename({ author: 'Name', videoTitle: 'a'.repeat(250), channel: 'Channel' });
  assert.ok(long.endsWith('[Channel]'));
  assert.ok(long.length <= 180);
});

test('a selected quality that disappears fails explicitly instead of downloading a lower resolution', async () => {
  let links = LINKS;
  const h = harness({ fetchPage: async (url) => ({ ok: true, url, text: async () => qualityFixture('Video', links) }) });
  const state = await find(h);
  await h.command({ type: 'quality', batchId: state.batchId, id: state.items[0].id, height: 1080 });
  links = ['/dload/x/480/clip.mp4', '/dload/x/720/clip.mp4'];
  await start(h, state);
  const after = await h.until((s) => s.items[0].state === 'failed');
  assert.match(after.items[0].error, /1080p is no longer available/);
  assert.deepEqual(after.items[0].availableHeights, [720, 480]);
  assert.equal(h.options.length, 0);
  await h.command({ type: 'check-quality', batchId: state.batchId, id: state.items[0].id });
  assert.equal((await h.until((s) => s.items[0].state === 'ready')).items[0].height, 720);
});

test('reusable tags can be managed before discovery, deduplicate, and persist in their own session', async () => {
  const h = harness();
  const add = (kind, name, incognito = false) => h.command({ type: 'name-tag', action: 'add', kind, name }, incognito);
  assert.equal((await add('author', '  First   Author  ')).ok, true);
  await add('author', 'first author');
  await add('channel', 'First Channel');
  await add('author', 'Private Author', true);
  let state = await h.state();
  assert.equal(state.items.length, 0);
  assert.deepEqual(state.namingPresets, { author: ['First Author'], channel: ['First Channel'] });
  assert.deepEqual((await h.state(true)).namingPresets.author, ['Private Author']);
  const restored = harness({ storage: h.storage, sessionStorage: h.sessionStorage });
  assert.deepEqual((await restored.state()).namingPresets, state.namingPresets);
  const set = h.browser.storage.local.set;
  h.browser.storage.local.set = async () => { throw new Error('Storage failed'); };
  assert.equal((await add('author', 'Rejected')).ok, false);
  h.browser.storage.local.set = set;
  assert.deepEqual((await h.state()).namingPresets.author, ['First Author']);
  assert.equal((await add('channel', ' ')).ok, false);
  await h.command({ type: 'name-tag', action: 'remove', kind: 'channel', name: 'First Channel' });
  assert.deepEqual((await h.state()).namingPresets.channel, []);
  h.browser.windows.getAll = async () => [];
  h.browser.windows.onRemoved.emit(1);
  await h.until((s) => !s.namingPresets, true);
  assert.deepEqual((await h.state()).namingPresets.author, ['First Author']);
});

test('applying multiple author chips preserves title edits and replaces tags without duplication', async () => {
  const h = harness({ fetchPage: async (url) => response(url) });
  for (const [kind, name] of [['author', 'Alice'], ['author', 'Beth'], ['channel', 'Channel A'], ['channel', 'Channel B']]) {
    await h.command({ type: 'name-tag', action: 'add', kind, name });
  }
  let state = await find(h);
  const apply = (authors, channel) => h.command({ type: 'apply-name-tags', batchId: state.batchId, id: state.items[0].id, authors, channel });
  assert.equal((await apply(['Alice', 'Beth'], 'Channel A')).ok, true);
  state = await h.state();
  assert.equal(state.items[0].filename, 'Alice & Beth - Video Title [Channel A]');
  await h.command({ type: 'edit', batchId: state.batchId, id: state.items[0].id, filename: 'Alice & Beth - My Edited Title [Channel A]' });
  assert.equal((await apply(['Beth'], 'Channel B')).ok, true);
  state = await h.state();
  assert.equal(state.items[0].filename, 'Beth - My Edited Title [Channel B]');
  assert.equal(state.items[0].naming.videoTitle, 'My Edited Title');
  await apply(['Beth'], 'Channel B');
  assert.equal((await h.state()).items[0].filename, state.items[0].filename);
  await apply([], '');
  assert.equal((await h.state()).items[0].filename, 'My Edited Title');
  const unknown = await apply(['Not in the library'], '');
  assert.equal(unknown.ok, false);
  assert.equal((await h.state()).items[0].filename, 'My Edited Title');
  for (const name of ['A'.repeat(100), 'B'.repeat(100)]) await h.command({ type: 'name-tag', action: 'add', kind: 'author', name });
  const tooLong = await apply(['A'.repeat(100), 'B'.repeat(100)], '');
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error, /leave room for a video title/);
  assert.equal((await h.state()).items[0].filename, 'My Edited Title');
});

test('removing reusable tags leaves row names intact and JSON preserves multiple selected chips', async () => {
  const h = harness({ fetchPage: async (url) => response(url) });
  for (const name of ['Alice', 'Beth']) await h.command({ type: 'name-tag', action: 'add', kind: 'author', name });
  const state = await find(h);
  const apply = { type: 'apply-name-tags', batchId: state.batchId, id: state.items[0].id, authors: ['Alice', 'Beth'], channel: '' };
  await h.command(apply);
  const before = (await h.state()).items[0].filename;
  await h.command({ type: 'name-tag', action: 'remove', kind: 'author', name: 'Alice' });
  assert.equal((await h.state()).items[0].filename, before);
  assert.equal((await h.command(apply)).ok, true, 'already applied removed tags can still be kept or deselected');
  const exported = await h.command({ type: 'export', section: 'found', format: 'json' });
  const imported = harness({ fetchPage: async (url) => response(url) });
  await imported.command({ type: 'import', section: 'found', format: 'json', text: exported.state.exportText });
  const after = await imported.until((s) => s.items[0].state === 'ready');
  assert.deepEqual(after.items[0].naming.authors, ['Alice', 'Beth']);
  assert.equal(after.items[0].filename, before);
});
