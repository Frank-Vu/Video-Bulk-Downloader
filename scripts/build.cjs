#!/usr/bin/env node
/**
 * Dependency-free browser packaging for Video Bulk Downloader.
 *
 * Produces, from the repository root sources:
 *   dist/firefox/   Firefox add-on directory (root manifest.json baseline)
 *   dist/chrome/    Chrome extension directory (root manifest + manifest.chrome.json)
 *   dist/video-bulk-downloader-firefox-<version>.zip
 *   dist/video-bulk-downloader-chrome-<version>.zip   (store-only ZIP, no deps)
 *
 * Usage:
 *   node scripts/build.cjs                 # build firefox and chrome
 *   node scripts/build.cjs chrome          # build chrome only
 *   node scripts/build.cjs firefox         # build firefox only
 *   node scripts/build.cjs firefox chrome  # build both (explicit)
 *   node scripts/build.cjs --help
 *
 * Arguments are validated before anything is written or removed. Removals are
 * restricted to the dist/firefox and dist/chrome subfolders and to previously
 * generated per-browser ZIP files inside dist/; nothing outside dist/ is ever
 * deleted and dist/ itself is never removed.
 *
 * Only an explicit source allowlist is packaged: tests, tooling, docs and
 * generated artifacts are never copied. A package is only produced when it is
 * complete and usable: if a mandatory runtime source is missing, or the
 * manifest / packaged code references a file that would not be packaged, the
 * build fails during planning — before dist/ is touched at all.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_ROOT = path.join(REPO_ROOT, 'dist');
const ROOT_MANIFEST = 'manifest.json';
const CHROME_OVERLAY = 'manifest.chrome.json';
const BROWSERS = ['firefox', 'chrome'];

// Background script order required for the Firefox package. browser-compat.js
// runs first so the browser.* compatibility layer exists before shared.js.
const FIREFOX_BACKGROUND_SCRIPTS = [
  'browser-compat.js',
  'shared.js',
  'platform.js',
  'background.js',
];

const CHROME_REQUIRED_PERMISSIONS = ['offscreen', 'alarms'];

// Mandatory runtime sources: a package without these is unusable and the
// build fails (before touching dist/) instead of emitting it.
const REQUIRED_COMMON_SOURCES = [
  'app.html',
  'app.css',
  'app.js',
  'shared.js',
  'background.js',
  'browser-compat.js',
  'platform.js',
];

// Mandatory Chrome runtime sources: service worker and offscreen document.
const REQUIRED_CHROME_SOURCES = [
  'service-worker.js',
  'chrome-bridge.js',
  'offscreen.html',
  'offscreen.js',
];

// icons/ holds runtime artwork only; anything else in it is skipped.
const ICON_EXTENSIONS = new Set(['.png', '.svg']);

const ZIP_PREFIX = 'video-bulk-downloader';

class UsageError extends Error {}

function usage() {
  return [
    'Usage: node scripts/build.cjs [chrome|firefox ...] [--help]',
    '',
    'With no browser arguments both browsers are built into dist/firefox and',
    'dist/chrome, plus dependency-free ZIP archives under dist/.',
  ].join('\n');
}

function parseArgs(argv) {
  const targets = [];
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { help: true, targets: [] };
    if (arg === 'chrome' || arg === 'firefox') {
      if (!targets.includes(arg)) targets.push(arg);
      continue;
    }
    throw new UsageError(`unknown argument: ${JSON.stringify(arg)}`);
  }
  return { help: false, targets: targets.length > 0 ? targets : BROWSERS.slice() };
}

function readJsonFile(file, label) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${label}: ${error.message}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function toFsPath(relPosix) {
  return path.join(REPO_ROOT, ...relPosix.split('/'));
}

function isRegularFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function listIcons() {
  const iconDir = path.join(REPO_ROOT, 'icons');
  let names;
  try {
    names = fs.readdirSync(iconDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return names
    .filter((entry) => entry.isFile() && ICON_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => `icons/${entry.name}`)
    .sort();
}

function collectSourceNames(browser) {
  const required = browser === 'chrome'
    ? REQUIRED_COMMON_SOURCES.concat(REQUIRED_CHROME_SOURCES)
    : REQUIRED_COMMON_SOURCES.slice();
  return required
    .concat(listIcons());
}

function buildFirefoxManifest(rootManifest) {
  const manifest = deepClone(rootManifest);
  manifest.background = Object.assign({}, manifest.background, {
    scripts: FIREFOX_BACKGROUND_SCRIPTS.slice(),
  });
  delete manifest.background.service_worker;
  delete manifest.background.page;
  delete manifest.background.type;
  return manifest;
}

function buildChromeManifest(rootManifest, overlay) {
  const manifest = deepClone(rootManifest);
  const overlayPermissions = Array.isArray(overlay.permissions) ? overlay.permissions : null;
  const rest = Object.assign({}, overlay);
  delete rest.permissions;
  Object.assign(manifest, deepClone(rest));

  if (overlayPermissions) {
    if (!Array.isArray(manifest.permissions)) manifest.permissions = [];
    for (const permission of overlayPermissions) {
      if (!manifest.permissions.includes(permission)) manifest.permissions.push(permission);
    }
  }

  // Chrome output drops Gecko metadata and background.scripts entirely.
  delete manifest.browser_specific_settings;
  delete manifest.applications;
  if (manifest.background) {
    delete manifest.background.scripts;
    delete manifest.background.page;
    delete manifest.background.type;
    if (typeof manifest.background.service_worker !== 'string' || manifest.background.service_worker === '') {
      throw new Error(`${CHROME_OVERLAY} must declare background.service_worker`);
    }
  } else {
    throw new Error(`${CHROME_OVERLAY} must declare background.service_worker`);
  }
  for (const permission of CHROME_REQUIRED_PERMISSIONS) {
    if (!Array.isArray(manifest.permissions) || !manifest.permissions.includes(permission)) {
      throw new Error(`Chrome manifest requires the ${JSON.stringify(permission)} permission`);
    }
  }
  return manifest;
}

function manifestFileReferences(manifest) {
  const refs = new Set();
  const addString = (value) => {
    if (typeof value === 'string' && value !== '') refs.add(value.replace(/\\/g, '/'));
  };
  const addIconMap = (map) => {
    if (map && typeof map === 'object') Object.values(map).forEach(addString);
  };
  addIconMap(manifest.icons);
  if (manifest.action && typeof manifest.action === 'object') {
    addIconMap(manifest.action.default_icon);
    addString(manifest.action.default_popup);
  }
  const background = manifest.background || {};
  if (Array.isArray(background.scripts)) background.scripts.forEach(addString);
  addString(background.service_worker);
  if (Array.isArray(manifest.web_accessible_resources)) {
    for (const entry of manifest.web_accessible_resources) {
      if (entry && Array.isArray(entry.resources)) entry.resources.forEach(addString);
    }
  }
  return [...refs];
}

// --- planning (read-only) -------------------------------------------------

/**
 * Static local file references made by packaged code: importScripts() in
 * scripts and src/href attributes in HTML. Query strings and fragments
 * (app.css?v=settings-tools-7) are stripped before resolving.
 */
