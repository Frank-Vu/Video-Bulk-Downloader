/* Cross-browser runtime seam shared by Firefox and Chrome.
 *
 * background.js stays browser-neutral and talks to this object for the few
 * places where the two runtimes genuinely differ:
 *
 *  - parsePage: Firefox parses with DOMParser in its background context; a
 *    Chrome service worker has no DOM, so it asks the offscreen document
 *    ({target: 'video-parser'} message, {ok, value} reply).
 *  - downloads(incognito): routes downloads API calls. Chrome split mode
 *    cannot see private downloads from the normal worker, so private calls
 *    cross the chrome-bridge to the incognito worker. Chrome download options
 *    carry no incognito flag; Firefox's do.
 *  - privateSessionOpen / onPrivateSessionEnd: portable "is a private session
 *    active" status and the "the private session ended" trigger.
 *  - runTask: keeps a Chrome service worker alive during bounded work (page
 *    lookups, backoff, bridge round trips) without any keep-alive while idle.
 *  - onAlarmWake: Chrome alarms resume pending discovery and reconciliation
 *    after the service worker has been terminated.
 *
 * Loaded before background.js on both browsers, and before chrome-bridge.js in
 * the Chrome service worker. Everything degrades to plain direct calls when
 * the bridge is absent (Firefox always).
 */
