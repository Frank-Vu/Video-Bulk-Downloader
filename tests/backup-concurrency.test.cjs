const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, find, start, clone, tick } = require('./backend-helpers.cjs');

async function exportBackup(h) {
  const result = await h.command({ type: 'export-backup' });
  assert.equal(result.ok, true, result.error);
  return result.state.exportText;
}

async function richBackup() {
  const h = harness();
  const found = await find(h, 2);
  await start(h, found, false, [found.items[0]]);
  const running = await h.until(s => Number.isInteger(s.items[0].downloadId));
  h.complete(running.items[0].downloadId);
  await h.until(s => s.items[0].state === 'done');
  await find(h, 1, true);
  await h.command({ type: 'name-tag', action: 'add', kind: 'author', name: 'Author One' });
  await h.command({ type: 'name-tag', action: 'add', kind: 'channel', name: 'Private Channel' }, true);
  await h.command({ type: 'input', input: 'Normal draft with unsent URLs' });
  await h.command({ type: 'input', input: 'Private draft' }, true);
  await h.command({ type: 'settings', maxHeight: 1080, preferredCodec: 'H.264', saveAs: true });
  await h.command({ type: 'settings', maxHeight: 720, preferredCodec: 'AV1', saveAs: false }, true);
  await h.command({ type: 'concurrency', value: 5 });
  return { h, text: await exportBackup(h) };
}

test('full backups restore accumulated libraries larger than the per-list import limit', async () => {
  const h = harness();
  const data = JSON.parse(await exportBackup(h));
  data.data.normal.state.items = Array.from({ length: 10001 }, (_, i) => ({ id: `large-${i}`,
    pageUrl: `https://www.eporner.com/video-${i}/title/`, title: `Video ${i}`, filename: `File ${i}`,
    state: 'ready', history: [] }));
  const result = await h.command({ type: 'restore-backup', text: JSON.stringify(data) });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.state.items.length, 10001);
  assert.equal(h.options.length, 0);
});

test('concurrency defaults to three, validates values, and persists globally across private settings and restart', async () => {
  const h = harness();
  assert.equal((await h.state()).concurrency, 3);
  assert.equal((await h.command({ type: 'concurrency', value: 7 }, true)).state.concurrency, 7);
  assert.equal((await h.state()).concurrency, 7);
  assert.equal((await harness({ storage: clone(h.storage) }).state()).concurrency, 7);
  for (const value of [0, -1, 11, 1.5, '4', null]) assert.equal((await h.command({ type: 'concurrency', value })).ok, false);
  assert.equal((await h.state()).concurrency, 7);
  const setter = h.browser.storage.local.set;
  h.browser.storage.local.set = async () => { throw new Error('Disk full'); };
  assert.equal((await h.command({ type: 'concurrency', value: 1 })).ok, false);
  h.browser.storage.local.set = setter;
  assert.equal((await h.state()).concurrency, 7);
});

test('raising concurrency starts waiting downloads; lowering it preserves active transfers and prevents new launches', async () => {
  const h = harness();
  await h.command({ type: 'concurrency', value: 1 });
  const ready = await find(h, 6);
  await start(h, ready);
  let state = await h.until(s => s.items.filter(i => i.downloadId).length === 1);
  assert.equal(h.options.length, 1);
  await h.command({ type: 'pause', batchId: state.batchId, id: state.items[0].id });
  await h.command({ type: 'concurrency', value: 4 });
  state = await h.until(s => s.items.filter(i => i.downloadId).length === 4);
  assert.equal(state.items[0].paused, true, 'a paused transfer keeps its slot');
  await h.command({ type: 'concurrency', value: 2 });
  assert.equal(h.options.length, 4);
  h.complete(state.items[1].downloadId); await h.until(s => s.items[1].state === 'done');
  h.complete(state.items[2].downloadId); await h.until(s => s.items[2].state === 'done');
  assert.equal(h.options.length, 4, 'two remaining active slots keep the queue waiting');
  h.complete(state.items[3].downloadId);
  state = await h.until(s => s.items[4].downloadId);
  assert.equal(h.options.length, 5);
  assert.equal(state.items.filter(i => i.state === 'downloading').length, 2);
});

