const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const sharedSource = fs.readFileSync(path.join(root, 'shared.js'), 'utf8');

class FixtureParser {
  parseFromString(html) {
    const fixture = JSON.parse(html);
    return {
      querySelectorAll: () => fixture.links.map((href) => ({ getAttribute: () => href })),
      querySelector: (selector) => selector === 'h1' ? (fixture.title === null ? null :
        ({ childNodes: [{ nodeType: 3, textContent: fixture.title }] })) :
        fixture.images?.[selector] ? { getAttribute: () => fixture.images[selector] } : null,
    };
  }
}

function loadShared() {
  const context = vm.createContext({ URL, DOMParser: FixtureParser, Node: { TEXT_NODE: 3 } });
  vm.runInContext(sharedSource, context, { filename: 'shared.js' });
  return context.VideoDownloader;
}

function fixture(title, links) {
  return JSON.stringify({ title, links });
}

test('name tags round-trip JSON and TXT including Unicode and section-like names', () => {
  const vd = loadShared();
  const tags = { author: ['Alice', 'Bích', '[Channels]', '\\Name'], channel: ['Channel A', '[Authors]'] };
  for (const format of ['json', 'txt']) {
    assert.deepEqual(JSON.parse(JSON.stringify(vd.parseNameTags(vd.exportNameTags(tags, format), format))), tags);
  }
  const merged = vd.parseNameTags('[Authors]\r\n Alice \r\nalice\r\nBích\r\n[Channels]\r\n First   Channel\r\n', 'txt');
  assert.deepEqual(JSON.parse(JSON.stringify(merged)), { author: ['Alice', 'Bích'], channel: ['First Channel'] });
});

test('invalid tag imports fail without accepting other video exports or excessive names', () => {
  const vd = loadShared();
  for (const text of ['{', '{}', '{"format":"video-bulk-downloader","version":1,"items":[]}']) {
    assert.throws(() => vd.parseNameTags(text, 'json'));
  }
  for (const text of ['Alice', '[Authors]\n', '[Authors]\n' + 'a'.repeat(101)]) {
    assert.throws(() => vd.parseNameTags(text, 'txt'));
  }
  assert.throws(() => vd.parseNameTags('a'.repeat(1024 * 1024 + 1), 'txt'));
  assert.throws(() => vd.normalizeNameTags({ author: Array.from({ length: 101 }, (_, i) => `P${i}`), channel: [] }));
  assert.throws(() => vd.normalizeNameTags({ author: [42], channel: [] }));
});

test('video thumbnails prefer Open Graph, fall back to poster, and reject unsafe URLs', () => {
  const vd = loadShared();
  const fixture = (images) => JSON.stringify({ title: 'Video', links: QUALITY_LINKS, images });
  const og = 'https://static.eporner.com/thumbs/sample.jpg';
  assert.equal(vd.parseVideoPage(fixture({ 'meta[property="og:image"]': og }), BASE).thumbnail, og);
  assert.equal(vd.parseThumbnail(fixture({ 'meta[property="og:image"]': 'javascript:alert(1)', 'video[poster]': '/poster.jpg' }), BASE),
    'https://www.eporner.com/poster.jpg');
  for (const url of ['javascript:alert(1)', 'http://static.eporner.com/image.jpg', 'https://evil.example/image.jpg',
    'https://eporner.com.evil.example/image.jpg', 'https://user:pass@eporner.com/image.jpg']) assert.equal(vd.thumbnailUrl(url, BASE), '');
  const item = { pageUrl: BASE, title: 'Video', state: 'done', thumbnail: og, history: [] };
  assert.equal(vd.parseList(vd.exportList([item], 'saved', 'json'), 'json', 'saved')[0].thumbnail, og);
});

const BASE = 'https://www.eporner.com/video-x/';
const QUALITY_LINKS = [
  '/dload/x/480/clip.mp4',
  '/dload/x/720/clip.mp4',
  '/dload/x/720/clip-av1.mp4',
  '/dload/x/1080/clip.mp4',
  '/dload/x/1080/clip-av1.mp4',
  '/dload/x/2160/clip.mp4',
  '/dload/x/2160/clip-av1.mp4',
];

test('normalizeQualityOptions defaults to unlimited AV1', () => {
  const { normalizeQualityOptions } = loadShared();
  for (const options of [undefined, null, {}]) {
    const normalized = normalizeQualityOptions(options);
    assert.equal(normalized.maxHeight, 0);
    assert.equal(normalized.preferredCodec, 'AV1');
  }
  const noArg = normalizeQualityOptions();
  assert.equal(noArg.maxHeight, 0);
  assert.equal(noArg.preferredCodec, 'AV1');
});

test('normalizeQualityOptions keeps supported positive finite heights', () => {
  const { normalizeQualityOptions } = loadShared();
  assert.equal(normalizeQualityOptions({ maxHeight: 720 }).maxHeight, 720);
  assert.equal(normalizeQualityOptions({ maxHeight: 720.9 }).maxHeight, 720);
  assert.equal(normalizeQualityOptions({ maxHeight: '1080' }).maxHeight, 1080);
});

test('normalizeQualityOptions maps non-positive or non-finite heights to unlimited', () => {
  const { normalizeQualityOptions } = loadShared();
  for (const maxHeight of [0, -1, NaN, Infinity, -Infinity, 'nope', true, {}, []]) {
    assert.equal(normalizeQualityOptions({ maxHeight }).maxHeight, 0, `maxHeight=${String(maxHeight)}`);
  }
});