(() => {
  const api = globalThis.browser;
  const nativeChrome = globalThis.chrome;
  const isChrome = typeof globalThis.VideoDownloaderBrowser?.isChrome === 'boolean'
    ? globalThis.VideoDownloaderBrowser.isChrome
    : !(api?.runtime?.getURL && String(api.runtime.getURL('')).startsWith('moz-extension:'));
  // Chrome split mode gives the private windows their own service worker.
  // Firefox keeps a single background context, so it always runs "normal".
  const inIncognitoContext = (() => {
    try { return api?.extension?.inIncognitoContext === true; } catch { return false; }
  })();
  const role = isChrome && inIncognitoContext ? 'incognito' : 'normal';
  const wakeHandlers = [];
  let commandDispatcher = null;
  const downloadEventHandlers = {};

  // User-facing messages stay browser-neutral; only the private-enable
  // instruction names the exact place to flip in each browser.
  const messages = {
    privateAccess: isChrome
      ? 'Allow this extension to run in Incognito on its details page in chrome://extensions, then retry.'
      : "Allow this extension to run in private windows in Firefox's Add-ons Manager, then retry.",
    privateWindow: isChrome ? 'Keep a private Chrome window open while downloading.' : 'Keep a private Firefox window open while downloading.',
    downloadMissing: 'This download no longer exists. Retry this file.',
    verifyFailed: 'Previous download could not be verified. Retry this file.',
    checkDownloads: 'Could not check downloads. Retry this action.',
    showUnsupported: 'Showing files is not supported in this browser.',
    pauseUnsupported: 'Pausing downloads is not supported in this browser.',
    resumeUnsupported: 'Resuming downloads is not supported in this browser.',
    privateChannelLost: 'The private session did not answer. Keep a private window open, then retry.',
    outcomeUnknown: "The private transfer could not be verified. Check the browser's downloads before retrying this file.",
  };

  function stripIncognitoOption(options) {
    if (!isChrome || !options || typeof options !== 'object') return options;
    const copy = { ...options };
    delete copy.incognito;
    return copy;
  }

  /* ---- parsing -------------------------------------------------------- */

  // The offscreen reply is {ok: true, value} or {ok: false, error,
  // availableHeights}. The value mirrors the shared parser: {thumbnail} for a
  // thumbnail-only lookup, the parseVideoPage record otherwise.
  let parserCreation = null;
  function offscreenParse(payload) {
    if (!parserCreation) {
      parserCreation = (async () => {
        const contexts = await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'],
          documentUrls: [api.runtime.getURL('offscreen.html')] });
        if (!contexts.length) await api.offscreen.createDocument({
          url: 'offscreen.html', reasons: ['DOM_PARSER'],
          justification: 'Parse downloaded video pages with a DOM.',
        });
      })().finally(() => { parserCreation = null; });
    }
    return parserCreation.then(() => api.runtime.sendMessage(payload));
  }

  function parsePage(text, baseUrl, quality, thumbnailOnly) {
    // Firefox (and any context with a DOM) parses directly.
    if (typeof globalThis.DOMParser === 'function') {
      return Promise.resolve()
        .then(() => (thumbnailOnly
          ? { thumbnail: VideoDownloader.parseThumbnail(text, baseUrl) }
          : VideoDownloader.parseVideoPage(text, baseUrl, quality)));
    }
    return offscreenParse({ target: 'video-parser', text, baseUrl, quality, thumbnailOnly: thumbnailOnly === true })
      .then((response) => {
        if (!response || response.ok !== true) {
          const error = new Error(response?.error || 'Video page parsing failed. Retry this file.');
          if (response?.availableHeights) error.availableHeights = response.availableHeights;
          throw error;
        }
        const value = response.value;
        if (thumbnailOnly) {
          // Accept both the raw parser string and the wrapped {thumbnail}.
          return { thumbnail: typeof value === 'string' ? value : (value && value.thumbnail) || '' };
        }
        return value;
      });
  }

  /* ---- service worker keep-alive ------------------------------------- */

  // Chrome terminates an idle service worker after about 30 seconds. During
  // bounded work (page lookups, backoff sleeps, bridge round trips, Save As
  // dialogs) a light extension API call keeps it alive; nothing runs while
  // the extension is idle.
  function runTask(work) {
    if (!isChrome) return Promise.resolve().then(work);
    let timer = null;
    const beat = () => {
      try {
        if (nativeChrome?.runtime?.getPlatformInfo) nativeChrome.runtime.getPlatformInfo(() => { });
        else if (api?.runtime?.getPlatformInfo) void Promise.resolve(api.runtime.getPlatformInfo()).catch(() => { });
      } catch { /* Keep-alive is best effort. */ }
    };
    timer = setInterval(beat, 20000);
    beat();
    return Promise.resolve().then(work).finally(() => { clearInterval(timer); timer = null; });
  }

  /* ---- downloads routing --------------------------------------------- */

  function localDownloads() {
    const dl = api.downloads;
    return {
      search: (query) => dl.search(query),
      download: (options) => dl.download(stripIncognitoOption(options)),
      cancel: (id) => dl.cancel(id),
      pause: typeof dl.pause === 'function' ? (id) => dl.pause(id) : undefined,
      resume: typeof dl.resume === 'function' ? (id) => dl.resume(id) : undefined,
      // downloads.show is synchronous in every Chrome version; never wrap it.
      show: typeof dl.show === 'function' ? (id) => dl.show(id) : undefined,
    };
  }

  function privateDownloads() {
    const bridge = globalThis.VideoDownloaderBridge;
    if (!bridge || typeof bridge.downloadOp !== 'function') {
      const fail = () => Promise.reject(new Error(messages.privateChannelLost));
      return { search: fail, download: fail, cancel: fail, pause: fail, resume: fail, show: fail };
    }
    const op = (name) => (...args) => bridge.downloadOp(name, args);
    const dl = api.downloads;
    return {
      search: op('search'),
      download: op('download'),
      cancel: op('cancel'),
      pause: typeof dl.pause === 'function' ? op('pause') : undefined,
      resume: typeof dl.resume === 'function' ? op('resume') : undefined,
      show: typeof dl.show === 'function' ? op('show') : undefined,
    };
  }

  // Chrome split: the normal worker cannot reach private downloads at all, so
  // every private call is proxied to the incognito worker. Firefox serves both
  // sessions from one background and passes its incognito download option.
  function downloads(incognito) {
    if (isChrome && incognito === true) return privateDownloads();
    return localDownloads();
  }

  async function searchAllDownloads(query) {
    const normal = await localDownloads().search(query);
    if (!isChrome || !await privateSessionOpen()) return normal;
    const privateRecords = await privateDownloads().search(query);
    return [...new Map([...normal, ...privateRecords].map((record) => [record.id, record])).values()];
  }

  /* ---- private session status ---------------------------------------- */

  async function privateSessionOpen() {
    if (!isChrome) {
      const windows = await api.windows.getAll();
      return windows.some((window) => window.incognito === true);
    }
    const bridge = globalThis.VideoDownloaderBridge;
    if (!bridge || typeof bridge.privateSessionOpen !== 'function') return false;
    return bridge.privateSessionOpen();
  }

  // The handler runs when the private session is over (or its leftovers must
  // be dropped); it does not re-check whether one is open.
  function onPrivateSessionEnd(handler) {
    if (!isChrome && api?.windows?.onRemoved?.addListener) {
      api.windows.onRemoved.addListener(() => {
        void Promise.resolve()
          .then(() => privateSessionOpen())
          .then((open) => { if (!open) return handler(); })
          .catch((error) => console.error('Video Bulk Downloader:', error));
      });
    }
    const bridge = globalThis.VideoDownloaderBridge;
    if (bridge && typeof bridge.onPrivateSessionEnd === 'function') bridge.onPrivateSessionEnd(handler);
  }

  /* ---- wake-ups and bridge hooks -------------------------------------- */

  function onAlarmWake(handler) { wakeHandlers.push(handler); }

  if (isChrome && api?.alarms?.onAlarm?.addListener) {
    api.alarms.onAlarm.addListener((alarm) => {
      if (!alarm || alarm.name !== 'vbdr-wake') return;
      for (const handler of wakeHandlers.slice()) {
        try { void handler(); } catch (error) { console.error('Video Bulk Downloader:', error); }
      }
    });
    if (role === 'normal' && typeof api.alarms.create === 'function') {
      // Periodic reconciliation: wake pending discovery, restart recovery and
      // private-session checks even when every UI page is closed.
      try { void Promise.resolve(api.alarms.create('vbdr-wake', { periodInMinutes: 0.5 })).catch(() => { }); }
      catch { /* Alarms are optional. */ }
    }
  }

  function setCommandDispatcher(dispatcher) { commandDispatcher = dispatcher; }
  function dispatchCommand(message, sender) {
    if (!commandDispatcher) return Promise.reject(new Error('The downloader is still starting. Retry this action.'));
    return Promise.resolve().then(() => commandDispatcher(message, sender));
  }

  function setDownloadEventHandler(kind, handler) {
    if (typeof handler === 'function') downloadEventHandlers[kind] = handler;
  }
  function dispatchDownloadEvent(kind, args) {
    const handler = downloadEventHandlers[kind];
    if (!handler) return Promise.resolve();
    return Promise.resolve().then(() => handler(...args));
  }

  globalThis.VideoDownloaderPlatform = Object.freeze({
    isChrome, role, messages,
    parsePage, runTask, downloads, searchAllDownloads, privateSessionOpen, onPrivateSessionEnd,
    onAlarmWake, setCommandDispatcher, dispatchCommand,
    setDownloadEventHandler, dispatchDownloadEvent,
  });
})();
