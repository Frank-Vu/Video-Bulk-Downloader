/* Keep the shared application on the Promise-based WebExtensions API. */
(() => {
  const nativeBrowser = globalThis.browser;
  const firefox = nativeBrowser?.runtime?.getURL('').startsWith('moz-extension:') === true;
  globalThis.VideoDownloaderBrowser = { isChrome: !firefox };
  if (firefox) return;
  const api = globalThis.chrome;
  if (!api?.runtime) throw new Error('Open this page through the browser extension.');

  function promiseMethod(owner, name) {
    return (...args) => new Promise((resolve, reject) => {
      try {
        owner[name](...args, (value) => {
          const error = api.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(value);
        });
      } catch (error) { reject(error); }
    });
  }

  const listenerWrappers = new Map();
  const onMessage = {
    addListener(listener) {
      if (listenerWrappers.has(listener)) return;
      const wrapper = (message, sender, sendResponse) => {
        const response = listener(message, sender, sendResponse);
        if (!response || typeof response.then !== 'function') return response;
        response.then(sendResponse, (error) => sendResponse({ ok: false, error: error.message || String(error) }));
        return true;
      };
      listenerWrappers.set(listener, wrapper);
      api.runtime.onMessage.addListener(wrapper);
    },
    removeListener(listener) {
      const wrapper = listenerWrappers.get(listener);
      if (wrapper) api.runtime.onMessage.removeListener(wrapper);
      listenerWrappers.delete(listener);
    },
    hasListener(listener) { return listenerWrappers.has(listener); },
  };

  function namespace(owner, methods, synchronous = []) {
    if (!owner) return undefined;
    const result = {};
    for (const key of Object.keys(owner)) {
      if (typeof owner[key] !== 'function') result[key] = owner[key];
    }
    for (const name of methods) if (typeof owner[name] === 'function') result[name] = promiseMethod(owner, name);
    for (const name of synchronous) if (typeof owner[name] === 'function') result[name] = owner[name].bind(owner);
    return result;
  }
  const browserApi = {
    runtime: namespace(api.runtime, ['sendMessage', 'getPlatformInfo', 'getContexts'], ['getURL', 'getManifest']),
    tabs: namespace(api.tabs, ['get', 'getCurrent', 'query', 'create', 'update']),
    windows: namespace(api.windows, ['getAll', 'get', 'create', 'remove', 'update']),
    downloads: namespace(api.downloads, ['download', 'search', 'cancel', 'pause', 'resume'], ['show']),
    permissions: namespace(api.permissions, ['contains', 'request']),
    extension: namespace(api.extension, ['isAllowedIncognitoAccess']),
    action: namespace(api.action, []),
    alarms: namespace(api.alarms, ['create', 'get', 'getAll', 'clear']),
    // Offscreen methods are Promise-only and do not accept callbacks.
    offscreen: namespace(api.offscreen, [], ['createDocument', 'closeDocument', 'hasDocument']),
    storage: api.storage ? {
      local: namespace(api.storage.local, ['get', 'set', 'remove', 'clear']),
      session: namespace(api.storage.session, ['get', 'set', 'remove', 'clear']),
      onChanged: api.storage.onChanged,
    } : undefined,
  };
  browserApi.runtime.onMessage = onMessage;
  globalThis.browser = browserApi;
})();