function localFileRefs(name, text) {
  const refs = new Set();
  const add = (raw) => {
    let ref = String(raw).trim();
    if (ref === '' || ref.includes('${')) return;
    ref = ref.split('#')[0].split('?')[0];
    if (ref === '' || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref)) return;
    if (ref.startsWith('/')) ref = ref.slice(1);
    if (ref.startsWith('./')) ref = ref.slice(2);
    refs.add(ref.replace(/\\/g, '/'));
  };
  if (name.endsWith('.js')) {
    for (const call of text.matchAll(/importScripts\s*\(([^)]*)\)/g)) {
      for (const literal of call[1].matchAll(/(['"])([^'"]*)\1/g)) add(literal[2]);
    }
  } else if (name.endsWith('.html')) {
    for (const attribute of text.matchAll(/\b(?:src|href)\s*=\s*(['"])([^'"]*)\1/gi)) add(attribute[2]);
  }
  return [...refs];
}

function planBrowser(browser, rootManifest, overlay) {
  const required = browser === 'chrome'
    ? REQUIRED_COMMON_SOURCES.concat(REQUIRED_CHROME_SOURCES)
    : REQUIRED_COMMON_SOURCES.slice();
  const missing = required.filter((name) => !isRegularFile(toFsPath(name)));
  if (missing.length > 0) {
    throw new Error(
      `missing required source file(s) for ${browser}: ${missing.join(', ')}. `
      + 'Refusing to build a package that would not work.',
    );
  }

  const manifest = browser === 'chrome'
    ? buildChromeManifest(rootManifest, overlay)
    : buildFirefoxManifest(rootManifest);

  const entries = [{
    name: 'manifest.json',
    data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    mtime: new Date(),
  }];
  for (const name of collectSourceNames(browser)) {
    entries.push({ name, data: fs.readFileSync(toFsPath(name)), mtime: fs.statSync(toFsPath(name)).mtime });
  }

  // Every referenced asset must actually be in the package, otherwise the
  // build fails instead of producing a broken archive.
  const packaged = new Set(entries.map((entry) => entry.name));
  const problems = [];
  for (const ref of manifestFileReferences(manifest)) {
    if (!packaged.has(ref)) problems.push(`manifest.json references ${JSON.stringify(ref)} which is not packaged`);
  }
  for (const entry of entries) {
    if (!entry.name.endsWith('.js') && !entry.name.endsWith('.html')) continue;
    for (const ref of localFileRefs(entry.name, entry.data.toString('utf8'))) {
      if (!packaged.has(ref)) problems.push(`${entry.name} references ${JSON.stringify(ref)} which is not packaged`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`unusable ${browser} package:\n  - ${problems.join('\n  - ')}`);
  }

  return { browser, manifest, entries };
}

// --- safe writes ---------------------------------------------------------

function distChildDir(browser) {
  const target = path.resolve(DIST_ROOT, browser);
  const rel = path.relative(DIST_ROOT, target);
  if (rel !== browser || rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`refusing to touch unsafe path: ${target}`);
  }
  return target;
}

function verifyOutputPath(target) {
  let stat;
  try { stat = fs.lstatSync(target); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (stat.isSymbolicLink()) throw new Error(`refusing to replace a linked output path: ${target}`);
}

function cleanPackageDir(browser) {
  const target = distChildDir(browser);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  return target;
}

function removeOldZips(browser) {
  if (!fs.existsSync(DIST_ROOT)) return;
  const pattern = new RegExp(`^${ZIP_PREFIX}-${browser}-[A-Za-z0-9._-]+\\.zip$`);
  for (const entry of fs.readdirSync(DIST_ROOT, { withFileTypes: true })) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const victim = path.join(DIST_ROOT, entry.name);
    const rel = path.relative(DIST_ROOT, victim);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`refusing to remove unsafe path: ${victim}`);
    }
    fs.unlinkSync(victim);
  }
}

// --- dependency-free store-only ZIP --------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const safe = Number.isNaN(date.getTime()) ? new Date(0) : date;
  const year = Math.max(safe.getFullYear(), 1980);
  const time = (safe.getHours() << 11) | (safe.getMinutes() << 5) | Math.floor(safe.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((safe.getMonth() + 1) << 5) | safe.getDate();
  return [time, day];
}

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const [time, day] = dosDateTime(entry.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);      // version needed
    local.writeUInt16LE(0x0800, 6);  // UTF-8 names
    local.writeUInt16LE(0, 8);       // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);      // version made by
    central.writeUInt16LE(20, 6);      // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);      // method: store
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += 30 + nameBuf.length + entry.data.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralBuf, eocd]);
}

// --- output --------------------------------------------------------------

function writePlan(plan, version) {
  const outDir = cleanPackageDir(plan.browser);
  for (const entry of plan.entries) {
    const dest = path.join(outDir, ...entry.name.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.data);
  }

  fs.mkdirSync(DIST_ROOT, { recursive: true });
  removeOldZips(plan.browser);
  const zipName = `${ZIP_PREFIX}-${plan.browser}-${version}.zip`;
  const zipPath = path.join(DIST_ROOT, zipName);
  const rel = path.relative(DIST_ROOT, zipPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`refusing to write unsafe path: ${zipPath}`);
  }
  fs.writeFileSync(zipPath, buildZip(plan.entries));

  return { outDir, zipPath };
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }

  // Read-only planning and validation first: nothing is removed or written
  // until every manifest and source list for every requested browser is ready.
  const rootManifest = readJsonFile(path.join(REPO_ROOT, ROOT_MANIFEST), ROOT_MANIFEST);
  const overlay = readJsonFile(path.join(REPO_ROOT, CHROME_OVERLAY), CHROME_OVERLAY);
  const version = typeof rootManifest.version === 'string' && /^[0-9A-Za-z._-]+$/.test(rootManifest.version)
    ? rootManifest.version
    : '0.0.0';
  const plans = [];
  const planErrors = [];
  for (const browser of options.targets) {
    try {
      plans.push(planBrowser(browser, rootManifest, overlay));
    } catch (error) {
      planErrors.push(error.message);
    }
  }
  if (planErrors.length > 0) {
    throw new Error(planErrors.join('\n'));
  }

  // Check existing junctions/symlinks before any recursive removal or write.
  verifyOutputPath(DIST_ROOT);
  for (const plan of plans) {
    verifyOutputPath(distChildDir(plan.browser));
    verifyOutputPath(path.join(DIST_ROOT, `${ZIP_PREFIX}-${plan.browser}-${version}.zip`));
  }

  for (const plan of plans) {
    const { outDir, zipPath } = writePlan(plan, version);
    const relOut = path.relative(process.cwd(), outDir) || outDir;
    const relZip = path.relative(process.cwd(), zipPath) || zipPath;
    console.log(`${plan.browser}: ${plan.entries.length} files -> ${relOut}`);
    console.log(`${plan.browser}: zip -> ${relZip}`);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`error: ${error.message}`);
    console.error(usage());
    process.exit(2);
  }
  console.error(`build failed: ${error.message}`);
  process.exit(1);
}