test('normalizeQualityOptions defaults unknown codecs to AV1', () => {
  const { normalizeQualityOptions } = loadShared();
  assert.equal(normalizeQualityOptions({ preferredCodec: 'H.264' }).preferredCodec, 'H.264');
  assert.equal(normalizeQualityOptions({ preferredCodec: 'h264' }).preferredCodec, 'H.264');
  for (const preferredCodec of [undefined, null, '', 'VP9', 'av2', 42]) {
    assert.equal(normalizeQualityOptions({ preferredCodec }).preferredCodec, 'AV1');
  }
});

test('parseVideoPage two-argument call keeps prior highest-plus-AV1 behavior', () => {
  const { parseVideoPage } = loadShared();
  const info = parseVideoPage(fixture('Example', QUALITY_LINKS), BASE);
  assert.equal(info.height, 2160);
  assert.equal(info.codec, 'AV1');
  assert.equal(info.title, 'Example');
});

test('parseVideoPage honors an explicit height cap', () => {
  const { parseVideoPage } = loadShared();
  const capped = parseVideoPage(fixture('Example', QUALITY_LINKS), BASE, { maxHeight: 720 });
  assert.equal(capped.height, 720);
  assert.equal(capped.codec, 'AV1');
  const h264only = parseVideoPage(fixture('Example', ['/dload/x/720/clip.mp4', '/dload/x/2160/clip.mp4']),
    BASE, { maxHeight: 720 });
  assert.equal(h264only.height, 720);
  assert.equal(h264only.codec, 'H.264');
});

test('parseVideoPage prefers H.264 only at equal resolution', () => {
  const { parseVideoPage } = loadShared();
  const picked = parseVideoPage(
    fixture('Example', ['/dload/x/1080/clip.mp4', '/dload/x/1080/clip-av1.mp4']),
    BASE, { maxHeight: 0, preferredCodec: 'H.264' });
  assert.equal(picked.height, 1080);
  assert.equal(picked.codec, 'H.264');
  const resolutionWins = parseVideoPage(
    fixture('Example', ['/dload/x/1080/clip-av1.mp4', '/dload/x/720/clip.mp4']),
    BASE, { preferredCodec: 'H.264' });
  assert.equal(resolutionWins.height, 1080);
  assert.equal(resolutionWins.codec, 'AV1');
});

test('parseVideoPage rejects foreign origins and reports an unsatisfiable cap', () => {
  const { parseVideoPage } = loadShared();
  const info = parseVideoPage(fixture('Example', [
    'https://evil.test/dload/x/4320/clip-av1.mp4',
    'https://user:pass@www.eporner.com/dload/x/4320/clip-av1.mp4',
    '/dload/x/720/clip-av1.mp4',
  ]), BASE, { maxHeight: 2160 });
  assert.equal(info.height, 720);
  assert.throws(() => parseVideoPage(fixture('Example', ['/dload/x/1080/clip.mp4']),
    BASE, { maxHeight: 480 }), /480/);
});

test('parsePastedUrls normalizes, dedupes by video id, and reports invalid tokens', () => {
  const { parsePastedUrls } = loadShared();
  const result = parsePastedUrls([
    'https://www.eporner.com/video-abc/title/',
    'http://eporner.com/video-abc/other-title/?playlist_id=7',
    'https://www.eporner.com/video-def/',
    'not-a-url',
    'https://evil.test/video-xyz/',
    '',
    '   ',
    'https://www.eporner.com/video-abc/title/',
  ].join('\n'));
  assert.equal(result.urls.length, 2);
  assert.ok(result.urls[0].startsWith('https://www.eporner.com/video-abc/'));
  assert.ok(result.urls[1].startsWith('https://www.eporner.com/video-def/'));
  assert.equal(result.invalid.length, 2);
  assert.equal(result.invalid[0], 'not-a-url');
  assert.equal(result.invalid[1], 'https://evil.test/video-xyz/');
  assert.equal(result.duplicateCount, 2);
});

test('parsePastedUrls handles empty input and whitespace splitting', () => {
  const { parsePastedUrls } = loadShared();
  for (const empty of ['', null, undefined]) {
    const result = parsePastedUrls(empty);
    assert.equal(result.urls.length, 0);
    assert.equal(result.invalid.length, 0);
    assert.equal(result.duplicateCount, 0);
  }
  const spaced = parsePastedUrls('  https://www.eporner.com/video-1/a/\t https://www.eporner.com/video-2/b/  ');
  assert.equal(spaced.urls.length, 2);
  assert.equal(spaced.invalid.length, 0);
  assert.equal(spaced.duplicateCount, 0);
});

test('parsePastedUrls dedupes efficiently on repeated input', () => {
  const { parsePastedUrls } = loadShared();
  const line = 'https://www.eporner.com/video-same/title/';
  const start = Date.now();
  const result = parsePastedUrls(Array.from({ length: 2000 }, () => line).join('\n'));
  assert.equal(result.urls.length, 1);
  assert.equal(result.duplicateCount, 1999);
  assert.ok(Date.now() - start < 5000, 'deduplication should stay linear');
});

test('draft storage keys are exported with the coordinated names', () => {
  const shared = loadShared();
  assert.equal(shared.DRAFT_STORAGE_KEY, 'downloaderDraft');
  assert.equal(shared.PRIVATE_DRAFT_STORAGE_KEY, 'privateDownloaderDraft');
});

test('pause, play, and folder icons are available', () => {
  const { createActionIcon } = loadShared();
  const doc = {
    createElementNS: (ns, tag) => ({
      tag, attrs: {},
      setAttribute(key, value) { this.attrs[key] = value; },
      append() {},
    }),
  };
  for (const name of ['pause', 'play', 'folder']) {
    const svg = createActionIcon(doc, name);
    assert.equal(svg.tag, 'svg');
  }
  assert.throws(() => createActionIcon(doc, 'no-such-icon'));
});
