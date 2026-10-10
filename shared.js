/* Shared by the background page and downloader UI. */
globalThis.VideoDownloader = (() => {
  const CONCURRENCY = 3;
  const MAX_CONCURRENCY = 10;
  const SUBFOLDER = "Video Bulk Downloads";
  const STORAGE_KEY = "downloaderState";
  const PRIVATE_STORAGE_KEY = "privateDownloaderState";
  const DRAFT_STORAGE_KEY = "downloaderDraft";
  const PRIVATE_DRAFT_STORAGE_KEY = "privateDownloaderDraft";

  const ACTION_ICONS = {
    "pencil": [{ "tag": "path", "attrs": { "d": "m16 3 5 5-12 12-6 1 1-6L16 3zm-3 3 5 5M3 21h6" } }],
    "search": [
      {
        "tag": "circle",
        "attrs": {
          "cx": "10.5",
          "cy": "10.5",
          "r": "6.5"
        }
      },
      {
        "tag": "path",
        "attrs": {
          "d": "m16 16 5 5"
        }
      }
    ],
    "download": [
      {
        "tag": "path",
        "attrs": {
          "d": "M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"
        }
      }
    ],
    "retry": [
      {
        "tag": "path",
        "attrs": {
          "d": "M4 10a8 8 0 1 1 1 7M4 3v7h7"
        }
      }
    ],
    "cancel": [
      {
        "tag": "circle",
        "attrs": {
          "cx": "12",
          "cy": "12",
          "r": "9"
        }
      },
      {
        "tag": "path",
        "attrs": {
          "d": "m8 8 8 8m0-8-8 8"
        }
      }
    ],
    "trash": [
      {
        "tag": "path",
        "attrs": {
          "d": "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"
        }
      }
    ],
    "clear": [
      {
        "tag": "path",
        "attrs": {
          "d": "m4 14 9-11 8 7-9 11H7l-3-3zm4-5 8 7M12 21h9"
        }
      }
    ],
    "export": [
      {
        "tag": "path",
        "attrs": {
          "d": "M14 3h7v7m-1-6-10 10M10 4H4v16h16v-6"
        }
      }
    ],
    "import": [
      {
        "tag": "path",
        "attrs": {
          "d": "M6 8V2h8l6 6v14H6v-6M14 2v6h6M2 12h12m-4-4 4 4-4 4"
        }
      }
    ],
    "pause": [
      {
        "tag": "path",
        "attrs": {
          "d": "M9 5v14M15 5v14"
        }
      }
    ],
    "play": [
      {
        "tag": "path",
        "attrs": {
          "d": "M8 5v14l11-7z"
        }
      }
    ],
    "folder": [
      {
        "tag": "path",
        "attrs": {
          "d": "M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
        }
      }
    ]
  };

  function createActionIcon(doc, name) {
    const shapes = ACTION_ICONS[name];
    if (!shapes) throw new Error(`Unknown action icon: ${name}`);
    const namespace = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(namespace, "svg");
    const attributes = {
      viewBox: "0 0 24 24", width: "18", height: "18",
      class: "action-icon", fill: "none", stroke: "currentColor", "stroke-width": "1.8",
      "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false"
    };
    for (const [key, value] of Object.entries(attributes)) svg.setAttribute(key, value);
    for (const shape of shapes) {
      const node = doc.createElementNS(namespace, shape.tag);
      for (const [key, value] of Object.entries(shape.attrs)) node.setAttribute(key, value);
      svg.append(node);
    }
    return svg;
  }

  function normalizePageUrl(value) {
    const url = new URL(value.trim());
    if (!/^https?:$/.test(url.protocol) ||
      !["eporner.com", "www.eporner.com"].includes(url.hostname) ||
      url.port || url.username || url.password ||
      !/^\/video-[^/]+(?:\/|$)/.test(url.pathname)) {
      throw new Error("Use video page URLs.");
    }
    url.protocol = "https:";
    url.hostname = "www.eporner.com";
    url.hash = "";
    return url.href;
  }

  function sanitize(name) {
    let result = String(name)
      .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[. ]+/, "")
      .slice(0, 180)
      .replace(/[. ]+$/, "");
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = `_${result}`;
    return result;
  }

  function fileBasename(value) {
    const name = sanitize(String(value ?? "").trim().replace(/\.mp4$/i, ""));
    if (!name) throw new Error("Every selected file needs a name.");
    return name;
  }

  function normalizeQualityOptions(options) {
    const input = options && typeof options === "object" ? options : {};
    let maxHeight = 0;
    const rawHeight = input.maxHeight;
    if (rawHeight !== undefined && rawHeight !== null && rawHeight !== "") {
      if (typeof rawHeight === "number") {
        maxHeight = Number.isFinite(rawHeight) && rawHeight > 0 ? Math.floor(rawHeight) : 0;
      } else if (typeof rawHeight === "string" && rawHeight.trim() !== "") {
        const parsed = Number(rawHeight.trim());
        maxHeight = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
      } else {
        maxHeight = 0;
      }
    }
    let preferredCodec = "AV1";
    if (typeof input.preferredCodec === "string") {
      const compact = input.preferredCodec.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      if (compact === "H264") preferredCodec = "H.264";
      else if (compact === "AV1") preferredCodec = "AV1";
    }
    return { maxHeight, preferredCodec };
  }

  function thumbnailUrl(value, baseUrl) {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
      const url = new URL(value, baseUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !(url.hostname === 'eporner.com' || url.hostname.endsWith('.eporner.com'))) return '';
      return url.href;
    } catch { return ''; }
  }

  function thumbnailFromDocument(doc, baseUrl) {
    for (const [selector, attribute] of [
      ['meta[property="og:image"]', 'content'], ['meta[name="twitter:image"]', 'content'], ['video[poster]', 'poster']
    ]) {
      const url = thumbnailUrl(doc.querySelector(selector)?.getAttribute?.(attribute), baseUrl);
      if (url) return url;
    }
    return '';
  }

  function parseThumbnail(html, baseUrl) {
    return thumbnailFromDocument(new DOMParser().parseFromString(html, 'text/html'), baseUrl);
  }

  function parseVideoPage(html, baseUrl, options) {
    const { maxHeight, preferredCodec } = normalizeQualityOptions(options);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const links = [];
    for (const a of doc.querySelectorAll("#hd-porn-dload a[href*='/dload/']")) {
      let url;
      try { url = new URL(a.getAttribute("href"), baseUrl); } catch { continue; }
      const match = url.pathname.match(/^\/dload\/[^/]+\/(\d+)\/[^/]+\.mp4$/);
      if (!match || url.origin !== "https://www.eporner.com" || url.username || url.password) continue;
      links.push({
        url: url.href, height: Number(match[1]),
        codec: /-av1\.mp4$/i.test(url.pathname) ? "AV1" : "H.264"
      });
    }
    if (!links.length) throw new Error("No download links found. Log in to the site in Firefox, then retry.");
    const availableHeights = [...new Set(links.map((link) => link.height).filter((height) => height >= 480))]
      .sort((a, b) => b - a);
    const exactHeight = options?.exactHeight;
    const allowed = exactHeight ? links.filter((link) => link.height === exactHeight)
      : maxHeight > 0 ? links.filter((link) => link.height <= maxHeight) : links;
    if (!allowed.length) {
      const error = new Error(exactHeight ? `${exactHeight}p is no longer available. Check qualities and choose another resolution.`
        : `No download links at or below ${maxHeight}p. Choose a higher quality limit, then retry.`);
      error.availableHeights = availableHeights;
      throw error;
    }
    allowed.sort((a, b) => b.height - a.height || Number(b.codec === preferredCodec) - Number(a.codec === preferredCodec));
    const h1 = doc.querySelector("h1");
    const title = h1 ? [...h1.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent).join("").trim() : "";
    return { ...allowed[0], title: title || baseUrl, availableHeights, thumbnail: thumbnailFromDocument(doc, baseUrl) };
  }

  function normalizeConcurrency(value) {
    return Number.isInteger(value) && value >= 1 && value <= MAX_CONCURRENCY ? value : CONCURRENCY;
  }

  function normalizeNaming(naming) {
    if (!naming || typeof naming !== 'object' || Array.isArray(naming)) return null;
    const authors = Array.isArray(naming.authors) ? naming.authors : naming.author ? [naming.author] : [];
    const selected = [...new Set(authors.filter((name) => typeof name === 'string' && name.trim()))];
    return {
      authors: selected, author: selected.join(' & '),
      channel: typeof naming.channel === 'string' ? naming.channel : '',
      videoTitle: typeof naming.videoTitle === 'string' ? naming.videoTitle : ''
    };
  }

  function nameTagLibrary(tags) {
    const merge = (names) => [...new Map(names.filter((name) => typeof name === 'string' && name.trim())
      .map((name) => [name.toLowerCase(), name])).values()];
    return {
      author: merge(Array.isArray(tags?.author) ? tags.author : []),
      channel: merge(Array.isArray(tags?.channel) ? tags.channel : [])
    };
  }

  function structuredFilename({ author, videoTitle, channel }) {
    const title = String(videoTitle || '').trim();
    if (!title) throw new Error('Enter a video title.');
    const prefix = String(author || '').trim();
    const suffix = String(channel || '').trim();
    const ending = suffix ? ` [${sanitize(suffix).slice(0, 60)}]` : '';
    const beginning = prefix ? `${sanitize(`${prefix} -`)} ` : '';
    if (beginning.length + ending.length >= 180) throw new Error('Choose fewer or shorter tags to leave room for a video title.');
    const base = sanitize(`${prefix ? `${prefix} - ` : ''}${title}`).slice(0, 180 - ending.length).trim();
    return fileBasename(`${base}${ending}`);
  }

  function filenameTitle(item, filename = item.filename) {
    let title = String(filename || '').trim().replace(/\.mp4$/i, '');
    const naming = normalizeNaming(item.naming);
    if (naming) {
      const prefix = naming.author ? `${sanitize(naming.author)} - ` : '';
      const suffix = naming.channel ? ` [${sanitize(naming.channel).slice(0, 60)}]` : '';
      if (prefix && title.startsWith(prefix)) title = title.slice(prefix.length);
      if (suffix && title.endsWith(suffix)) title = title.slice(0, -suffix.length);
    } else if (item.title && title === sanitize(`${item.title} [${item.height}p ${item.codec}]`)) {
      title = item.title;
    }
    return title.trim();
  }

  function selectedNameTags(item) {
    const naming = normalizeNaming(item.naming);
    return { authors: naming?.authors || [], channel: naming?.channel || '' };
  }

  function nameTagOptions(state, item, kind) {
    const selected = item ? selectedNameTags(item) : { authors: [], channel: '' };
    return [...new Set([...(nameTagLibrary(state.namingPresets)[kind] || []),
    ...(kind === 'author' ? selected.authors : selected.channel ? [selected.channel] : [])])];
  }

  function normalizeNameTags(tags) {
    if (!tags || typeof tags !== 'object' || Array.isArray(tags)) throw new Error('Import author and channel tag lists.');
    const result = {};
    for (const kind of ['author', 'channel']) {
      if (!Array.isArray(tags[kind])) throw new Error(`The ${kind} tags must be a list of names.`);
      const names = new Map();
      for (const raw of tags[kind]) {
        if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 100) throw new Error('Each tag must contain 1 to 100 characters.');
        const name = raw.trim().replace(/\s+/g, ' ');
        if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
      }
      if (names.size > 100) throw new Error('Keep up to 100 reusable tags of each type.');
      result[kind] = [...names.values()];
    }
    return result;
  }

  function exportNameTags(tags, format) {
    const normalized = normalizeNameTags(nameTagLibrary(tags));
    if (format === 'json') return JSON.stringify({
      format: 'video-bulk-downloader-name-tags', version: 1,
      ...normalized
    }, null, 2);
    const escape = (name) => /^(?:\\|\[(?:authors|channels)\]$)/i.test(name) ? `\\${name}` : name;
    if (format === 'txt') return ['[Authors]', ...normalized.author.map(escape), '', '[Channels]', ...normalized.channel.map(escape), ''].join('\n');
    throw new Error('Choose JSON or TXT.');
  }

  function parseNameTags(text, format) {
    if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('Import a tag file smaller than 1 MiB.');
    text = text.replace(/^\uFEFF/, '');
    let tags;
    if (format === 'json') {
      try { tags = JSON.parse(text); } catch { throw new Error('This is not valid JSON.'); }
      if (tags?.format !== 'video-bulk-downloader-name-tags' || tags.version !== 1) throw new Error('Import a Video Bulk Downloader reusable tags JSON export.');
      const { author, channel } = tags;
      if (!Array.isArray(author) || !Array.isArray(channel)) throw new Error('Import author and channel tag lists.');
      tags = { author, channel };
    } else if (format === 'txt') {
      tags = { author: [], channel: [] };
      let kind;
      for (const line of text.split(/\r?\n/)) {
        const name = line.trim();
        if (!name) continue;
        if (name.toLowerCase() === '[authors]') kind = 'author';
        else if (name.toLowerCase() === '[channels]') kind = 'channel';
        else {
          if (!kind) throw new Error('TXT tags need [Authors] and [Channels] section headings.');
          tags[kind].push(name.startsWith('\\') ? name.slice(1) : name);
        }
      }
    } else throw new Error('Choose JSON or TXT.');
    const result = normalizeNameTags(tags);
    if (!result.author.length && !result.channel.length) throw new Error('The file contains no reusable tags.');
    return result;
  }

  const BACKUP_MAX_BYTES = 50 * 1024 * 1024;
  function parseBackup(text) {
    if (typeof text !== 'string' || text.length > BACKUP_MAX_BYTES) throw new Error('Choose a JSON backup smaller than 50 MiB.');
    let backup;
    try { backup = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('This is not valid JSON.'); }
    if (backup?.format !== 'video-bulk-downloader-backup' || backup.version !== 1) throw new Error('Choose a whole-extension JSON backup.');
    const result = {};
    const allIds = new Set();
    for (const [section, incognito] of [['normal', false], ['private', true]]) {
      const data = backup.data?.[section], state = data?.state, draft = data?.draft;
      if (!state || state.schemaVersion !== 3 || !Array.isArray(state.items) ||
        !Number.isSafeInteger(state.revision) || state.revision < 0 || state.revision >= Number.MAX_SAFE_INTEGER - 2 ||
        typeof draft?.input !== 'string' || !Number.isSafeInteger(draft.inputRevision) || draft.inputRevision < 0 ||
        draft.inputRevision >= Number.MAX_SAFE_INTEGER - 2) {
        throw new Error(`The ${section} session in this backup is invalid.`);
      }
      if (state.concurrency !== undefined && normalizeConcurrency(state.concurrency) !== state.concurrency) throw new Error('The backup has an invalid concurrency setting.');
      if (state.namingPresets !== undefined) {
        if (!state.namingPresets || typeof state.namingPresets !== 'object' || Array.isArray(state.namingPresets)) throw new Error('The backup contains invalid reusable tags.');
        if (Object.keys(state.namingPresets).some(kind => !['author', 'channel'].includes(kind))) throw new Error('The backup contains unsupported reusable tag fields.');
        for (const kind of ['author', 'channel']) {
          const tags = state.namingPresets?.[kind];
          if (tags !== undefined && (!Array.isArray(tags) || tags.length > 100 || tags.some(name => typeof name !== 'string' || !name.trim() || name.length > 1000))) {
            throw new Error('The backup contains invalid reusable tags.');
          }
        }
      }
      const ids = new Set();
      const items = state.items.filter(raw => !raw?.removeRequested).map((raw) => {
        if (!raw || typeof raw.id !== 'string' || !raw.id || ids.has(raw.id) || allIds.has(raw.id) || typeof raw.filename !== 'string' ||
          (raw.history !== undefined && (!Array.isArray(raw.history) || raw.history.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry)))) ||
          !['finding', 'ready', 'queued', 'downloading', 'cancelling', 'cancelled', 'done', 'failed', 'error'].includes(raw.state)) {
          throw new Error(`The ${section} session contains an invalid video.`);
        }
        ids.add(raw.id); allIds.add(raw.id);
        if (raw.availableHeights !== undefined && (!Array.isArray(raw.availableHeights) ||
          raw.availableHeights.some(height => !Number.isInteger(height) || height < 480 || height > 16384))) {
          throw new Error('The backup contains invalid video qualities.');
        }
        let pageUrl;
        try { pageUrl = normalizePageUrl(raw.pageUrl); } catch { throw new Error('The backup contains an invalid video page URL.'); }
        const item = {
          ...raw, pageUrl, incognito, history: (raw.history || []).map(entry => {
            const copy = { ...entry }; delete copy.downloadId; return copy;
          })
        };
        if (item.naming) item.naming = normalizeNaming(item.naming);
        item.thumbnail = thumbnailUrl(item.thumbnail, pageUrl);
        if (['finding', 'queued', 'downloading', 'cancelling'].includes(item.state)) {
          item.state = 'cancelled'; item.selected = false;
        }
        // Transfer IDs and fresh media links belong to the originating Firefox
        // session. Restoring them must never start or control any transfer.
        for (const key of ['downloadId', 'downloadIdentity', 'url', 'attempt', 'startedAt', 'queuedAt', 'cancelRequested',
          'removeRequested', 'resuming', 'resumeError', 'progress', 'refresh', 'qualityLookup']) delete item[key];
        return item;
      });
      const quality = normalizeQualityOptions(state);
      const restored = {
        ...state, ...quality, incognito, concurrency: normalizeConcurrency(state.concurrency),
        saveAs: state.saveAs === true, input: draft.input, inputRevision: draft.inputRevision, items
      };
      if (state.namingPresets) restored.namingPresets = nameTagLibrary(state.namingPresets);
      if (state.importTask) {
        if (!Array.isArray(state.importTask.ids) || !['found', 'saved'].includes(state.importTask.section)) throw new Error('The backup has invalid import progress.');
        restored.importTask = { ...state.importTask, ids: [], completed: state.importTask.total ?? state.importTask.ids.length };
      }
      result[section] = { state: restored, draft: { ...draft } };
    }
    result.exportedAt = typeof backup.exportedAt === 'string' ? backup.exportedAt : '';
    return result;
  }

  function backupSummary(backup) {
    const summary = {};
    for (const section of ['normal', 'private']) {
      const state = backup[section].state, tags = nameTagLibrary(state.namingPresets);
      summary[section] = {
        videos: state.items.length, saved: state.items.filter(isSaved).length,
        authors: tags.author.length, channels: tags.channel.length, hasDraft: Boolean(backup[section].draft.input),
        hasData: state.items.length > 0 || Boolean(backup[section].draft.input) || tags.author.length > 0 || tags.channel.length > 0 ||
          state.saveAs === true || state.maxHeight > 0 || state.preferredCodec !== 'AV1'
      };
    }
    return { ...summary, exportedAt: backup.exportedAt, concurrency: backup.normal.state.concurrency };
  }

  let lastExportTime = 0;
  function exportFilename(section, format, incognito, now = Date.now()) {
    lastExportTime = Math.max(now, lastExportTime + 1);
    const stamp = new Date(lastExportTime).toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
    return `${section}-videos${incognito ? '-private' : ''}-${stamp}.${format}`;
  }

  function importStatus(state) {
    const task = state.importTask;
    if (!task) return null;
    const pending = new Set(task.ids);
    let remaining = 0, failed = 0;
    for (const item of state.items) if (pending.has(item.id)) {
      if (item.state === 'finding') remaining++;
      if (item.state === 'error') failed++;
    }
    return {
      ...task, completed: (task.completed || 0) + task.ids.length - remaining,
      total: task.total ?? task.ids.length, failed: (task.failed || 0) + failed, busy: remaining > 0
    };
  }

  function parsePastedUrls(text) {
    const urls = [];
    const invalid = [];
    const seen = new Set();
    let duplicateCount = 0;
    if (typeof text !== "string" || !text) return { urls, invalid, duplicateCount };
    for (const token of text.split(/\s+/)) {
      if (!token) continue;
      let normalized;
      try { normalized = normalizePageUrl(token); }
      catch { invalid.push(token); continue; }
      const key = videoKey(normalized);
      if (seen.has(key)) { duplicateCount++; continue; }
      seen.add(key);
      urls.push(normalized);
    }
    return { urls, invalid, duplicateCount };
  }

  function isVideoResponse(mime) {
    const type = (mime || "").split(";", 1)[0].trim().toLowerCase();
    // Some media servers omit a type or use a generic binary type.
    return !type || type.startsWith("video/") ||
      ["application/mp4", "application/octet-stream", "binary/octet-stream"].includes(type);
  }

  function isBusy(items) {
    return items.some((item) => ["finding", "queued", "downloading", "cancelling"].includes(item.state));
  }

  function isSelectable(item) {
    return ["ready", "failed", "error", "cancelled", "done"].includes(item.state);
  }

  function videoKey(pageUrl) {
    return new URL(pageUrl).pathname.match(/^\/video-([^/]+)/)?.[1] || pageUrl;
  }

  function isSaved(item) {
    return item.saved === true || item.state === "done" || Boolean(item.history?.length);
  }

  function exportList(items, section, format) {
    const entries = items.filter((item) => !item.removeRequested && isSaved(item) === (section === "saved"));
    if (format === "txt") return entries.map((item) => item.pageUrl).join("\n") + (entries.length ? "\n" : "");
    if (format !== "json") throw new Error("Choose JSON or TXT.");
    const records = entries.map((item) => ({
      pageUrl: item.pageUrl, title: item.title || "", thumbnail: thumbnailUrl(item.thumbnail, item.pageUrl),
      filename: item.filename || "", height: item.height, codec: item.codec,
      qualityHeight: item.qualityHeight ?? null, naming: normalizeNaming(item.naming),
      history: (item.history || []).map((entry) => ({
        savedAt: entry.savedAt || null,
        filename: String(entry.filename || "").split(/[\\/]/).pop(), height: entry.height,
        codec: entry.codec, bytesReceived: entry.bytesReceived, totalBytes: entry.totalBytes
      }))
    }));
    return JSON.stringify({
      format: "video-bulk-downloader", version: 1, section,
      exportedAt: new Date().toISOString(), items: records
    }, null, 2);
  }

  function parseList(text, format, section) {
    if (!["found", "saved"].includes(section)) throw new Error("Choose a found or saved list.");
    if (typeof text !== "string" || text.length > 5 * 1024 * 1024) throw new Error("Import a file smaller than 5 MiB.");
    let entries;
    if (format === "txt") entries = text.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    else if (format === "json") {
      let data;
      try { data = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { throw new Error("This is not valid JSON."); }
      if (data?.format !== "video-bulk-downloader" || data.version !== 1 || !Array.isArray(data.items)) {
        throw new Error("Import a Video Bulk Downloader JSON export.");
      }
      if (data.section !== section) throw new Error(`This file belongs to the ${data.section} section. Use that section's Import button.`);
      entries = data.items;
    } else throw new Error("Choose a JSON or TXT file.");
    if (!entries.length || entries.length > 10000) throw new Error("Import between 1 and 10,000 videos.");
    const result = new Map();
    for (const [index, raw] of entries.entries()) {
      const entry = typeof raw === "string" ? { pageUrl: raw } : raw;
      let pageUrl;
      try { pageUrl = normalizePageUrl(entry?.pageUrl); } catch { throw new Error(`Video ${index + 1} has an invalid video URL.`); }
      if (entry.filename !== undefined && typeof entry.filename !== "string") throw new Error(`Video ${index + 1} needs a text filename.`);
      if (entry.qualityHeight != null && (!Number.isInteger(entry.qualityHeight) || entry.qualityHeight < 480 || entry.qualityHeight > 16384)) {
        throw new Error(`Video ${index + 1} has an invalid quality selection.`);
      }
      entry.naming = normalizeNaming(entry.naming);
      const naming = entry.naming && typeof entry.naming === 'object' ? Object.fromEntries(
        ['author', 'videoTitle', 'channel'].map((key) => [key, typeof entry.naming[key] === 'string' ? entry.naming[key].slice(0, 1000) : ''])
      ) : null;
      if (naming && Array.isArray(entry.naming.authors)) {
        naming.authors = [...new Set(entry.naming.authors.filter((name) => typeof name === 'string' && name.trim())
          .slice(0, 20).map((name) => name.slice(0, 1000)))];
        naming.author = naming.authors.join(' & ');
      }
      const filename = entry.filename ? fileBasename(entry.filename) : "";
      const history = section === "saved" && Array.isArray(entry.history) ? entry.history.map((record) => ({
        savedAt: typeof record?.savedAt === "string" && Number.isFinite(Date.parse(record.savedAt)) ? record.savedAt : null,
        filename: typeof record?.filename === "string" ? sanitize(record.filename.split(/[\\/]/).pop()) : filename,
        height: Number.isFinite(record?.height) && record.height > 0 ? record.height : null,
        codec: ["AV1", "H.264"].includes(record?.codec) ? record.codec : "",
        bytesReceived: Number.isFinite(record?.bytesReceived) && record.bytesReceived >= 0 ? record.bytesReceived : null,
        totalBytes: Number.isFinite(record?.totalBytes) && record.totalBytes > 0 ? record.totalBytes : null,
        imported: true,
      })) : [];
      if (!result.has(videoKey(pageUrl))) result.set(videoKey(pageUrl), {
        pageUrl, filename, qualityHeight: entry.qualityHeight ?? null, naming, thumbnail: thumbnailUrl(entry.thumbnail, pageUrl),
        title: typeof entry.title === "string" ? entry.title.slice(0, 1000) : "",
        height: Number.isFinite(entry.height) && entry.height > 0 ? entry.height : null,
        codec: ["AV1", "H.264"].includes(entry.codec) ? entry.codec : "", history
      });
    }
    return [...result.values()];
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "—";
    const value = Math.ceil(seconds);
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor(value % 3600 / 60);
    const remaining = value % 60;
    return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${remaining}s` : `${remaining}s`;
  }

  function formatBytes(value) {
    if (!Number.isFinite(value) || value < 0) return "—";
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    const unit = value > 0 ? Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1) : 0;
    const index = Math.max(0, unit);
    return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
  }

  return Object.freeze({
    CONCURRENCY, SUBFOLDER, STORAGE_KEY, PRIVATE_STORAGE_KEY, DRAFT_STORAGE_KEY,
    PRIVATE_DRAFT_STORAGE_KEY, normalizePageUrl,
    sanitize, fileBasename, parseVideoPage, normalizeQualityOptions, parsePastedUrls, isVideoResponse, isBusy, isSelectable, formatBytes, videoKey, formatDuration,
    isSaved, exportList, parseList, createActionIcon, structuredFilename, filenameTitle, selectedNameTags, nameTagOptions, exportFilename, importStatus,
    normalizeNameTags, exportNameTags, parseNameTags, thumbnailUrl, parseThumbnail,
    MAX_CONCURRENCY, normalizeConcurrency, normalizeNaming, nameTagLibrary, BACKUP_MAX_BYTES, parseBackup, backupSummary
  });
})();