test('normal and private downloads share the configured pool and save dialogs stay sequential', async () => {
  const h = harness(); await h.command({ type: 'concurrency', value: 2 });
  const normal = await find(h, 3), privateState = await find(h, 3, true);
  await start(h, normal);
  await start(h, privateState, false, privateState.items, true);
  const running = await h.until(s => s.items.filter(i => i.downloadId).length === 2);
  assert.equal(h.options.length, 2);
  assert.equal((await h.state(true)).items.filter(i => i.state === 'downloading').length, 0);
  h.complete(running.items[0].downloadId); await h.until(s => s.items[2].downloadId);
  assert.equal(h.maxActive, 2);
  const dialogs = harness(); await dialogs.command({ type: 'concurrency', value: 10 });
  const ready = await find(dialogs, 3); await start(dialogs, ready, true);
  await dialogs.until(s => s.items[0].downloadId);
  assert.equal(dialogs.options.length, 1);
});

test('author/channel data preserves row filenames, selected tags, and current JSON/TXT tag files', async () => {
  const source = harness(); const state = await find(source);
  const stored = clone(source.storage);
  stored.downloaderState.namingPresets = { author: ['Alice'], channel: ['Channel One'] };
  stored.downloaderState.items[0].filename = 'Alice & Beth - Edited Title [Channel One]';
  stored.downloaderState.items[0].naming = { authors: ['Alice', 'Beth'], author: 'Alice & Beth', channel: 'Channel One', videoTitle: 'Edited Title' };
  const h = harness({ storage: stored }); const restored = await h.state();
  assert.deepEqual(restored.namingPresets, { author: ['Alice'], channel: ['Channel One'] });
  assert.deepEqual(restored.items[0].naming, stored.downloaderState.items[0].naming);
  assert.equal(restored.items[0].filename, stored.downloaderState.items[0].filename);
  const vd = h.context.VideoDownloader;
  assert.equal(vd.filenameTitle(restored.items[0]), 'Edited Title');
  for (const [format, text] of [['txt', '[Authors]\nCarol\n[Channels]\nChannel Two'], ['json', JSON.stringify({
    format: 'video-bulk-downloader-name-tags', version: 1, author: ['Carol'], channel: ['Channel Two'] })]]) {
    assert.equal((await h.command({ type: 'import-name-tags', format, text })).ok, true);
  }
  const exported = JSON.parse((await h.command({ type: 'export-name-tags', format: 'json' })).state.exportText);
  assert.deepEqual(exported.author, ['Alice', 'Carol']);
  assert.deepEqual(Object.keys(exported).sort(), ['author', 'channel', 'format', 'version']);
  assert.match((await h.command({ type: 'export-name-tags', format: 'txt' })).state.exportText, /\[Authors\][\s\S]*\[Channels\]/);
  assert.equal(state.items.length, restored.items.length);
});

