/* Real Firefox installation/UI checks in a disposable GeckoDriver session.
 * Set FIREFOX_PATH and GECKODRIVER_PATH; no npm dependencies are needed.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const firefox = process.env.FIREFOX_PATH, driverPath = process.env.GECKODRIVER_PATH;
  if (!firefox || !driverPath || !fs.existsSync(firefox) || !fs.existsSync(driverPath)) {
    throw new Error('Set FIREFOX_PATH and GECKODRIVER_PATH to the browser and driver executables.');
  }
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build.cjs'), 'firefox'], { cwd: root, stdio: 'inherit' });
  const addonRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'video-downloader-firefox-'));
  fs.cpSync(path.join(root, 'dist', 'firefox'), addonRoot, { recursive: true });
  const portProbe = net.createServer();
  await new Promise((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  const driver = spawn(driverPath, ['--port', String(port), '--host', '127.0.0.1', '--allow-system-access'], { stdio: 'ignore', windowsHide: true });
  const endpoint = `http://127.0.0.1:${port}`;
  let session;
  async function request(method, route, body) {
    const response = await fetch(endpoint + route, { method,
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok || result.value?.error) throw new Error(JSON.stringify(result.value));
    return result.value;
  }
  try {
    const deadline = Date.now() + 10000;
    for (;;) {
      try { await request('GET', '/status'); break; }
      catch (error) { if (Date.now() > deadline) throw error; await delay(100); }
    }
    const created = await request('POST', '/session', { capabilities: { alwaysMatch: {
      browserName: 'firefox', 'moz:firefoxOptions': { binary: firefox, args: ['-headless'],
        prefs: { 'browser.shell.checkDefaultBrowser': false, 'browser.startup.homepage_override.mstone': 'ignore' } },
    } } });
    session = created.sessionId;
    const base = `/session/${session}`;
    const execute = (script, args = []) => request('POST', base + '/execute/sync', { script, args });
    const executeAsync = async (expression, args = []) => {
      const value = await request('POST', base + '/execute/async', {
        script: `const done=arguments[arguments.length-1]; Promise.resolve(${expression}).then(done,error=>done({__error:error.message}));`, args,
      });
      if (value?.__error) throw new Error(value.__error);
      return value;
    };
    await request('POST', base + '/timeouts', { script: 15000 });
    const id = await request('POST', base + '/moz/addon/install', { path: addonRoot, temporary: true });
    await request('POST', base + '/moz/context', { context: 'chrome' });
    const uuid = await execute('return JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids"))[arguments[0]];', [id]);
    await executeAsync('ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs").ExtensionPermissions.add(arguments[0],{permissions:["internal:privateBrowsingAllowed"],origins:[]})', [id]);
    await executeAsync('ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs").AddonManager.getAddonByID(arguments[0]).then(addon=>addon.reload())', [id]);
    await request('POST', base + '/moz/context', { context: 'content' });
    await request('POST', base + '/url', { url: `moz-extension://${uuid}/app.html` });
    const command = (message) => executeAsync('window.browser.tabs.getCurrent().then(tab=>window.browser.runtime.sendMessage({...arguments[0],tabId:tab.id}))', [message]);
    let state, lastReadError;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { state = await command({ type: 'get-state' }); if (state?.ok) break; }
      catch (error) { lastReadError = error.message; }
      await delay(100);
    }
    assert.equal(state?.ok, true, JSON.stringify(state) || lastReadError);
    assert.equal(state.state.incognito, false);
    assert.equal(await execute('return window.VideoDownloaderBrowser.isChrome;'), false);
    const html = '<h1>Firefox fixture</h1><div id="hd-porn-dload"><a href="/dload/fixture/1080/clip.mp4">1080</a><a href="/dload/fixture/2160/clip-av1.mp4">2160</a></div>';
    const parsed = await executeAsync('window.VideoDownloader.parseVideoPage(arguments[0],"https://www.eporner.com/video-fixture/title/",{})', [html]);
    assert.equal(parsed.height, 2160);
    assert.equal(parsed.codec, 'AV1');
    assert.equal(parsed.title, 'Firefox fixture');
    assert.equal((await command({ type: 'input', input: 'normal Firefox draft' })).ok, true);
    console.log('PASS: Firefox add-on installation, UI messaging, real DOM parsing, and normal draft');
    const normalHandle = await request('GET', base + '/window');
    const privateWindow = await executeAsync('window.browser.windows.create({incognito:true,url:window.browser.runtime.getURL("app.html")})');
    const handles = await request('GET', base + '/window/handles');
    const privateHandle = handles.find((handle) => handle !== normalHandle);
    assert.ok(privateHandle, 'Private extension tab exists');
    await request('POST', base + '/window', { handle: privateHandle });
    const privateState = await command({ type: 'get-state' });
    assert.equal(privateState.ok, true, privateState.error);
    assert.equal(privateState.state.incognito, true);
    assert.equal((await command({ type: 'input', input: 'private Firefox draft' })).ok, true);
    const backup = await command({ type: 'export-backup' });
    assert.equal(backup.ok, true, backup.error);
    const data = JSON.parse(backup.state.exportText).data;
    assert.equal(data.normal.draft.input, 'normal Firefox draft');
    assert.equal(data.private.draft.input, 'private Firefox draft');
    await request('DELETE', base + '/window');
    await request('POST', base + '/window', { handle: normalHandle });
    assert.equal((await command({ type: 'get-state' })).state.input, 'normal Firefox draft');
    await delay(300);
    assert.equal(await executeAsync('window.browser.storage.session.get("privateDownloaderDraft").then(data=>data.privateDownloaderDraft===undefined)'), true);
    const local = await executeAsync('window.browser.storage.local.get(null)');
    assert.ok(!JSON.stringify(local).includes('private Firefox draft'));
    assert.ok(Number.isInteger(privateWindow.id));
    console.log('PASS: Firefox private tab, session separation, full backup, and last-window cleanup');
    console.log(`Firefox ${created.capabilities.browserVersion} smoke checks passed.`);
  } finally {
    if (session) { try { await request('DELETE', `/session/${session}`); } catch { } }
    driver.kill();
    fs.rmSync(addonRoot, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
