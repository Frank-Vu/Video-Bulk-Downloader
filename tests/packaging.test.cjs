/**
 * Packaging tests for scripts/build.cjs.
 *
 * These assert the packaging contract at the behavior level: what the two
 * generated manifests declare, what may end up inside the packages, that the
 * build works from an unrelated working directory, and that invalid arguments
 * or missing mandatory sources fail before anything in dist/ is touched. They
 * deliberately do not mirror the internal steps of the build script.
 *
 * Missing runtime sources fail the build and these checks unconditionally.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_ROOT = path.join(REPO_ROOT, 'dist');
const BUILD_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build.cjs');
const BROWSERS = ['firefox', 'chrome'];

function runBuild(args, cwd) {
  return spawnSync(process.execPath, [BUILD_SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
  });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readPackageManifest(browser) {
  return readJson(path.join(DIST_ROOT, browser, 'manifest.json'));
}

/** Sorted listing of every entry below root: dirs with trailing slash, files with size+mtime. */
function listTree(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir, prefix) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        walk(abs, rel);
      } else {
        const stat = fs.statSync(abs);
        out.push(`${rel} ${stat.size} ${stat.mtimeMs}`);
      }
    }
  };
  walk(root, '');
  return out.sort();
}

const buildCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vbd-packaging-'));
const buildResult = runBuild([], buildCwd);

test.after(() => {
  fs.rmSync(buildCwd, { recursive: true, force: true });
});

test('build succeeds from an unrelated working directory', () => {
  assert.equal(buildResult.status, 0, `build failed:\n${buildResult.stdout}\n${buildResult.stderr}`);
  for (const browser of BROWSERS) {
    assert.ok(
      fs.existsSync(path.join(DIST_ROOT, browser, 'manifest.json')),
      `missing dist/${browser}/manifest.json`,
    );
  }
  assert.deepEqual(fs.readdirSync(buildCwd), [], 'build must not write into the caller cwd');
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'manifest.json')), 'root manifest must survive the build');
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'background.js')), 'root sources must survive the build');
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'tests')), 'tests directory must survive the build');
});