test('deprecated tag formats are rejected and old field aliases are not interpreted', async () => {
  const h = harness();
  await h.command({ type: 'name-tag', action: 'add', kind: 'author', name: 'Alice' });
  const before = await h.state();
  for (const [format, text] of [['txt', '[Performers]\nCarol\n[Studios]\nChannel Two'], ['json', JSON.stringify({
    format: 'video-bulk-downloader-name-tags', version: 1, performer: ['Carol'], studio: ['Channel Two'] })]]) {
    assert.equal((await h.command({ type: 'import-name-tags', format, text })).ok, false);
    assert.deepEqual((await h.state()).namingPresets, before.namingPresets);
  }
  const vd = h.context.VideoDownloader;
  const naming = { performers: ['Alice'], performer: 'Alice', studio: 'Channel One', videoTitle: 'Title' };
  assert.deepEqual(clone(vd.selectedNameTags({ naming })), { authors: [], channel: '' });
  assert.equal(vd.structuredFilename(naming), 'Title');
  assert.deepEqual(clone(vd.nameTagLibrary({ performer: ['Alice'], studio: ['Channel One'] })), { author: [], channel: [] });
  const backup = JSON.parse(await exportBackup(h));
  backup.data.normal.state.namingPresets = { performer: ['Alice'], studio: ['Channel One'] };
  assert.equal((await h.command({ type: 'restore-backup', text: JSON.stringify(backup) })).ok, false);
  assert.deepEqual((await h.state()).namingPresets, before.namingPresets);
});

test('whole backup exports both sessions, settings, drafts, tags, full history and thumbnails', async () => {
  const { h } = await richBackup();
  const state = await h.state();
  // Add thumbnail metadata through the normal persisted list before restarting.
  h.storage.downloaderState.items[0].thumbnail = 'https://static.eporner.com/thumbs/backup.jpg';
  const restored = harness({ storage: clone(h.storage), sessionStorage: clone(h.sessionStorage), records: h.records });
  const backup = JSON.parse(await exportBackup(restored));
  assert.equal(backup.format, 'video-bulk-downloader-backup');
  assert.equal(backup.data.normal.state.items.length, 2);
  assert.equal(backup.data.private.state.items.length, 1);
  assert.equal(backup.data.normal.draft.input, 'Normal draft with unsent URLs');
  assert.equal(backup.data.private.draft.input, 'Private draft');
  assert.equal(backup.data.normal.state.items[0].thumbnail, 'https://static.eporner.com/thumbs/backup.jpg');
  assert.equal(backup.data.normal.state.items[0].history[0].filename, state.items[0].history[0].filename);
  assert.equal(backup.data.normal.state.concurrency, 5);
  assert.deepEqual(backup.data.private.state.namingPresets.channel, ['Private Channel']);
});

test('backup preview does not mutate data; restore replaces both sessions without launching or controlling transfers', async () => {
  const { text } = await richBackup();
  const h = harness(); const previous = await find(h);
  await h.command({ type: 'input', input: 'Replaced draft' });
  for (let i = 0; i < 15; i++) await h.command({ type: 'settings', maxHeight: 480 });
  const before = await h.state();
  const preview = await h.command({ type: 'preview-backup', text });
  assert.equal(preview.state.backupSummary.normal.videos, 2);
  assert.deepEqual((await h.state()).items, before.items);
  const result = await h.command({ type: 'restore-backup', text });
  assert.equal(result.ok, true, result.error);
  assert.notEqual(result.state.batchId, previous.batchId);
  assert.ok(result.state.revision > before.revision);
  assert.equal(result.state.concurrency, 5);
  assert.equal(result.state.input, 'Normal draft with unsent URLs');
  assert.equal(result.state.maxHeight, 1080);
  assert.equal(result.state.preferredCodec, 'H.264');
  assert.equal(result.state.saveAs, true);
  assert.equal(result.state.items.length, 2);
  assert.equal(result.state.items[0].history[0].downloadId, undefined);
  assert.equal(result.state.items[0].downloadId, undefined);
  assert.equal((await h.state(true)).input, 'Private draft');
  assert.equal(h.options.length, 0); assert.equal(h.resumedCalls.length, 0);
  const restarted = harness({ storage: clone(h.storage), sessionStorage: clone(h.sessionStorage) });
  assert.equal((await restarted.state()).concurrency, 5);
  assert.equal((await restarted.state()).items.length, 2);
  assert.equal(restarted.options.length, 0);
  assert.equal((await h.command({ type: 'select', batchId: previous.batchId, ids: [previous.items[0].id], selected: true })).ok, false);
});

