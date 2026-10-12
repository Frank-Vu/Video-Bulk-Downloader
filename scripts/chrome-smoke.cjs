/* Real Chrome integration checks against a local HTTPS fixture, never the live site.
 * Requires Node 22+, OpenSSL, and Chrome for Testing (set CHROME_PATH).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(read, accept, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.versions = new Map();
    this.exceptions = [];
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === 'Runtime.exceptionThrown') this.exceptions.push(message.params.exceptionDetails);
      if (message.method === 'ServiceWorker.workerVersionUpdated') {
        for (const version of message.params.versions) this.versions.set(`${message.sessionId}:${version.versionId}`, { ...version, sessionId: message.sessionId });
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}${params.expression ? ` (${params.expression.slice(0, 240)})` : ''}`));
      }, 25000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async attach(targetId) {
    const sessionId = (await this.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    await this.send('Runtime.enable', {}, sessionId);
    return sessionId;
  }
  async evaluate(sessionId, expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
}

async function main() {
  if (!globalThis.WebSocket) throw new Error('Use Node.js 22 or newer for browser verification.');
  const chromePath = process.env.CHROME_PATH;
  if (!chromePath || !fs.existsSync(chromePath)) throw new Error('Set CHROME_PATH to Chrome for Testing chrome.exe (or chrome).');
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build.cjs'), 'chrome'], { cwd: root, stdio: 'inherit' });
  const qaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'video-downloader-smoke-'));
  let chrome, server, cdp;
  const transfers = [];
  const pages = [];
  let live = 0, peak = 0;
  try {
    const cert = path.join(qaRoot, 'cert.pem'), key = path.join(qaRoot, 'key.pem');
    execFileSync(process.env.OPENSSL_PATH || 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=www.eporner.com'], { stdio: 'ignore', windowsHide: true });
    server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
      if (req.url.startsWith('/video-')) {
        const id = req.url.split('/')[1];
        pages.push({ id, cookie: req.headers.cookie || '' });
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><h1>Fixture ${id}</h1><div id="hd-porn-dload"><a href="/dload/${id}/1080/clip.mp4">1080</a><a href="/dload/${id}/2160/clip-av1.mp4">2160</a></div></html>`);
      } else if (req.url.startsWith('/dload/')) {
        transfers.push({ url: req.url, cookie: req.headers.cookie || '' });
        live++; peak = Math.max(peak, live);
        const chunk = Buffer.alloc(64 * 1024, 0x42);
        let remaining = 80;
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': chunk.length * remaining });
        const timer = setInterval(() => {
          if (remaining-- > 0) res.write(chunk);
          if (remaining <= 0) { clearInterval(timer); res.end(); }
        }, 100);
        res.once('close', () => { clearInterval(timer); live--; });
      } else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<title>Fixture keeper</title>'); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const fixturePort = server.address().port;
    const profile = path.join(qaRoot, 'profile');
    fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({
      download: { default_directory: path.join(qaRoot, 'downloads'), prompt_for_download: false },
      profile: { default_content_setting_values: { automatic_downloads: 1 } },
    }));
    const extension = path.join(qaRoot, 'extension');
    fs.cpSync(path.join(root, 'dist', 'chrome'), extension, { recursive: true });
    chrome = spawn(chromePath, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`, '--ignore-certificate-errors', '--no-proxy-server',
      `--host-resolver-rules=MAP www.eporner.com 127.0.0.1:${fixturePort}`, 'about:blank'],
    { stdio: 'ignore', windowsHide: true });
    const endpoint = await until(async () => {
      try { return fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n'); }
      catch { return null; }
    }, Boolean, 'Chrome DevTools endpoint');
    const socket = new WebSocket(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
    cdp = new CDP(socket);
    const targets = () => cdp.send('Target.getTargets').then((result) => result.targetInfos);
    const worker = await until(targets, (list) => list.some((target) => target.type === 'service_worker' && target.url.endsWith('/service-worker.js')), 'extension worker');
    const workerTarget = worker.find((target) => target.type === 'service_worker' && target.url.endsWith('/service-worker.js'));
    const extensionId = new URL(workerTarget.url).host;
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: path.join(qaRoot, 'downloads') });
    const managerId = (await cdp.send('Target.createTarget', { url: 'chrome://extensions/' })).targetId;
    const managerSession = await cdp.attach(managerId);
    await cdp.send('ServiceWorker.enable', {}, managerSession);
    await until(() => cdp.evaluate(managerSession, 'Boolean(globalThis.chrome?.developerPrivate)'), Boolean, 'extension manager');
    await cdp.evaluate(managerSession, 'new Promise(resolve=>chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true},resolve))');
    await cdp.evaluate(managerSession, `new Promise((resolve,reject)=>chrome.developerPrivate.updateExtensionConfiguration({extensionId:${JSON.stringify(extensionId)},incognitoAccess:true},()=>chrome.runtime.lastError?reject(new Error(chrome.runtime.lastError.message)):resolve(true)))`);
    const appUrl = `chrome-extension://${extensionId}/app.html`;
    async function normalWorkerSession() {
      const candidate = await until(async () => {
        const running = new Set([...cdp.versions.values()].filter((version) => version.sessionId === managerSession && version.runningStatus === 'running').map((version) => version.targetId));
        return (await targets()).find((target) => target.type === 'service_worker' && target.url === workerTarget.url &&
          target.browserContextId === workerTarget.browserContextId && running.has(target.targetId));
      }, Boolean, 'normal worker');
      const workerSession = await cdp.attach(candidate.targetId);
      await until(() => cdp.evaluate(workerSession, 'typeof browser !== "undefined"'), Boolean, 'worker initialization');
      return workerSession;
    }
    async function openNormalApp() {
      const workerSession = await normalWorkerSession();
      await cdp.evaluate(workerSession, `browser.tabs.create({url:${JSON.stringify(appUrl)}}).then(()=>true)`);
      const list = await until(targets, (values) => values.some((target) => target.type === 'page' && target.url === appUrl), 'normal app tab');
      return list.find((target) => target.type === 'page' && target.url === appUrl).targetId;
    }
    const normalId = await openNormalApp();
    const normalSession = await cdp.attach(normalId);
    const command = (sessionId, message) => cdp.evaluate(sessionId,
      `browser.tabs.getCurrent().then(tab=>browser.runtime.sendMessage({...${JSON.stringify(message)},tabId:tab.id}))`);
    const state = async (sessionId) => {
      const result = await command(sessionId, { type: 'get-state' });
      assert.equal(result.ok, true, result.error);
      return result.state;
    };
    try {
      await until(() => cdp.evaluate(normalSession, 'typeof browser !== "undefined"'), Boolean, 'normal UI');
    } catch (error) {
      console.error(await cdp.evaluate(normalSession, '({url:location.href,title:document.title,text:document.body?.innerText,scripts:[...document.scripts].map(s=>s.src)})'));
      console.error(cdp.exceptions);
      console.error(await cdp.evaluate(managerSession, `new Promise(resolve=>chrome.developerPrivate.getExtensionInfo(${JSON.stringify(extensionId)},resolve))`));
      throw error;
    }
    await state(normalSession);
    await cdp.send('Network.setCookie', { name: 'session', value: 'normal', url: 'https://www.eporner.com/', secure: true }, normalSession);
    // Split extensions cannot inspect private tabs from their normal context.
    await cdp.evaluate(normalSession, `browser.windows.create({incognito:true,url:${JSON.stringify(appUrl)}}).then(()=>true)`);
    const privateTargets = await until(targets, (list) => list.some((target) => target.url === appUrl && target.targetId !== normalId), 'incognito UI');
    const privateTarget = privateTargets.find((target) => target.url === appUrl && target.targetId !== normalId);
    const privateSession = await cdp.attach(privateTarget.targetId);
    await until(() => cdp.evaluate(privateSession, 'typeof browser !== "undefined"'), Boolean, 'private API');
    const privateWindowId = await cdp.evaluate(privateSession, 'browser.tabs.getCurrent().then(tab=>tab.windowId)');
    await cdp.evaluate(privateSession, `browser.tabs.create({windowId:${privateWindowId},url:"https://www.eporner.com/keeper"}).then(()=>true)`);
    await cdp.send('Network.setCookie', { name: 'session', value: 'private', url: 'https://www.eporner.com/', secure: true }, privateSession);
    if (process.env.BRIDGE_ONLY === '1') {
      const coordinator = await normalWorkerSession();
      const fixtureHtml = '<h1>Fixture</h1><div id="hd-porn-dload"><a href="/dload/fixture/2160/clip-av1.mp4">2160</a></div>';
      let parsed;
      try { parsed = await cdp.evaluate(coordinator, `VideoDownloaderPlatform.parsePage(${JSON.stringify(fixtureHtml)},"https://www.eporner.com/video-fixture/title/",{},false)`); }
      catch (error) {
        console.error(await cdp.evaluate(coordinator, '({role:VideoDownloaderPlatform.role,url:location.href})'));
        console.error(await cdp.evaluate(coordinator, 'browser.runtime.getContexts({}).catch(error=>({error:error.message}))'));
        console.error((await targets()).map((target) => ({ type: target.type, url: target.url, id: target.targetId })));
        console.error(cdp.exceptions);
        throw error;
      }
      assert.equal(parsed.height, 2160);
      const oldEpoch = await cdp.evaluate(coordinator, 'browser.storage.session.get("vbdrPrivateControl").then(data=>data.vbdrPrivateControl.epoch)');
      await cdp.evaluate(coordinator, 'Promise.all([VideoDownloaderPlatform.downloads(false).download({url:"https://www.eporner.com/dload/normal/2160/clip.mp4",filename:"normal.mp4",saveAs:false}),VideoDownloaderPlatform.downloads(true).download({url:"https://www.eporner.com/dload/private/2160/clip.mp4",filename:"private.mp4",incognito:true,saveAs:false})])');
      assert.equal(transfers.find((transfer) => transfer.url.includes('private')).cookie, 'session=private');
      assert.equal(transfers.find((transfer) => transfer.url.includes('normal')).cookie, 'session=normal');
      const privateWorker = (await targets()).find((target) => target.type === 'service_worker' && target.url === workerTarget.url && target.browserContextId === privateTarget.browserContextId);
      const observer = await cdp.attach(privateTarget.targetId);
      await cdp.send('ServiceWorker.enable', {}, observer);
      await until(async () => [...cdp.versions.values()], (values) => values.some((value) => value.targetId === privateWorker.targetId), 'private worker version');
      const version = [...cdp.versions.values()].find((value) => value.targetId === privateWorker.targetId);
      await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId }, observer);
      assert.equal((await cdp.evaluate(coordinator, 'VideoDownloaderPlatform.downloads(true).search({})')).length, 1);
      assert.equal(await cdp.evaluate(coordinator, 'browser.storage.session.get("vbdrPrivateControl").then(data=>data.vbdrPrivateControl.epoch)'), oldEpoch);
      await until(async () => live, (count) => count === 0, 'fixture transfers finish');
      console.log('PASS: Chrome offscreen parsing, normal/private transfer cookies, private worker restart, and stable session epoch');
      return;
    }
    assert.equal((await state(privateSession)).incognito, true);
    console.log('PASS: normal and incognito UI and shared command bridge');
    const found = await Promise.all([
      command(normalSession, { type: 'find', input: 'https://www.eporner.com/video-normal1/title/\nhttps://www.eporner.com/video-normal2/title/' }),
      command(privateSession, { type: 'find', input: 'https://www.eporner.com/video-private1/title/\nhttps://www.eporner.com/video-private2/title/' }),
    ]);
    found.forEach((result) => assert.equal(result.ok, true, result.error));
    let normal = await until(() => state(normalSession), (value) => value.items.length === 2 && value.items.every((item) => item.state === 'ready'), 'normal discovery');
    let privateState = await until(() => state(privateSession), (value) => value.items.length === 2 && value.items.every((item) => item.state === 'ready'), 'private discovery');
    assert.ok(normal.items.every((item) => item.height === 2160 && item.codec === 'AV1'));
    assert.ok(pages.filter((page) => page.id.includes('normal')).every((page) => page.cookie === 'session=normal'));
    assert.ok(pages.filter((page) => page.id.includes('private')).every((page) => page.cookie === ''));
    console.log('PASS: real offscreen DOM parsing, quality choice, and cookie isolation');
    const backup = await command(privateSession, { type: 'export-backup' });
    assert.equal(backup.ok, true, backup.error);
    const data = JSON.parse(backup.state.exportText).data;
    assert.equal(data.normal.state.items.length, 2);
    assert.equal(data.private.state.items.length, 2);
    const restored = await command(privateSession, { type: 'restore-backup', text: backup.state.exportText });
    assert.equal(restored.ok, true, restored.error);
    normal = await state(normalSession);
    privateState = await state(privateSession);
    assert.equal(normal.items.length, 2);
    assert.equal(privateState.items.length, 2);
    console.log('PASS: full backup export and restore from incognito include both sessions');
    assert.equal((await command(normalSession, { type: 'concurrency', value: 2 })).ok, true);
    for (const [session, value] of [[normalSession, normal], [privateSession, privateState]]) {
      const result = await command(session, { type: 'download', batchId: value.batchId, saveAs: false,
        items: value.items.map((item) => ({ id: item.id, filename: item.filename })) });
      assert.equal(result.ok, true, result.error);
    }
    await until(() => state(normalSession), (value) => value.items.every((item) =>
      item.state === 'downloading' && Number.isInteger(item.downloadId) && item.downloadIdentity), 'verified downloads start');
    // Close both downloader pages while keeping an incognito window open.
    await cdp.send('Target.closeTarget', { targetId: normalId });
    await cdp.send('Target.closeTarget', { targetId: privateTarget.targetId });
    const version = [...cdp.versions.values()].find((value) => value.scriptURL === workerTarget.url && value.runningStatus === 'running' && value.sessionId === managerSession);
    assert.ok(version, 'Service worker lifecycle must be observable');
    await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId }, managerSession);
    await until(async () => transfers.length, (count) => count === 4, 'queue runs after UI closes', 40000);
    await until(async () => live, (count) => count === 0, 'all transfers complete', 20000);
    assert.ok(peak <= 2, `Global concurrency exceeded: ${peak}`);
    assert.equal(transfers.length, 4, 'No duplicate transfers');
    assert.ok(transfers.filter((transfer) => transfer.url.includes('normal')).every((transfer) => transfer.cookie === 'session=normal'));
    assert.ok(transfers.filter((transfer) => transfer.url.includes('private')).every((transfer) => transfer.cookie === 'session=private'));
    console.log('PASS: shared concurrency, worker restart with closed tabs, and private transfer cookies');
    const reopenedId = await openNormalApp();
    const reopened = await cdp.attach(reopenedId);
    await until(() => cdp.evaluate(reopened, 'typeof browser !== "undefined"'), Boolean, 'reopened UI');
    const saved = await until(() => state(reopened), (value) => value.items.every((item) => item.state === 'done'), 'saved history');
    assert.equal(saved.items.length, 2);
    console.log('PASS: normal saved history survives worker restart');
    const oldPrivateEpoch = await cdp.evaluate(reopened, 'browser.storage.session.get("vbdrPrivateControl").then(data=>data.vbdrPrivateControl.epoch)');
    for (const target of await targets()) {
      if (target.type === 'page' && target.browserContextId === privateTarget.browserContextId) {
        await cdp.send('Target.closeTarget', { targetId: target.targetId });
      }
    }
    // Reopening immediately must not expose the previous private list while
    // the normal watchdog is still waiting to detect the closed session.
    await cdp.evaluate(reopened, `browser.windows.create({incognito:true,url:${JSON.stringify(appUrl)}}).then(()=>true)`);
    const freshTarget = await until(async () => (await targets()).find((target) => target.type === 'page' && target.url === appUrl && target.targetId !== reopenedId), Boolean, 'fresh private tab');
    const freshSession = await cdp.attach(freshTarget.targetId);
    await until(() => cdp.evaluate(freshSession, 'typeof browser !== "undefined"'), Boolean, 'fresh private API');
    const freshState = await state(freshSession);
    assert.equal(freshState.items.length, 0, 'A new incognito session must start empty');
    assert.equal(freshState.input, '');
    assert.notEqual(await cdp.evaluate(reopened, 'browser.storage.session.get("vbdrPrivateControl").then(data=>data.vbdrPrivateControl.epoch)'), oldPrivateEpoch);
    assert.equal((await command(freshSession, { type: 'input', input: 'fresh private draft' })).ok, true);
    console.log('PASS: a new incognito session cannot inherit the previous private list');
    await cdp.send('Target.closeTarget', { targetId: freshTarget.targetId });
    console.log('Checking cleanup after closing all incognito tabs');
    // The last OTR worker can disappear before its closing marker is written.
    // Two unanswered watchdog probes then clear the memory-only leftovers.
    await until(() => cdp.evaluate(reopened, 'browser.storage.session.get(["privateDownloaderState","privateDownloaderDraft"]).then(data=>!data.privateDownloaderState&&!data.privateDownloaderDraft)'), Boolean, 'private data clears on last close', 120000);
    const local = await cdp.evaluate(reopened, 'browser.storage.local.get(null)');
    assert.ok(!JSON.stringify(local).includes('video-private'), 'Private data leaked into persistent local storage');
    console.log('PASS: saved history and private cleanup without persistent private data');
    console.log('Chrome smoke checks passed.');
  } finally {
    if (cdp) { try { await cdp.send('Browser.close'); } catch { } cdp.socket.close(); }
    if (chrome) { chrome.kill(); await delay(500); }
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    try { fs.rmSync(qaRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); }
    catch (error) { console.error(`Temporary test profile remains at ${qaRoot}: ${error.message}`); }
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