test('build fails before touching dist when mandatory sources are missing', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vbd-missing-source-'));
  try {
    fs.mkdirSync(path.join(scratch, 'scripts'));
    fs.mkdirSync(path.join(scratch, 'dist'));
    fs.copyFileSync(BUILD_SCRIPT, path.join(scratch, 'scripts', 'build.cjs'));
    for (const name of ['manifest.json', 'manifest.chrome.json']) {
      fs.copyFileSync(path.join(REPO_ROOT, name), path.join(scratch, name));
    }
    fs.writeFileSync(path.join(scratch, 'dist', 'keep.txt'), 'previous output');
    const before = listTree(path.join(scratch, 'dist'));
    const result = spawnSync(process.execPath, [path.join(scratch, 'scripts', 'build.cjs')], { encoding: 'utf8', cwd: buildCwd });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing required source/);
    assert.deepEqual(listTree(path.join(scratch, 'dist')), before);
    assert.deepEqual(fs.readdirSync(buildCwd), []);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('firefox manifest keeps gecko metadata and loads scripts in order', () => {
  const root = readJson(path.join(REPO_ROOT, 'manifest.json'));
  const firefox = readPackageManifest('firefox');

  assert.equal(firefox.manifest_version, 3);
  assert.deepEqual(
    firefox.background.scripts,
    ['browser-compat.js', 'shared.js', 'platform.js', 'background.js'],
  );
  assert.ok(firefox.background.service_worker === undefined, 'firefox must not declare a service worker');
  assert.ok(firefox.browser_specific_settings, 'gecko metadata must be preserved');
  assert.equal(
    firefox.browser_specific_settings.gecko.id,
    root.browser_specific_settings.gecko.id,
  );
  assert.ok(!('minimum_chrome_version' in firefox));
  assert.ok(!firefox.permissions.includes('offscreen'));
  assert.ok(!firefox.permissions.includes('alarms'));

  // Everything outside background comes straight from the root manifest.
  const stripBackground = (manifest) => {
    const clone = Object.assign({}, manifest);
    delete clone.background;
    return clone;
  };
  assert.deepEqual(stripBackground(firefox), stripBackground(root));
});

test('chrome manifest targets chromium service worker, offscreen and alarms', () => {
  const root = readJson(path.join(REPO_ROOT, 'manifest.json'));
  const chrome = readPackageManifest('chrome');

  assert.equal(chrome.manifest_version, 3);
  assert.equal(chrome.background.service_worker, 'service-worker.js');
  assert.ok(!Array.isArray(chrome.background.scripts), 'chrome must not declare background scripts');
  assert.ok(!('browser_specific_settings' in chrome), 'gecko metadata must be stripped');
  assert.ok(!('applications' in chrome), 'legacy gecko metadata must be stripped');
  assert.equal(chrome.minimum_chrome_version, '120');
  assert.equal(chrome.incognito, 'split');
  for (const permission of ['downloads', 'storage', 'offscreen', 'alarms']) {
    assert.ok(chrome.permissions.includes(permission), `chrome permissions must include ${permission}`);
  }
  // The shared surface still comes from the root manifest baseline.
  for (const key of ['name', 'version', 'description', 'icons', 'host_permissions', 'action']) {
    assert.deepEqual(chrome[key], root[key], `chrome ${key} must match the root manifest`);
  }
});

test('packages contain runtime sources only (allowlist)', () => {
  const forbiddenNames = new Set([
    'package.json',
    '.gitignore',
    'manifest.chrome.json',
    'build.cjs',
    'chrome-smoke.cjs',
    'README.md',
    'backend-helpers.cjs',
    'dom-helpers.cjs',
  ]);
  for (const browser of BROWSERS) {
    const outDir = path.join(DIST_ROOT, browser);
    const entries = listTree(outDir).map((line) => (line.endsWith('/') ? line : line.split(' ')[0]));

    for (const required of ['manifest.json', 'app.html', 'app.js', 'shared.js', 'background.js']) {
      assert.ok(entries.includes(required), `dist/${browser} must contain ${required}`);
    }
    for (const entry of entries) {
      const base = path.posix.basename(entry);
      assert.ok(!entry.startsWith('tests/'), `${entry} must not be packaged`);
      assert.ok(!entry.startsWith('scripts/'), `${entry} must not be packaged`);
      assert.ok(!entry.startsWith('node_modules/'), `${entry} must not be packaged`);
      assert.ok(!entry.startsWith('dist/'), `${entry} must not be packaged`);
      assert.ok(!entry.startsWith('.git'), `${entry} must not be packaged`);
      assert.ok(!forbiddenNames.has(base), `${entry} is tooling/docs and must not be packaged`);
      assert.ok(!base.endsWith('.cjs'), `${entry} is tooling and must not be packaged`);
      assert.ok(!base.endsWith('.test.js'), `${entry} is a test and must not be packaged`);
      assert.ok(!base.endsWith('.md'), `${entry} is documentation and must not be packaged`);
      assert.ok(!base.endsWith('.zip'), `${entry} is a generated artifact and must not be packaged`);
      assert.ok(!base.endsWith('.xpi'), `${entry} is a generated artifact and must not be packaged`);
      assert.ok(!base.endsWith('.log'), `${entry} is a generated artifact and must not be packaged`);
    }

    // Every asset the manifest points at must have been packaged.
    const manifest = readPackageManifest(browser);
    const referenced = [...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
    for (const ref of referenced) {
      assert.ok(entries.includes(ref.replace(/\\/g, '/')), `dist/${browser} is missing ${ref}`);
    }
  }
});

test('chrome-only runtime assets stay out of the firefox package', () => {
  for (const name of ['service-worker.js', 'offscreen.html', 'offscreen.js', 'chrome-bridge.js']) {
    assert.ok(fs.existsSync(path.join(DIST_ROOT, 'chrome', name)), `chrome package must contain ${name}`);
    assert.ok(!fs.existsSync(path.join(DIST_ROOT, 'firefox', name)), `firefox package must not contain ${name}`);
  }
  for (const name of ['browser-compat.js', 'platform.js']) {
    assert.ok(fs.existsSync(path.join(DIST_ROOT, 'firefox', name)), `firefox package must contain ${name}`);
    assert.ok(fs.existsSync(path.join(DIST_ROOT, 'chrome', name)), `chrome package must contain ${name}`);
  }
});

test('single-browser builds leave the other output alone', () => {
  const chromeBefore = listTree(path.join(DIST_ROOT, 'chrome'));
  const result = runBuild(['firefox'], buildCwd);
  assert.equal(result.status, 0, `single build failed:\n${result.stdout}\n${result.stderr}`);
  assert.ok(fs.existsSync(path.join(DIST_ROOT, 'firefox', 'manifest.json')));
  assert.deepEqual(listTree(path.join(DIST_ROOT, 'chrome')), chromeBefore);
});

test('invalid arguments fail before touching dist', () => {
  const before = listTree(DIST_ROOT);
  for (const args of [['safari'], ['--bogus'], ['chrome', 'safari']]) {
    const result = runBuild(args, buildCwd);
    assert.notEqual(result.status, 0, `expected failure for ${JSON.stringify(args)}`);
    assert.match(result.stderr, /error:/, `expected a usage error for ${JSON.stringify(args)}`);
  }
  assert.deepEqual(listTree(DIST_ROOT), before, 'failed invocations must not modify dist');
});

test('dependency-free zip archives are produced under dist', () => {
  for (const browser of BROWSERS) {
    const zips = fs.readdirSync(DIST_ROOT)
      .filter((name) => name.startsWith(`video-bulk-downloader-${browser}-`) && name.endsWith('.zip'));
    assert.equal(zips.length, 1, `expected exactly one ${browser} zip, found ${JSON.stringify(zips)}`);
    const data = fs.readFileSync(path.join(DIST_ROOT, zips[0]));
    assert.ok(data.length > 22, 'zip must not be empty');
    assert.equal(data.readUInt32LE(0), 0x04034b50, 'zip must start with a local file header');
    assert.equal(data.readUInt32LE(data.length - 22), 0x06054b50, 'zip must end with an end-of-central-directory record');
  }
});

test('package.json wires up dependency-free build and test scripts', () => {
  const pkg = readJson(path.join(REPO_ROOT, 'package.json'));
  assert.equal(pkg.scripts.test, 'node --test');
  assert.equal(pkg.scripts.build, 'node scripts/build.cjs');
  assert.equal(pkg.scripts['build:chrome'], 'node scripts/build.cjs chrome');
  assert.equal(pkg.scripts['build:firefox'], 'node scripts/build.cjs firefox');
  assert.equal(pkg.dependencies, undefined, 'packaging must stay dependency-free');
  assert.equal(pkg.devDependencies, undefined, 'packaging must stay dependency-free');
});