test('backed-up active, queued and finding rows restore only as cancelled, never auto-download', async () => {
  const source = harness(); await source.command({ type: 'concurrency', value: 1 });
  const ready = await find(source, 3); await start(source, ready);
  await source.until(s => s.items[0].downloadId);
  const data = JSON.parse(await exportBackup(source));
  data.data.normal.state.items[2].state = 'finding';
  const h = harness(); const result = await h.command({ type: 'restore-backup', text: JSON.stringify(data) });
  assert.equal(result.ok, true, result.error);
  assert.ok(result.state.items.every(item => item.state === 'cancelled' && !item.downloadId && !item.url));
  assert.equal(h.options.length, 0); await tick(); assert.equal(h.requests.length, 0);
});

test('restore refuses active work and private data without an open permitted private window', async () => {
  const { text } = await richBackup();
  const busy = harness(); const ready = await find(busy); await start(busy, ready);
  await busy.until(s => s.items[0].downloadId);
  const refusal = await busy.command({ type: 'restore-backup', text });
  assert.equal(refusal.ok, false); assert.match(refusal.error, /Finish or cancel/);
  assert.equal(busy.options.length, 1);
  const h = harness(); await h.state();
  h.browser.windows.getAll = async () => [];
  assert.equal((await h.command({ type: 'restore-backup', text })).ok, false);
  assert.equal((await h.state()).items.length, 0);
  h.browser.windows.getAll = async () => [{ incognito: true }];
  h.browser.extension.isAllowedIncognitoAccess = async () => false;
  assert.equal((await h.command({ type: 'restore-backup', text })).ok, false);
});

test('failed second storage write restores previous lists, drafts, settings and revisions in both sessions', async () => {
  const { text } = await richBackup();
  const h = harness(); await find(h); await h.command({ type: 'input', input: 'Keep normal' });
  await h.command({ type: 'input', input: 'Keep private' }, true);
  const before = await h.state(), beforePrivate = await h.state(true);
  const setter = h.browser.storage.session.set; let fail = true;
  h.browser.storage.session.set = async values => { if (fail) { fail = false; throw new Error('Write failed'); } return setter(values); };
  const result = await h.command({ type: 'restore-backup', text });
  assert.equal(result.ok, false); assert.match(result.error, /previous data was kept/);
  const after = await h.state(); assert.equal(after.input, 'Keep normal'); assert.equal(after.concurrency, before.concurrency);
  assert.deepEqual(after.items, before.items); assert.ok(after.revision > before.revision);
  assert.equal((await h.state(true)).input, beforePrivate.input);
  const restarted = harness({ storage: clone(h.storage), sessionStorage: clone(h.sessionStorage) });
  assert.equal((await restarted.state()).input, 'Keep normal');
  assert.equal((await restarted.state(true)).input, 'Keep private');
});

test('invalid backups leave data untouched and report schema, URLs, duplicate IDs and malformed qualities', async () => {
  const { text } = await richBackup(); const h = harness(); const before = await h.state();
  const mutations = [
    b => b.format = 'video-bulk-downloader', b => b.version = 99,
    b => b.data.normal.state.items[0].pageUrl = 'https://evil.example/video-x/',
    b => b.data.private.state.items[0].id = b.data.normal.state.items[0].id,
    b => b.data.normal.state.items[0].availableHeights = {},
    b => b.data.normal.state.revision = 'Infinity', b => b.data.normal.state.concurrency = 11,
    b => b.data.normal.state.namingPresets.author = [42]
  ];
  for (const mutate of mutations) {
    const data = JSON.parse(text); mutate(data);
    assert.equal((await h.command({ type: 'restore-backup', text: JSON.stringify(data) })).ok, false);
    assert.deepEqual((await h.state()).items, before.items);
  }
  assert.equal((await h.command({ type: 'restore-backup', text: '{' })).ok, false);
});
