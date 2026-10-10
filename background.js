const { CONCURRENCY, SUBFOLDER, STORAGE_KEY, PRIVATE_STORAGE_KEY } = VideoDownloader;
const DRAFT_STORAGE_KEY = VideoDownloader.DRAFT_STORAGE_KEY;
const PRIVATE_DRAFT_STORAGE_KEY = VideoDownloader.PRIVATE_DRAFT_STORAGE_KEY;

function emptyState(incognito) {
  return {
    schemaVersion: 3, revision: 0, batchId: crypto.randomUUID(), incognito,
    input: '', inputRevision: 0, saveAs: false, maxHeight: 0, preferredCodec: 'AV1', concurrency: CONCURRENCY, items: []
  };
}
const contexts = [false, true].map((incognito) => ({
  incognito,
  key: incognito ? PRIVATE_STORAGE_KEY : STORAGE_KEY,
  area: incognito ? 'session' : 'local',
  draftKey: incognito ? PRIVATE_DRAFT_STORAGE_KEY : DRAFT_STORAGE_KEY,
  draftArea: incognito ? 'session' : 'local',
  state: emptyState(incognito),
  listUnresolved: true,
  draftUnresolved: true
}));
const lookups = new Set();
const controllers = new Map();
const progressSamples = new Map();
const pendingStarts = new Set();
const pendingResumes = new Map();
const thumbnailRequests = new Map();
let operations = Promise.resolve();
const activeState = (item) => ['downloading', 'cancelling'].includes(item.state);
const storageReadError = () => new Error('Storage read failed. Retry this action.');

function snapshot(context, includeProgress = true) {
  const value = JSON.parse(JSON.stringify(context.state));
  value.concurrency = VideoDownloader.normalizeConcurrency(contexts[0].state.concurrency);
  value.items = value.items.filter((item) => !item.removeRequested);
  if (includeProgress) for (const item of value.items) {
    const sample = progressSamples.get(item.downloadId);
    if (sample) item.progress = { ...sample.progress };
  }
  return value;
}

async function persist(context) {
  if (context.listUnresolved) throw storageReadError();
  const task = context.state.importTask;
  if (task?.ids.length) {
    const byId = new Map(context.state.items.map((item) => [item.id, item]));
    const finished = task.ids.filter((id) => byId.get(id)?.state !== 'finding');
    const finishedIds = new Set(finished);
    context.state.importTask = { ...task, ids: task.ids.filter((id) => !finishedIds.has(id)),
      completed: (task.completed || 0) + finished.length,
      failed: (task.failed || 0) + finished.filter((id) => byId.get(id)?.state === 'error').length };
  }
  context.state.revision++;
  const value = JSON.parse(JSON.stringify(context.state));
  try {
    await browser.storage[context.area].set({ [context.key]: value });
  } catch (error) {
    context.state.revision--;
    throw error;
  }
}

async function persistDraft(context) {
  if (context.draftUnresolved) throw storageReadError();
  const value = { input: context.state.input, inputRevision: context.state.inputRevision };
  await browser.storage[context.draftArea].set({ [context.draftKey]: value });
}

function cloneItem(item) {
  const copy = { ...item };
  if (Array.isArray(item.history)) copy.history = item.history.map((entry) => ({ ...entry }));
  return copy;
}

function captureContext(context) {
  return {
    revision: context.state.revision,
    input: context.state.input,
    inputRevision: context.state.inputRevision,
    saveAs: context.state.saveAs,
    maxHeight: context.state.maxHeight,
    preferredCodec: context.state.preferredCodec,
    concurrency: context.state.concurrency,
    batchId: context.state.batchId,
    importTask: context.state.importTask,
    namingPresets: context.state.namingPresets,
    items: context.state.items.map(cloneItem),
    references: new Map(context.state.items.map((item) => [item.id, item])),
  };
}

function rollbackContext(context, snap) {
  const keepRevision = Math.max(snap.revision, context.state.revision);
  context.state.input = snap.input;
  context.state.inputRevision = snap.inputRevision;
  context.state.saveAs = snap.saveAs;
  context.state.maxHeight = snap.maxHeight;
  context.state.preferredCodec = snap.preferredCodec;
  context.state.concurrency = snap.concurrency;
  context.state.batchId = snap.batchId;
  context.state.importTask = snap.importTask;
  context.state.namingPresets = snap.namingPresets;
  context.state.items = snap.items.map((fields) => {
    // Async lookups and pending Save As dialogs retain these object references.
    const item = snap.references.get(fields.id);
    for (const key of Object.keys(item)) if (!(key in fields)) delete item[key];
    Object.assign(item, cloneItem(fields));
    return item;
  });
  context.state.revision = keepRevision;
}

function captureDraft(context) {
  return { input: context.state.input, inputRevision: context.state.inputRevision };
}

function rollbackDraft(context, snap) {
  context.state.input = snap.input;
  context.state.inputRevision = snap.inputRevision;
}

function serialize(work) {
  const result = operations.then(() => initialized).then(work);
  operations = result.catch(() => { });
  return result;
}
function report(error) { console.error('Video Bulk Downloader:', error); }
function owned(context, item) { return context.state.items.includes(item); }
function allItems() { return contexts.flatMap((context) => context.state.items.map((item) => ({ context, item }))); }
function removeFinished(context, item) {
  if (item.removeRequested && !activeState(item)) {
    context.state.items = context.state.items.filter((entry) => entry !== item);
    progressSamples.delete(item.downloadId);
  }
}
function cancelled(item) {
  pendingResumes.delete(item.id); delete item.resuming; delete item.resumeError;
  item.state = 'cancelled'; item.selected = false; delete item.error;
}
function fail(context, item, error) {
  pendingResumes.delete(item.id); delete item.resuming; delete item.resumeError;
  if (item.cancelRequested) cancelled(item);
  else { item.state = 'failed'; item.error = error; item.selected = true; }
  removeFinished(context, item);
}

function sampleProgress(item, download, now = Date.now()) {
  const bytes = Number.isFinite(download.bytesReceived) && download.bytesReceived >= 0 ? download.bytesReceived : 0;
  const total = Number.isFinite(download.totalBytes) && download.totalBytes > 0 ? download.totalBytes : null;
  const previous = progressSamples.get(download.id);
  const elapsed = previous ? now - previous.time : 0;
  const stopped = download.paused || download.state !== 'in_progress';
  let speed = previous?.progress.bytesPerSecond ?? null;
  let reset = !previous || stopped || bytes < previous.bytes || elapsed < 0;
  if (stopped) speed = 0;
  else if (reset) speed = null;
  else if (elapsed >= 250) { speed = (bytes - previous.bytes) * 1000 / elapsed; reset = true; }
  const etaSeconds = !stopped && total !== null && speed > 0 ? Math.max(0, total - bytes) / speed : null;
  const progress = {
    bytesReceived: bytes, totalBytes: total, bytesPerSecond: speed,
    etaSeconds, paused: download.paused === true, sampledAt: now
  };
  progressSamples.set(download.id, {
    bytes: reset ? bytes : previous.bytes,
    time: reset ? now : previous.time, progress
  });
  Object.assign(item, { bytesReceived: bytes, totalBytes: total, paused: progress.paused });
}

function inspectDownload(context, item, download) {
  if (!download || download.paused !== true || item.cancelRequested || !activeState(item)) {
    pendingResumes.delete(item.id);
    delete item.resuming;
    if (download?.paused !== true) delete item.resumeError;
  }
  if (download) sampleProgress(item, download);
  if (!download) fail(context, item, 'Download no longer exists in Firefox. Retry this file.');
  else if (download.state === 'complete') {
    if (VideoDownloader.isVideoResponse(download.mime)) {
      item.history ??= [];
      const filename = download.filename || `${item.filename}.mp4`;
      // Firefox can reuse an ID from an earlier session, so an entry matches only with the same file name.
      if (!item.history.some((entry) => entry.downloadId === download.id && entry.filename === filename)) {
        item.history.push({
          downloadId: download.id, savedAt: download.endTime || new Date().toISOString(),
          filename, height: item.height, codec: item.codec,
          bytesReceived: item.bytesReceived, totalBytes: item.totalBytes
        });
      }
      item.state = 'done'; item.selected = false; delete item.error;
      item.saved = true;
      removeFinished(context, item);
    } else fail(context, item, `Received ${download.mime} instead of a video using the ${context.incognito ? 'private' : 'normal'} session. Log in in that window, then retry.`);
  } else if (download.state === 'interrupted' && (download.paused !== true || item.cancelRequested)) {
    // Firefox reports a paused transfer as interrupted with USER_CANCELED, so it keeps its slot until resumed.
    if (item.cancelRequested || download.error === 'USER_CANCELED') {
      cancelled(item); removeFinished(context, item);
    } else fail(context, item, download.error || 'Download interrupted. Retry this file.');
  }
}

// A persisted Firefox download identity. Firefox reassigns numeric IDs on
// restart and forgets which extension started each transfer, so recovery must
// match the exact DownloadItem this extension started — not merely any
// transfer with the same URL. The precise startTime is the primary key; URL,
// browsing mode, and filename corroborate it.
function captureDownloadIdentity(download) {
  if (!download || typeof download.url !== 'string' || !download.url) return null;
  if (typeof download.startTime !== 'string' || !Number.isFinite(Date.parse(download.startTime))) return null;
  return {
    startTime: download.startTime,
    url: download.url,
    filename: typeof download.filename === 'string' ? download.filename : null,
    incognito: download.incognito === true,
  };
}

function hasDownloadIdentity(item) {
  return Boolean(item && item.downloadIdentity &&
    typeof item.downloadIdentity.startTime === 'string' &&
    Number.isFinite(Date.parse(item.downloadIdentity.startTime)) &&
    typeof item.downloadIdentity.url === 'string' && item.downloadIdentity.url);
}

// Transfers verified in this browser session, keyed by `${item.id}:${downloadId}`.
// Used only to recognise a same-ID resume (Firefox resets startTime on resume)
// without weakening restart recovery, which must still require an exact
// fingerprint for a pair never verified here.
const verifiedOwnership = new Set();
function verifiedKey(item, downloadId) {
  return `${item?.id}:${downloadId}`;
}
function markVerified(item, download) {
  if (item && download && Number.isInteger(download.id)) verifiedOwnership.add(verifiedKey(item, download.id));
}

// A recovered transfer is trusted only when its live metadata exactly matches
// the persisted identity captured at launch. A missing byExtensionId
// (forgotten on restart) is tolerated only with an exact fingerprint; a
// present but foreign byExtensionId always rejects.
function isVerifiedDownload(context, item, download) {
  if (!download || !hasDownloadIdentity(item)) return false;
  if (download.byExtensionId && download.byExtensionId !== browser.runtime.id) return false;
  if ((download.incognito === true) !== context.incognito) return false;
  if ((item.downloadIdentity.incognito === true) !== context.incognito) return false;
  if (download.url !== item.downloadIdentity.url) return false;
  if (download.url !== item.url) return false;
  if (item.downloadIdentity.url !== item.url) return false;
  const liveStart = Date.parse(download.startTime);
  const storedStart = Date.parse(item.downloadIdentity.startTime);
  if (!Number.isFinite(liveStart) || !Number.isFinite(storedStart) || liveStart !== storedStart) return false;
  if (item.downloadIdentity.filename && download.filename &&
    item.downloadIdentity.filename !== download.filename) return false;
  return true;
}

// Unique verified match or null. Zero matches and ambiguous multiple matches
// both adopt nothing, so an unrelated same-URL transfer is never adopted and
// an arbitrary choice is never made. Restart recovery stays exact: a resumed
// timestamp is never accepted here, only via the same-ID resume path.
function findVerifiedCandidate(context, item, candidates, claimed) {
  const matches = (candidates || []).filter((entry) =>
    !claimed.has(entry.id) && isVerifiedDownload(context, item, entry));
  if (matches.length !== 1) return null;
  markVerified(item, matches[0]);
  return matches[0];
}

// In-session upgrade for rows that launched before an identity could be
// persisted (e.g. a transient search failure right after downloads.download).
// A live transfer that still names this extension proves ownership in the
// current browser session: after a restart byExtensionId is forgotten, so a
// missing byExtensionId never upgrades. Unrelated manual transfers are never
// upgraded.
function upgradeLegacyIdentity(context, item, download, claimed) {
  if (hasDownloadIdentity(item)) return false;
  if (!download || download.byExtensionId !== browser.runtime.id) return false;
  if (download.url !== item.url) return false;
  if ((download.incognito === true) !== context.incognito) return false;
  if (typeof download.startTime !== 'string' || !Number.isFinite(Date.parse(download.startTime))) return false;
  if (claimed && claimed.has(download.id)) {
    const ownedByOther = allItems().some(({ item: other }) => other !== item && other.downloadId === download.id);
    if (ownedByOther) return false;
  }
  const identity = captureDownloadIdentity(download);
  if (!identity) return false;
  item.downloadIdentity = identity;
  return true;
}

// Firefox resets startTime when a paused transfer is resumed (Download.start
// sets startTime to now). A same-ID live record that was already verified in
// this session and now differs only by startTime is that resumed transfer:
// refresh the persisted identity instead of failing the row. A same-ID record
// never verified here (e.g. a reused ID after restart pointing at a manual
// same-URL download started 24h later) is never accepted by timestamp drift;
// restart recovery still requires an exact fingerprint. A present but foreign
// byExtensionId always rejects.
function isResumedDownload(context, item, download) {
  if (!hasDownloadIdentity(item)) return false;
  if (!download || download.id !== item.downloadId) return false;
  if (download.byExtensionId && download.byExtensionId !== browser.runtime.id) return false;
  if ((download.incognito === true) !== context.incognito) return false;
  if ((item.downloadIdentity.incognito === true) !== context.incognito) return false;
  if (download.url !== item.downloadIdentity.url) return false;
  if (download.url !== item.url) return false;
  if (item.downloadIdentity.url !== item.url) return false;
  if (item.downloadIdentity.filename && download.filename &&
    item.downloadIdentity.filename !== download.filename) return false;
  const liveStart = Date.parse(download.startTime);
  const storedStart = Date.parse(item.downloadIdentity.startTime);
  if (!Number.isFinite(liveStart) || !Number.isFinite(storedStart)) return false;
  if (liveStart === storedStart) return false;
  if (download.byExtensionId === browser.runtime.id) {
    // Current-session ownership proves this is our resumed transfer.
  } else if (download.byExtensionId == null) {
    // Forgotten on restart: allow only for a pair already verified in this session.
    if (!verifiedOwnership.has(verifiedKey(item, download.id))) return false;
  } else return false;
  item.downloadIdentity.startTime = download.startTime;
  markVerified(item, download);
  return true;
}

// Verify a live record, upgrading an in-session legacy row when its live
// transfer still proves ownership via byExtensionId.
function isVerifiedOrUpgraded(context, item, download, claimed) {
  if (isVerifiedDownload(context, item, download)) { markVerified(item, download); return true; }
  if (upgradeLegacyIdentity(context, item, download, claimed) &&
    isVerifiedDownload(context, item, download)) { markVerified(item, download); return true; }
  if (isResumedDownload(context, item, download)) return true;
  return false;
}

// Legacy alias: recovery must use the persisted identity, never a URL plus an
// unbounded timestamp comparison.
function isSameDownload(context, item, download) {
  return isVerifiedDownload(context, item, download);
}

async function reconcileUncertain(context) {
  const uncertain = context.state.items.filter((item) =>
    activeState(item) && !Number.isInteger(item.downloadId) && item.startedAt);
  if (!uncertain.length) return false;
  if (context.listUnresolved) return false;
  let recent;
  try { recent = await browser.downloads.search({}); }
  catch (error) { report(error); return false; }
  const claimed = new Set(allItems()
    .map(({ item }) => item.downloadId).filter(Number.isInteger));
  let changed = false;
  const pendingItems = new Set([...pendingStarts].map((entry) => entry.item));
  for (const item of uncertain) {
    if (!owned(context, item) || !activeState(item) || Number.isInteger(item.downloadId)) continue;
    if (pendingItems.has(item)) continue;
    const pending = [...pendingStarts].some((entry) => entry.context === context && entry.item === item);
    if (pending) continue;
    if (!hasDownloadIdentity(item)) {
      // No persisted identity: never adopt by URL/time and never launch a
      // duplicate automatically. A pending Save As dialog may not appear in
      // search results yet and can stay open indefinitely, so it waits for
      // onCreated instead of failing on any time window.
      if (item.cancelRequested) { cancelled(item); removeFinished(context, item); changed = true; }
      else if (item.saveAs === true) { continue; }
      else {
        fail(context, item, 'Previous download could not be verified in Firefox. Retry this file.');
        changed = true;
      }
      continue;
    }
    const match = findVerifiedCandidate(context, item, recent, claimed);
    if (match) {
      item.downloadId = match.id;
      claimed.add(match.id);
      try { inspectDownload(context, item, match); }
      catch (error) { report(error); continue; }
      if (item.cancelRequested && owned(context, item) && activeState(item) && Number.isInteger(item.downloadId)) {
        try { await cancelRunning(context, item); } catch (error) { report(error); }
      }
      changed = true;
    } else {
      if (item.cancelRequested) { cancelled(item); removeFinished(context, item); changed = true; }
      else {
        // No unique verified transfer: never adopt an ambiguous same-URL
        // candidate and never launch a duplicate automatically.
        fail(context, item, 'Previous download could not be verified in Firefox. Retry this file.');
        changed = true;
      }
    }
  }
  if (changed) {
    try { await persist(context); } catch (error) { report(error); }
    await pump().catch(report);
  }
  return changed;
}

async function refreshProgress(context) {
  await maybeRetryStorageLoad();
  await reconcileUncertain(context);
  let transitioned = false;
  let changed = false;
  let recent = null;
  try { recent = await browser.downloads.search({}); }
  catch (error) { report(error); recent = null; }
  const claimed = new Set(allItems()
    .map(({ item }) => item.downloadId).filter(Number.isInteger));
  // Sequential to keep the claimed set accurate: a verified transfer is never
  // adopted twice and an ambiguous match is never chosen arbitrarily.
  for (const item of context.state.items.filter((item) => activeState(item) && Number.isInteger(item.downloadId))) {
    try {
      const hadIdentity = hasDownloadIdentity(item);
      const prevStart = item.downloadIdentity?.startTime;
      const [download] = await browser.downloads.search({ id: item.downloadId });
      if (isVerifiedOrUpgraded(context, item, download, claimed)) {
        if (!hadIdentity) changed = true;
        else if (item.downloadIdentity?.startTime !== prevStart) changed = true;
        inspectDownload(context, item, download);
      } else {
        // A stale or reused ID must never control another transfer.
        const staleId = item.downloadId;
        delete item.downloadId;
        progressSamples.delete(staleId);
        claimed.delete(staleId);
        const verified = recent ? findVerifiedCandidate(context, item, recent, claimed) : null;
        if (verified) {
          item.downloadId = verified.id;
          claimed.add(verified.id);
          inspectDownload(context, item, verified);
        } else if (!hasDownloadIdentity(item)) {
          if (item.cancelRequested) { cancelled(item); removeFinished(context, item); }
          else if (item.saveAs !== true) fail(context, item, 'Previous download could not be verified in Firefox. Retry this file.');
          // A Save As row without identity waits for its delayed onCreated.
        } else {
          if (item.cancelRequested) { cancelled(item); removeFinished(context, item); }
          else fail(context, item, 'Previous download could not be verified in Firefox. Retry this file.');
        }
        changed = true;
      }
      if (!activeState(item)) transitioned = true;
    } catch (error) { report(error); }
  }
  if (transitioned || changed) {
    try { await persist(context); } catch (error) { report(error); }
    await pump().catch(report);
  }
  return snapshot(context);
}

function applyStoredList(context, stored) {
  if (!stored || ![2, 3].includes(stored.schemaVersion)) return false;
  context.state = {
    ...emptyState(context.incognito), ...stored, schemaVersion: 3, incognito: context.incognito,
    saveAs: stored.schemaVersion === 3 ? stored.saveAs === true : false
  };
  const quality = VideoDownloader.normalizeQualityOptions(stored);
  context.state.maxHeight = quality.maxHeight;
  context.state.preferredCodec = quality.preferredCodec;
  context.state.concurrency = VideoDownloader.normalizeConcurrency(context.state.concurrency);
  if (context.state.namingPresets) context.state.namingPresets = VideoDownloader.nameTagLibrary(context.state.namingPresets);
  for (const item of context.state.items) {
    delete item.resuming;
    if (item.naming) item.naming = VideoDownloader.normalizeNaming(item.naming);
  }
  if (typeof context.state.input !== 'string') context.state.input = '';
  if (!Number.isFinite(context.state.inputRevision)) context.state.inputRevision = 0;
  return true;
}

function applyDraftValue(context, draft) {
  if (!draft || typeof draft.input !== 'string' || !Number.isFinite(draft.inputRevision)) return false;
  if ((draft.inputRevision || 0) >= (context.state.inputRevision || 0)) {
    context.state.input = draft.input;
    context.state.inputRevision = draft.inputRevision;
    return true;
  }
  return false;
}

async function readKey(area, key) {
  try {
    const result = await browser.storage[area].get(key);
    return { ok: true, value: result ? result[key] : undefined };
  } catch (error) {
    return { ok: false, error };
  }
}

function applyLegacySplit(legacy) {
  for (const context of contexts) {
    const sourcePrivate = legacy.incognito === true;
    context.state.input = context.incognito === sourcePrivate ? legacy.input || '' : '';
    context.state.inputRevision = 0;
    context.state.saveAs = false;
    context.state.maxHeight = 0;
    context.state.preferredCodec = 'AV1';
    context.state.items = legacy.items.filter((item) =>
      (typeof item.incognito === 'boolean' ? item.incognito : sourcePrivate) === context.incognito)
      .map((item) => ({
        ...item, incognito: context.incognito,
        selected: item.state === 'done' ? false : item.selected, history: item.history ||
          (item.state === 'done' ? [{ downloadId: item.downloadId, savedAt: null, filename: `${item.filename}.mp4` }] : [])
      }));
  }
}

async function reconcileStartupActive() {
  for (const context of contexts) {
    if (context.listUnresolved) continue;
    const active = context.state.items.filter((item) => activeState(item));
    const claimed = new Set();
    const unverified = [];
    for (const item of active) {
      try {
        let download;
        if (Number.isInteger(item.downloadId)) {
          try { [download] = (await browser.downloads.search({ id: item.downloadId })) || []; }
          catch (error) { report(error); }
        }
        if (!isVerifiedOrUpgraded(context, item, download, claimed)) {
          // A persisted ID may now name an unrelated transfer (reused ID or a
          // manual same-URL download), so it is dropped rather than trusted.
          // The persisted identity is kept for verified re-identification. A
          // search exception also lands here; the full-list search below will
          // fail too, preserving the row without adopting anything.
          delete item.downloadId;
          unverified.push(item);
          continue;
        }
        claimed.add(download.id);
        inspectDownload(context, item, download);
        if (item.cancelRequested && owned(context, item) && activeState(item) && Number.isInteger(item.downloadId)) {
          try { await cancelRunning(context, item); } catch (error) { report(error); }
        }
      } catch (error) { report(error); }
    }
    let recent = null;
    let recentFailed = false;
    for (const item of unverified) {
      try {
        if (!item.startedAt) {
          if (item.cancelRequested) { cancelled(item); removeFinished(context, item); }
          else item.state = 'queued';
          continue;
        }
        if (!hasDownloadIdentity(item)) {
          // Legacy record without identity: never adopt by URL/time and never
          // auto-launch a duplicate. A pending Save As dialog can stay open
          // indefinitely and may not appear in search results yet, so it waits
          // for its delayed onCreated instead of failing on any time window.
          if (item.cancelRequested) { cancelled(item); removeFinished(context, item); }
          else if (item.saveAs === true) { /* wait for delayed Save As completion */ }
          else fail(context, item, 'Previous download could not be verified in Firefox. Retry this file.');
          continue;
        }
        if (!recent && !recentFailed) {
          try { recent = await browser.downloads.search({}); }
          catch (error) { recentFailed = true; report(error); }
        }
        if (recentFailed) {
          // Search unavailable: keep the row (now without a numeric ID but
          // with its identity) for a later retry instead of failing it.
          // Re-attach nothing; identity is preserved in memory but the
          // dropped numeric ID is not persisted until recovery succeeds.
          // To avoid persisting the dropped ID prematurely, re-add a marker?
          // Simplest: leave as-is; loadAll persists after this function, which
          // would persist the dropped ID. That is safe: the identity remains
          // and the next poll can still re-identify. Do not fail here.
          continue;
        }
        const download = findVerifiedCandidate(context, item, recent, claimed);
        if (download) {
          item.downloadId = download.id;
          claimed.add(download.id);
          inspectDownload(context, item, download);
          if (item.cancelRequested && owned(context, item) && activeState(item) && Number.isInteger(item.downloadId)) {
            try { await cancelRunning(context, item); } catch (error) { report(error); }
          }
        } else {
          // No unique verified match (none or ambiguous): adopt nothing and
          // launch nothing. A requested cancel completes without touching
          // Firefox so an unrelated same-URL transfer keeps running.
          if (item.cancelRequested) { cancelled(item); removeFinished(context, item); }
          else fail(context, item, 'Previous download could not be verified in Firefox. Retry this file.');
        }
      } catch (error) { report(error); }
    }
  }
}

async function loadAll() {
  // Read all four records before adopting any state. In particular, a legacy
  // normal record can contain private entries and must migrate as one unit.
  const reads = await Promise.all([
    readKey('local', STORAGE_KEY), readKey('session', PRIVATE_STORAGE_KEY),
    readKey('local', DRAFT_STORAGE_KEY), readKey('session', PRIVATE_DRAFT_STORAGE_KEY),
  ]);
  if (reads.some((read) => !read.ok)) {
    for (const read of reads) if (!read.ok) report(read.error);
    return;
  }
  const privateOpen = (await browser.windows.getAll()).some((window) => window.incognito);
  const [normalRead, privateRead, normalDraftRead, privateDraftRead] = reads;
  const legacy = normalRead.value;
  for (const [context, read] of [[contexts[0], normalRead], [contexts[1], privateRead]]) {
    context.state = emptyState(context.incognito);
    if (read.value && (![1, 2, 3].includes(read.value.schemaVersion) || !Array.isArray(read.value.items))) {
      throw new Error('Saved downloader data could not be read. It has been kept unchanged.');
    }
    applyStoredList(context, read.value);
  }
  if (legacy?.schemaVersion === 1) applyLegacySplit(legacy);
  const drafts = [normalDraftRead.value, privateDraftRead.value];
  const migrateDraft = contexts.map((context, index) => !applyDraftValue(context, drafts[index]));
  if (!privateOpen) contexts[1].state = emptyState(true);
  for (const context of contexts) {
    context.listUnresolved = false;
    context.draftUnresolved = false;
  }
  for (const [index, context] of contexts.entries()) {
    if (context.incognito && !privateOpen) continue;
    if (migrateDraft[index]) {
      try { await persistDraft(context); } catch (error) { report(error); }
    }
  }
  if (!privateOpen) {
    try { await browser.storage.session.remove(PRIVATE_STORAGE_KEY); } catch (error) { report(error); }
    try { await browser.storage.session.remove(PRIVATE_DRAFT_STORAGE_KEY); } catch (error) { report(error); }
  }
  // This runs only once, before any new work can start, including after a
  // transient storage read failure. Never requeue a live in-memory attempt.
  await reconcileStartupActive();
  if (legacy) {
    try { await persist(contexts[0]); } catch (error) { report(error); }
  }
  if (privateOpen && (privateRead.value || legacy?.schemaVersion === 1)) {
    try { await persist(contexts[1]); } catch (error) { report(error); }
  }
}

async function restore() {
  try { await loadAll(); }
  catch (error) {
    for (const context of contexts) { context.listUnresolved = true; context.draftUnresolved = true; }
    report(error);
  }
}

async function maybeRetryStorageLoad() {
  if (!contexts.some((context) => context.listUnresolved || context.draftUnresolved)) return;
  await restore();
  if (!contexts.some((context) => context.listUnresolved || context.draftUnresolved)) await pump().catch(report);
}

async function ensureHostPermission() {
  const hasApi = browser.permissions && typeof browser.permissions.contains === 'function';
  if (!hasApi) return;
  let allowed;
  try { allowed = await browser.permissions.contains({ origins: ['https://www.eporner.com/*'] }); }
  catch (error) {
    throw new Error('Grant permission to access to the site in the extension settings, then retry.');
  }
  if (!allowed) throw new Error('Grant permission to access to the site in the extension settings, then retry.');
}

function parseRetryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return null;
    return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now);
  return null;
}

function sleepCancellable(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('Page request timed out or was cancelled. Retry this file.'), { name: 'AbortError' }));
      return;
    }
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => {
      clearTimeout(timer); cleanup();
      reject(Object.assign(new Error('Page request timed out or was cancelled. Retry this file.'), { name: 'AbortError' }));
    };
    function cleanup() { try { signal?.removeEventListener?.('abort', onAbort); } catch { } }
    try { signal?.addEventListener?.('abort', onAbort, { once: true }); }
    catch { clearTimeout(timer); resolve(); }
  });
}

async function backoffSleep(ms, item) {
  if (!(ms > 0)) return;
  const controller = new AbortController();
  controllers.set(item.id, controller);
  try { await sleepCancellable(ms, controller.signal); }
  catch (error) { throw new Error('Page request timed out or was cancelled. Retry this file.'); }
  finally { if (controllers.get(item.id) === controller) controllers.delete(item.id); }
  if (item.cancelRequested || item.removeRequested) {
    throw new Error('Page request timed out or was cancelled. Retry this file.');
  }
}

function bodyTextWithAbort(response, signal) {
  if (signal?.aborted) {
    return Promise.reject(Object.assign(new Error('Page request timed out or was cancelled. Retry this file.'), { name: 'AbortError' }));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(Object.assign(new Error('Page request timed out or was cancelled. Retry this file.'), { name: 'AbortError' }));
    };
    function cleanup() { try { signal?.removeEventListener?.('abort', onAbort); } catch { } }
    try { signal?.addEventListener?.('abort', onAbort, { once: true }); }
    catch { resolve(response.text()); return; }
    let textPromise;
    try { textPromise = response.text(); }
    catch (error) { if (!settled) { settled = true; cleanup(); reject(error); } return; }
    Promise.resolve(textPromise).then(
      (value) => { if (!settled) { settled = true; cleanup(); resolve(value); } },
      (error) => { if (!settled) { settled = true; cleanup(); reject(error); } });
  });
}

async function readPage(context, item, options) {
  await ensureHostPermission();
  const quality = VideoDownloader.normalizeQualityOptions(options ?? { maxHeight: item.maxHeight, preferredCodec: item.preferredCodec });
  if (!item.qualityLookup && item.qualityHeight != null) quality.exactHeight = item.qualityHeight;
  // Private lookups must not send the normal login or leave their responses in the shared HTTP cache.
  const privacy = context.incognito ? { credentials: 'omit', cache: 'no-store' } : { credentials: 'include' };
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (item.cancelRequested || item.removeRequested) {
      throw new Error('Page request timed out or was cancelled. Retry this file.');
    }
    const controller = new AbortController();
    controllers.set(item.id, controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { controller.abort(); } catch { } }, 30000);
    let response;
    try {
      response = await fetch(item.pageUrl, { ...privacy, signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      if (controllers.get(item.id) === controller) controllers.delete(item.id);
      if (error?.name === 'AbortError') {
        if (!timedOut || item.cancelRequested || item.removeRequested) {
          throw new Error('Page request timed out or was cancelled. Retry this file.');
        }
        lastError = new Error('Page request timed out or was cancelled. Retry this file.');
      } else {
        lastError = error;
      }
      if (attempt >= 3) throw lastError;
      await backoffSleep(400 * (2 ** (attempt - 1)), item);
      continue;
    }
    if (!response.ok) {
      clearTimeout(timer);
      if (controllers.get(item.id) === controller) controllers.delete(item.id);
      const status = response.status;
      const retryable = status === 408 || status === 429 || (status >= 500 && status <= 599);
      if (!retryable) throw new Error(`HTTP ${status}`);
      lastError = new Error(`HTTP ${status}`);
      if (attempt >= 3) throw lastError;
      let retryAfter = null;
      try { retryAfter = response.headers?.get?.('Retry-After') ?? null; } catch { retryAfter = null; }
      const parsed = retryAfter != null ? parseRetryAfterMs(retryAfter) : null;
      const waitMs = parsed != null ? parsed : 400 * (2 ** (attempt - 1));
      if (waitMs > 60000) {
        throw new Error(`Server asked to retry after ${Math.ceil(waitMs / 1000)}s. Try again later.`);
      }
      await backoffSleep(waitMs, item);
      continue;
    }
    let text;
    try { text = await bodyTextWithAbort(response, controller.signal); }
    catch (error) {
      clearTimeout(timer);
      if (controllers.get(item.id) === controller) controllers.delete(item.id);
      if (error?.name === 'AbortError') {
        if (item.cancelRequested || item.removeRequested || !timedOut) {
          throw new Error('Page request timed out or was cancelled. Retry this file.');
        }
        lastError = new Error('Page request timed out or was cancelled. Retry this file.');
      } else {
        lastError = error;
      }
      if (attempt >= 3) throw lastError;
      await backoffSleep(400 * (2 ** (attempt - 1)), item);
      continue;
    }
    clearTimeout(timer);
    if (controllers.get(item.id) === controller) controllers.delete(item.id);
    if (item.cancelRequested || item.removeRequested) {
      throw new Error('Page request timed out or was cancelled. Retry this file.');
    }
    try {
      if (options?.thumbnailOnly) return { thumbnail: VideoDownloader.parseThumbnail(text, response.url || item.pageUrl) };
      return VideoDownloader.parseVideoPage(text, response.url || item.pageUrl, quality);
    }
    catch (error) {
      if (context.incognito && /^No download links found/.test(error.message)) {
        throw new Error('No download links found. Private lookups do not use a login, so try this video in a normal window.');
      }
      throw error;
    }
  }
  throw lastError || new Error('Page request failed. Retry this file.');
}

async function findOne(context, item) {
  const discovery = VideoDownloader.normalizeQualityOptions({
    maxHeight: item.qualityLookup ? 0 : item.qualityHeight ?? item.maxHeight ?? context.state.maxHeight,
    preferredCodec: item.preferredCodec ?? context.state.preferredCodec
  });
  let info, error, availableHeights;
  try { info = await readPage(context, item, discovery); }
  catch (err) { error = err.message; availableHeights = err.availableHeights; }
  await serialize(async () => {
    lookups.delete(item.id);
    if (!owned(context, item) || item.state !== 'finding') { await pump().catch(report); return; }
    if (availableHeights) item.availableHeights = availableHeights;
    if (error) { item.state = 'error'; item.error = error; }
    else Object.assign(item, info, {
      state: item.qualityLookup && VideoDownloader.isSaved(item) ? 'done' : 'ready',
      selected: item.selectionTouched || item.qualityLookup ? item.selected : true,
      filename: item.keepFilename ? item.filename : VideoDownloader.sanitize(`${info.title} [${info.height}p ${info.codec}]`)
    });
    if (!error) {
      item.discoveredMaxHeight = discovery.maxHeight;
      item.discoveredPreferredCodec = discovery.preferredCodec;
      item.maxHeight = discovery.maxHeight;
      item.preferredCodec = discovery.preferredCodec;
    }
    delete item.qualityLookup;
    try { await persist(context); } catch (persistError) { report(persistError); }
    await pump().catch(report);
  });
}

async function checkDownloadSession(incognito) {
  if (!incognito) return;
  if (!await browser.extension.isAllowedIncognitoAccess()) throw new Error("Allow this extension to run in private windows in Firefox's Add-ons Manager, then retry.");
  if (!(await browser.windows.getAll()).some((window) => window.incognito)) throw new Error('Keep a private Firefox window open while downloading.');
}

async function cancelRunning(context, item) {
  let before;
  try { [before] = await browser.downloads.search({ id: item.downloadId }); }
  catch (error) { report(error); return; }
  {
    const claimedForUpgrade = new Set(allItems()
      .map(({ item: entry }) => entry.downloadId).filter(Number.isInteger));
    if (!isVerifiedOrUpgraded(context, item, before, claimedForUpgrade)) {
      // An unverified ID must never control another transfer. Drop it and, when
      // possible, cancel the verified transfer instead. Otherwise complete the
      // requested cancel locally without touching Firefox.
      const staleId = item.downloadId;
      delete item.downloadId;
      progressSamples.delete(staleId);
      let recent = null;
      try { recent = await browser.downloads.search({}); }
      catch (error) { report(error); }
      const claimed = new Set(allItems()
        .map(({ item: entry }) => entry.downloadId).filter(Number.isInteger));
      const verified = recent ? findVerifiedCandidate(context, item, recent, claimed) : null;
      if (verified) {
        item.downloadId = verified.id;
        claimed.add(verified.id);
        before = verified;
      } else {
        cancelled(item); removeFinished(context, item);
        return;
      }
    }
  }
  if (!before || (before.state !== 'in_progress' && before.paused !== true)) { inspectDownload(context, item, before); return; }
  const verifiedId = item.downloadId;
  try { await browser.downloads.cancel(verifiedId); }
  catch (error) {
    let latest;
    try { [latest] = await browser.downloads.search({ id: verifiedId }); }
    catch (searchError) { report(searchError); }
    if (latest && !isVerifiedDownload(context, item, latest) && !isResumedDownload(context, item, latest)) {
      cancelled(item); removeFinished(context, item);
      return;
    }
    if (latest && latest.state !== 'in_progress') { inspectDownload(context, item, latest); return; }
    item.cancelRequested = false; item.removeRequested = false; item.state = 'downloading';
    throw new Error(`Could not cancel this download: ${error.message}`);
  }
  let after;
  try { [after] = await browser.downloads.search({ id: verifiedId }); }
  catch (error) { report(error); return; }
  if (after && !isVerifiedDownload(context, item, after) && !isResumedDownload(context, item, after)) {
    cancelled(item); removeFinished(context, item);
    return;
  }
  inspectDownload(context, item, after);
}

async function cancelItem(context, item, remove = false) {
  if (remove) item.removeRequested = true;
  if (activeState(item)) {
    item.cancelRequested = true; item.state = 'cancelling'; item.selected = false;
    controllers.get(item.id)?.abort();
    if (Number.isInteger(item.downloadId)) await cancelRunning(context, item);
    else if (!item.startedAt) { cancelled(item); removeFinished(context, item); }
  } else {
    controllers.get(item.id)?.abort();
    if (['queued', 'finding'].includes(item.state)) cancelled(item);
    if (remove) context.state.items = context.state.items.filter((entry) => entry !== item);
  }
}

async function startDownload(context, item) {
  const attempt = item.attempt;
  const live = () => owned(context, item) && item.attempt === attempt && activeState(item);
  let pending;
  try {
    await checkDownloadSession(context.incognito);
    if (!live() || item.cancelRequested) return;
    const requested = VideoDownloader.normalizeQualityOptions({ maxHeight: item.maxHeight, preferredCodec: item.preferredCodec });
    const discovered = VideoDownloader.normalizeQualityOptions({ maxHeight: item.discoveredMaxHeight, preferredCodec: item.discoveredPreferredCodec });
    const needsRefresh = Boolean(item.refresh) || !item.url ||
      requested.maxHeight !== discovered.maxHeight || requested.preferredCodec !== discovered.preferredCodec;
    if (needsRefresh) {
      const info = await readPage(context, item, requested);
      await serialize(async () => {
        if (!live() || item.cancelRequested) return;
        const keepName = item.filename;
        const prevUrl = item.url;
        const prevHeight = item.height;
        const prevCodec = item.codec;
        Object.assign(item, info); item.filename = keepName; item.refresh = false;
        item.discoveredMaxHeight = requested.maxHeight;
        item.discoveredPreferredCodec = requested.preferredCodec;
        item.maxHeight = requested.maxHeight;
        item.preferredCodec = requested.preferredCodec;
        try { await persist(context); }
        catch (persistError) {
          Object.assign(item, { url: prevUrl, height: prevHeight, codec: prevCodec });
          throw persistError;
        }
      });
      if (!live() || item.cancelRequested) return;
    }
    await serialize(async () => {
      if (!live()) return;
      if (item.cancelRequested) {
        cancelled(item); removeFinished(context, item);
        try { await persist(context); } catch (persistError) { report(persistError); }
        await pump().catch(report);
        return;
      }
      const prevStartedAt = Object.hasOwn(item, 'startedAt') ? item.startedAt : undefined;
      item.startedAt = Date.now();
      try { await persist(context); }
      catch (persistError) {
        if (prevStartedAt === undefined) delete item.startedAt;
        else item.startedAt = prevStartedAt;
        throw persistError;
      }
    });
    if (!live() || item.cancelRequested) {
      await serialize(async () => {
        if (live()) {
          cancelled(item); removeFinished(context, item);
          try { await persist(context); } catch (persistError) { report(persistError); } await pump().catch(report);
        }
      });
      return;
    }
    pending = { context, item, attempt };
    pendingStarts.add(pending);
    const id = await browser.downloads.download({
      url: item.url,
      filename: item.saveAs ? `${item.filename}.mp4` : `${SUBFOLDER}/${item.filename}.mp4`,
      conflictAction: 'uniquify', saveAs: item.saveAs, incognito: context.incognito
    });
    await serialize(async () => {
      if (!live()) {
        if (item.cancelRequested || item.removeRequested || !owned(context, item)) {
          try { await browser.downloads.cancel(id); } catch { /* Already finished or cancelled. */ }
        }
        return;
      }
      item.downloadId = id;
      // Persist the actual Firefox identity (precise startTime plus
      // corroborating metadata) before trusting this ID anywhere. Future
      // recovery validates against this fingerprint, never a URL/time window.
      try {
        let liveRecord = null;
        try { [liveRecord] = await browser.downloads.search({ id }); } catch { liveRecord = null; }
        const identity = liveRecord ? captureDownloadIdentity(liveRecord) : null;
        if (identity) item.downloadIdentity = identity;
        else delete item.downloadIdentity;
      } catch { delete item.downloadIdentity; }
      try { await persist(context); } catch (persistError) { report(persistError); }
      try {
        if (item.cancelRequested) await cancelRunning(context, item);
        else {
          let download = null;
          try { [download] = await browser.downloads.search({ id }); } catch (error) { report(error); }
          // The just-launched ID is verified against the freshly captured
          // identity; a mismatch (should not happen) is never trusted.
          if (download && item.downloadIdentity && !isVerifiedDownload(context, item, download)) {
            delete item.downloadId;
            delete item.downloadIdentity;
            fail(context, item, 'Previous download could not be verified in Firefox. Retry this file.');
          } else {
            if (download) markVerified(item, download);
            inspectDownload(context, item, download);
          }
        }
      } catch (error) { report(error); }
      try { await persist(context); } catch (persistError) { report(persistError); }
      await pump().catch(report);
    });
  } catch (error) {
    await serialize(async () => {
      if (!live()) return;
      if (error.availableHeights) item.availableHeights = error.availableHeights;
      fail(context, item, error.message);
      try { await persist(context); } catch (persistError) { report(persistError); }
      await pump().catch(report);
    });
  } finally {
    if (pending) pendingStarts.delete(pending);
    void serialize(pump).catch(report);
  }
}

async function pump() {
  if (contexts.some((context) => context.listUnresolved || context.draftUnresolved)) return;
  const finding = allItems().filter(({ item }) => item.state === 'finding' && !lookups.has(item.id));
  for (const { context, item } of finding.slice(0, Math.max(0, CONCURRENCY - lookups.size))) {
    lookups.add(item.id); void findOne(context, item).catch(report);
  }
  const active = allItems().filter(({ item }) => activeState(item));
  const orphans = [...pendingStarts].filter(({ context, item, attempt }) => !owned(context, item) || item.attempt !== attempt || !activeState(item));
  const queued = allItems().filter(({ item }) => item.state === 'queued').sort((a, b) => a.item.queuedAt - b.item.queuedAt);
  const limit = active.some(({ item }) => item.saveAs) || orphans.some(({ item }) => item.saveAs) || queued[0]?.item.saveAs
    ? 1 : VideoDownloader.normalizeConcurrency(contexts[0].state.concurrency);
  const slots = Math.max(0, limit - active.length - orphans.length);
  const starting = [];
  for (const entry of queued) {
    if (starting.length >= slots) break;
    if (entry.item.saveAs) {
      if (!active.length && !orphans.length && !starting.length) starting.push(entry);
      break;
    }
    starting.push(entry);
  }
  if (!starting.length) return;
  const byContext = new Map();
  for (const { context, item } of starting) {
    if (context.listUnresolved) continue;
    if (!byContext.has(context)) byContext.set(context, { snap: captureContext(context), entries: [] });
    byContext.get(context).entries.push(item);
    item.state = 'downloading'; item.attempt = crypto.randomUUID(); item.startedAt = null;
    for (const key of ['downloadId', 'downloadIdentity', 'error', 'bytesReceived', 'totalBytes', 'paused', 'cancelRequested', 'removeRequested']) delete item[key];
  }
  if (!byContext.size) return;
  const failures = [];
  for (const [context, { snap, entries }] of byContext) {
    try { await persist(context); }
    catch (error) {
      rollbackContext(context, snap);
      for (const item of entries) fail(context, item, 'Could not save the download queue. Retry this file.');
      try { await persist(context); } catch (persistError) { report(persistError); }
      report(error);
      failures.push(error);
    }
  }
  const started = [];
  for (const { entries } of byContext.values()) {
    for (const item of entries) {
      const owner = allItems().find(({ item: candidate }) => candidate === item);
      if (owner && owner.item.state === 'downloading') started.push(owner);
    }
  }
  for (const { context, item } of started) void startDownload(context, item).catch(report);
  if (failures.length) throw failures[0];
}

function keyOf(pageUrl, fallback) {
  try { return VideoDownloader.videoKey(pageUrl); } catch { return fallback ?? pageUrl; }
}

function truncateToken(token, max = 60) {
  const value = String(token);
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

async function restoreBackup(backup) {
  if (VideoDownloader.isBusy(allItems().map(({ item }) => item)) || lookups.size || pendingStarts.size) {
    throw new Error('Finish or cancel all lookups, queued downloads, and active downloads in both sessions before restoring a backup.');
  }
  const summary = VideoDownloader.backupSummary(backup);
  if (summary.private.hasData) await checkDownloadSession(true);
  const records = await Promise.all(contexts.map(async context => {
    const [list, draft] = await Promise.all([readKey(context.area, context.key), readKey(context.draftArea, context.draftKey)]);
    if (!list.ok || !draft.ok) throw storageReadError();
    return { context, list: list.value, draft: draft.value };
  }));
  const next = contexts.map(context => {
    const data = backup[context.incognito ? 'private' : 'normal'];
    const revision = Math.max(context.state.revision || 0, Number(data.state.revision) || 0) + 1;
    const inputRevision = Math.max(context.state.inputRevision || 0, data.draft.inputRevision) + 1;
    return { state: { ...data.state, revision, inputRevision, batchId: crypto.randomUUID(),
      concurrency: backup.normal.state.concurrency }, draft: { ...data.draft, inputRevision } };
  });
  const attempted = [];
  try {
    for (const [index, context] of contexts.entries()) {
      attempted.push(index);
      await browser.storage[context.area].set({ [context.key]: next[index].state, [context.draftKey]: next[index].draft });
    }
  } catch (error) {
    // Compensate earlier writes before returning failure. Higher revisions
    // ensure every open tab accepts the old contents after the attempted restore.
    const rollbackErrors = [];
    for (const index of attempted.reverse()) {
      const { context, list, draft } = records[index];
      const state = { ...(list || context.state), revision: next[index].state.revision + 1,
        input: context.state.input, inputRevision: next[index].draft.inputRevision + 1 };
      const oldDraft = { ...(draft || {}), input: context.state.input, inputRevision: state.inputRevision };
      try {
        await browser.storage[context.area].set({ [context.key]: state, [context.draftKey]: oldDraft });
        context.state.revision = state.revision; context.state.inputRevision = state.inputRevision;
      } catch (rollbackError) { rollbackErrors.push(rollbackError); report(rollbackError); }
    }
    if (rollbackErrors.length) {
      for (const context of contexts) { context.listUnresolved = true; context.draftUnresolved = true; }
      throw new Error('Backup restore failed and storage rollback was incomplete. Keep your backup, resolve the storage error, then restore again.');
    }
    throw new Error(`Backup restore failed; your previous data was kept. ${error.message || error}`);
  }
  for (const controller of controllers.values()) controller.abort();
  controllers.clear(); thumbnailRequests.clear(); progressSamples.clear(); pendingResumes.clear();
  for (const [index, context] of contexts.entries()) {
    context.state = next[index].state; context.listUnresolved = false; context.draftUnresolved = false;
  }
}

// A history entry names a saved file only while Firefox still lists that completed download under the recorded name.
function historyMatches(context, entry, download) {
  return Boolean(download) && download.state === 'complete' && Boolean(entry.filename) &&
    (!download.byExtensionId || download.byExtensionId === browser.runtime.id) &&
    (download.incognito === true) === context.incognito && download.filename === entry.filename;
}

async function resolveShowTarget(context, item) {
  const entries = (item.history || []).filter((entry) => Number.isInteger(entry.downloadId));
  if (!entries.length) throw new Error('No completed download to show yet.');
  const newestFirst = [...entries].reverse();
  const preferred = item.state === 'done' ? newestFirst.find((entry) => entry.downloadId === item.downloadId) : undefined;
  const candidates = preferred ? [preferred, ...newestFirst.filter((entry) => entry !== preferred)] : newestFirst;
  let target = null;
  let pruned = false;
  for (const entry of candidates) {
    let download;
    try { [download] = await browser.downloads.search({ id: entry.downloadId }); }
    catch (error) { report(error); throw new Error('Could not check Firefox downloads. Retry this action.'); }
    if (historyMatches(context, entry, download)) { target = entry.downloadId; break; }
    if (!activeState(item) && item.downloadId === entry.downloadId) delete item.downloadId;
    delete entry.downloadId;
    pruned = true;
  }
  if (pruned) { try { await persist(context); } catch (error) { report(error); } }
  if (target === null) throw new Error('This file is no longer listed in Firefox, so it cannot be shown.');
  return target;
}

async function handleMessage(context, message) {
  await maybeRetryStorageLoad();
  if (contexts.some((entry) => entry.listUnresolved || entry.draftUnresolved)) throw storageReadError();
  if (message.type === 'get-state') {
    await reconcileUncertain(context).catch(report);
    return snapshot(context);
  }
  if (message.type === 'get-progress') return refreshProgress(context);
  if (message.type === 'export-backup') {
    const data = Object.fromEntries(contexts.map(entry => [entry.incognito ? 'private' : 'normal', {
      state: JSON.parse(JSON.stringify(entry.state)),
      draft: { input: entry.state.input, inputRevision: entry.state.inputRevision }
    }]));
    return { ...snapshot(context), exportText: JSON.stringify({ format: 'video-bulk-downloader-backup', version: 1,
      exportedAt: new Date().toISOString(), extensionVersion: browser.runtime.getManifest?.().version || '', data }, null, 2) };
  }
  if (message.type === 'preview-backup') {
    return { ...snapshot(context), backupSummary: VideoDownloader.backupSummary(VideoDownloader.parseBackup(message.text)) };
  }
  if (message.type === 'restore-backup') {
    const backup = VideoDownloader.parseBackup(message.text);
    await restoreBackup(backup);
    return { ...snapshot(context), notice: 'Backup restored. Previous active work is ready for an explicit retry; no downloads were started.' };
  }
  if (message.type === 'concurrency') {
    if (!Number.isInteger(message.value) || message.value < 1 || message.value > VideoDownloader.MAX_CONCURRENCY) {
      throw new Error(`Choose between 1 and ${VideoDownloader.MAX_CONCURRENCY} concurrent downloads.`);
    }
    const globalContext = contexts[0], snap = captureContext(globalContext);
    try { globalContext.state.concurrency = message.value; await persist(globalContext); }
    catch (error) { rollbackContext(globalContext, snap); throw error; }
    await pump().catch(report);
    return snapshot(context);
  }
  if (message.type === 'export') {
    if (!['found', 'saved'].includes(message.section)) throw new Error('Choose a found or saved list.');
    return { ...snapshot(context), exportText: VideoDownloader.exportList(context.state.items, message.section, message.format) };
  }
  if (message.type === 'import') {
    if (context.listUnresolved) throw storageReadError();
    if (VideoDownloader.importStatus(context.state)?.busy) throw new Error('Wait for the current import to finish.');
    const records = VideoDownloader.parseList(message.text, message.format, message.section);
    const snap = captureContext(context);
    let committed = false;
    const byKey = new Map();
    for (const item of context.state.items) {
      const key = keyOf(item.pageUrl, item.pageUrl);
      if (!byKey.has(key)) byKey.set(key, item);
    }
    let added = 0, updated = 0, skipped = 0;
    const importedIds = [];
    for (const record of records) {
      const key = keyOf(record.pageUrl, record.pageUrl);
      let entry = byKey.get(key);
      if (entry && (entry.removeRequested || ['finding', 'queued', 'downloading', 'cancelling'].includes(entry.state))) { skipped++; continue; }
      if (entry && (message.section === 'found' || VideoDownloader.isSaved(entry))) { skipped++; continue; }
      if (!entry) {
        entry = {
          ...record, id: crypto.randomUUID(), incognito: context.incognito, selected: false,
          filename: record.filename || VideoDownloader.sanitize(new URL(record.pageUrl).pathname.split('/').filter(Boolean).pop()) || 'Video',
          history: [], keepFilename: Boolean(record.filename)
        };
        entry.maxHeight = record.qualityHeight ?? context.state.maxHeight ?? 0;
        entry.preferredCodec = context.state.preferredCodec ?? 'AV1';
        entry.discoveredMaxHeight = entry.maxHeight;
        entry.discoveredPreferredCodec = entry.preferredCodec;
        context.state.items.push(entry);
        byKey.set(key, entry);
        added++;
      } else updated++;
      importedIds.push(entry.id);
      if (message.section === 'saved') {
        entry.saved = true; entry.state = 'done'; entry.selected = false;
        if (record.filename) { entry.filename = record.filename; entry.keepFilename = true; }
        if (record.title) entry.title = record.title;
        if (record.naming) entry.naming = record.naming;
        if (record.qualityHeight !== null) entry.qualityHeight = record.qualityHeight;
        if (Number.isFinite(record.height) && record.height > 0) entry.height = record.height;
        if (record.codec) entry.codec = record.codec;
        if (record.history.length) entry.history = record.history;
        else if (!entry.history?.length) entry.history = [{ savedAt: null, filename: entry.filename, imported: true }];
        for (const stale of ['downloadId', 'downloadIdentity', 'url', 'attempt', 'startedAt', 'queuedAt', 'refresh', 'error',
          'bytesReceived', 'totalBytes', 'paused', 'cancelRequested', 'removeRequested']) delete entry[stale];
        entry.maxHeight ??= context.state.maxHeight ?? 0;
        entry.preferredCodec ??= context.state.preferredCodec ?? 'AV1';
        entry.discoveredMaxHeight ??= entry.maxHeight;
        entry.discoveredPreferredCodec ??= entry.preferredCodec;
        delete entry.error;
      } else entry.state = 'finding';
    }
    context.state.importTask = { section: message.section, ids: importedIds, total: importedIds.length,
      completed: 0, failed: 0, added, updated, skipped };
    try {
      await persist(context);
      committed = true;
    } catch (error) {
      rollbackContext(context, snap);
      throw error;
    }
    try { await pump(); }
    catch (error) { report(error); throw error; }
    return { ...snapshot(context), notice: `${added} imported; ${updated} moved to saved; ${skipped} already listed or active.` };
  }
  if (message.type === 'input' || message.type === 'clear-input') {
    if (context.draftUnresolved || context.listUnresolved) throw storageReadError();
    const snap = captureDraft(context);
    try {
      context.state.input = message.type === 'clear-input' ? '' : String(message.input || '');
      context.state.inputRevision++;
      await persistDraft(context);
    } catch (error) {
      rollbackDraft(context, snap);
      throw error;
    }
  } else if (message.type === 'find') {
    if (context.listUnresolved || context.draftUnresolved) throw storageReadError();
    const input = String(message.input || '');
    const quality = VideoDownloader.normalizeQualityOptions({
      maxHeight: message.maxHeight ?? context.state.maxHeight,
      preferredCodec: message.preferredCodec ?? context.state.preferredCodec
    });
    const parsed = VideoDownloader.parsePastedUrls(input);
    const urls = parsed.urls;
    const invalid = parsed.invalid || [];
    const duplicateCount = parsed.duplicateCount || 0;
    if (!urls.length) throw new Error('No video URLs found.');
    const snap = captureContext(context);
    let committed = false;
    try {
      const existing = new Set(context.state.items.map((item) => keyOf(item.pageUrl, item.pageUrl)));
      const added = [];
      for (const url of urls) {
        const key = keyOf(url, url);
        if (!existing.has(key)) { added.push(url); existing.add(key); }
      }
      context.state.input = input; context.state.inputRevision++;
      context.state.maxHeight = quality.maxHeight; context.state.preferredCodec = quality.preferredCodec;
      context.state.items.push(...added.map((pageUrl) => ({
        id: crypto.randomUUID(), pageUrl, incognito: context.incognito,
        state: 'finding', selected: false, filename: VideoDownloader.sanitize(new URL(pageUrl).pathname.split('/').filter(Boolean).pop()) || 'Video', history: [],
        maxHeight: quality.maxHeight, preferredCodec: quality.preferredCodec,
        discoveredMaxHeight: quality.maxHeight, discoveredPreferredCodec: quality.preferredCodec
      })));
      await persist(context);
      committed = true;
      try { await persistDraft(context); } catch (draftError) { report(draftError); }
    } catch (error) {
      if (!committed) rollbackContext(context, snap);
      throw error;
    }
    try { await pump(); }
    catch (error) { report(error); }
    let addedLength = 0;
    {
      const beforeKeys = new Set(snap.items.map((item) => keyOf(item.pageUrl, item.pageUrl)));
      for (const item of context.state.items) {
        if (!beforeKeys.has(keyOf(item.pageUrl, item.pageUrl))) addedLength++;
      }
    }
    let finalNotice = `${addedLength} new video(s) added; ${urls.length - addedLength} already in this list.`;
    if (duplicateCount > 0) finalNotice += ` ${duplicateCount} duplicate(s) ignored.`;
    if (invalid.length > 0) {
      const examples = invalid.slice(0, 3).map((token) => truncateToken(token, 60)).join(', ');
      let suffix = `${invalid.length} invalid entr${invalid.length === 1 ? 'y' : 'ies'} ignored${examples ? `: ${examples}` : ''}${invalid.length > 3 ? '…' : ''}.`;
      if (finalNotice.length + 1 + suffix.length > 500) {
        const room = Math.max(0, 500 - finalNotice.length - 1 - 30);
        suffix = `${suffix.slice(0, room)}…`;
      }
      finalNotice += ` ${suffix}`;
    }
    return { ...snapshot(context), notice: finalNotice };
  } else if (message.type === 'export-name-tags') {
    return { ...snapshot(context), exportText: VideoDownloader.exportNameTags(context.state.namingPresets, message.format) };
  } else if (message.type === 'import-name-tags') {
    if (context.listUnresolved) throw storageReadError();
    const imported = VideoDownloader.parseNameTags(message.text, message.format);
    const previous = context.state.namingPresets || {};
    const merged = VideoDownloader.normalizeNameTags({
      author: [...(previous.author || []), ...imported.author],
      channel: [...(previous.channel || []), ...imported.channel]
    });
    const added = ['author', 'channel'].reduce((sum, kind) => sum + merged[kind].length - (previous[kind]?.length || 0), 0);
    const snap = captureContext(context);
    try { context.state.namingPresets = merged; await persist(context); }
    catch (error) { rollbackContext(context, snap); throw error; }
    return { ...snapshot(context), notice: `${added} reusable tag(s) added; existing tags kept.` };
  } else if (message.type === 'name-tag') {
    if (context.listUnresolved) throw storageReadError();
    if (!['author', 'channel'].includes(message.kind) || !['add', 'remove'].includes(message.action)) {
      throw new Error('Choose a author or channel tag to add or remove.');
    }
    if (typeof message.name !== 'string' || !message.name.trim() ||
      message.name.trim().length > (message.action === 'add' ? 100 : 1000)) {
      throw new Error('Enter a tag name between 1 and 100 characters.');
    }
    const name = message.action === 'add' ? message.name.trim().replace(/\s+/g, ' ') : message.name.trim();
    const snap = captureContext(context);
    try {
      const previous = context.state.namingPresets || {};
      const tags = previous[message.kind] || [];
      const same = (tag) => tag.toLowerCase() === name.toLowerCase();
      const updated = message.action === 'remove' ? tags.filter((tag) => !same(tag))
        : tags.some(same) ? tags : [...tags, name];
      if (message.action === 'add' && updated.length > 100) throw new Error('Keep up to 100 reusable tags of each type.');
      context.state.namingPresets = { ...previous, [message.kind]: updated };
      await persist(context);
    } catch (error) { rollbackContext(context, snap); throw error; }
  } else if (message.type === 'settings') {
    if (context.listUnresolved) throw storageReadError();
    const snap = captureContext(context);
    try {
      if (Object.hasOwn(message, 'saveAs')) context.state.saveAs = message.saveAs === true;
      if (Object.hasOwn(message, 'maxHeight') || Object.hasOwn(message, 'preferredCodec')) {
        const quality = VideoDownloader.normalizeQualityOptions({
          maxHeight: Object.hasOwn(message, 'maxHeight') ? message.maxHeight : context.state.maxHeight,
          preferredCodec: Object.hasOwn(message, 'preferredCodec') ? message.preferredCodec : context.state.preferredCodec,
        });
        context.state.maxHeight = quality.maxHeight;
        context.state.preferredCodec = quality.preferredCodec;
      }
      await persist(context);
    } catch (error) {
      rollbackContext(context, snap);
      throw error;
    }
  } else {
    if (context.listUnresolved) throw storageReadError();
    if (message.batchId !== context.state.batchId) throw new Error('The list changed. Try again.');
    if (['select', 'bulk-cancel', 'bulk-remove'].includes(message.type)) {
      const ids = [...new Set(message.ids || [])];
      const byId = new Map(context.state.items.map((entry) => [entry.id, entry]));
      const entries = ids.map((id) => {
        const entry = byId.get(id);
        return entry && !entry.removeRequested ? entry : undefined;
      });
      if (entries.some((entry) => !entry)) throw new Error('The selection changed. Try again.');
      const snap = captureContext(context);
      let committed = false;
      try {
        if (message.type === 'select') {
          for (const entry of entries) { entry.selected = message.selected === true; entry.selectionTouched = true; }
          await persist(context);
          committed = true;
          return snapshot(context);
        }
        const eligible = entries.filter((entry) => !activeState(entry) && (message.type === 'bulk-remove' || !VideoDownloader.isSaved(entry)));
        if (message.type === 'bulk-remove') {
          const eligibleSet = new Set(eligible);
          context.state.items = context.state.items.filter((entry) => !eligibleSet.has(entry));
          await persist(context);
          committed = true;
          for (const entry of eligible) {
            entry.removeRequested = true;
            controllers.get(entry.id)?.abort();
            progressSamples.delete(entry.downloadId);
          }
        } else {
          for (const entry of eligible) {
            if (['queued', 'finding'].includes(entry.state)) cancelled(entry);
            else cancelled(entry);
          }
          await persist(context);
          committed = true;
          for (const entry of eligible) {
            entry.cancelRequested = true;
            controllers.get(entry.id)?.abort();
          }
        }
      } catch (error) {
        if (!committed) rollbackContext(context, snap);
        throw error;
      }
      try { await pump(); }
      catch (error) { report(error); }
      const removedOrCancelled = message.type === 'bulk-remove'
        ? snap.items.length - context.state.items.length
        : entries.filter((entry) => entry.state === 'cancelled').length;
      return { ...snapshot(context), notice: `${removedOrCancelled} ${message.type === 'bulk-remove' ? 'removed' : 'cancelled'}; ${entries.length - removedOrCancelled} downloading or saved video(s) skipped.` };
    }
    if (['pause', 'resume', 'show-file'].includes(message.type)) {
      const item = context.state.items.find((entry) => entry.id === message.id && !entry.removeRequested);
      if (!item) throw new Error('This video was removed from the list.');
      if (message.type === 'show-file') {
        const target = await resolveShowTarget(context, item);
        if (!Number.isInteger(target)) throw new Error('No completed download to show yet.');
        if (typeof browser.downloads.show !== 'function') throw new Error('Showing files is not supported in this Firefox version.');
        await browser.downloads.show(target);
        return snapshot(context);
      }
      if (message.type === 'pause') {
        if (item.state !== 'downloading') throw new Error('Only downloading files can be paused.');
        if (item.paused) return snapshot(context);
        if (!Number.isInteger(item.downloadId)) throw new Error('This download has not started yet.');
        if (typeof browser.downloads.pause !== 'function') throw new Error('Pausing downloads is not supported in this Firefox version.');
        // Verify the persisted ID still names our transfer; an unverified ID
        // must never pause another transfer.
        let live = null;
        try { [live] = await browser.downloads.search({ id: item.downloadId }); }
        catch (error) { report(error); throw new Error('Could not check Firefox downloads. Retry this action.'); }
        {
          const claimedForUpgrade = new Set(allItems()
            .map(({ item: entry }) => entry.downloadId).filter(Number.isInteger));
          if (!isVerifiedOrUpgraded(context, item, live, claimedForUpgrade)) {
            const staleId = item.downloadId;
            delete item.downloadId;
            progressSamples.delete(staleId);
            let recent = null;
            try { recent = await browser.downloads.search({}); }
            catch (error) { report(error); throw new Error('Could not check Firefox downloads. Retry this action.'); }
            const claimed = new Set(allItems()
              .map(({ item: entry }) => entry.downloadId).filter(Number.isInteger));
            const verified = findVerifiedCandidate(context, item, recent, claimed);
            if (!verified) {
              if (!hasDownloadIdentity(item)) {
                if (item.saveAs === true) throw new Error('This download has not started yet.');
                fail(context, item, 'Previous download could not be verified in Firefox. Retry this file.');
              } else fail(context, item, 'Previous download could not be verified in Firefox. Retry this file.');
              try { await persist(context); } catch (persistError) { report(persistError); }
              await pump().catch(report);
              throw new Error('This download could not be verified in Firefox. Retry this file.');
            }
            item.downloadId = verified.id;
            try { await persist(context); } catch (persistError) { report(persistError); }
          }
        }
        await browser.downloads.pause(item.downloadId);
        item.paused = true;
        try { await persist(context); } catch (persistError) { report(persistError); }
        return snapshot(context);
      }
      if (message.type === 'resume') {
        if (item.state !== 'downloading') throw new Error('Only downloading files can be resumed.');
        if (!item.paused) return snapshot(context);
        if (pendingResumes.has(item.id)) return snapshot(context);
        if (!Number.isInteger(item.downloadId)) throw new Error('This download has not started yet.');
        if (typeof browser.downloads.resume !== 'function') throw new Error('Resuming downloads is not supported in this Firefox version.');
        // Verify before resuming; an unverified ID must never resume another transfer.
        let live = null;
        try { [live] = await browser.downloads.search({ id: item.downloadId }); }
        catch (error) { report(error); throw new Error('Could not check Firefox downloads. Retry this action.'); }
        {
          const claimedForUpgrade = new Set(allItems()
            .map(({ item: entry }) => entry.downloadId).filter(Number.isInteger));
          if (!isVerifiedOrUpgraded(context, item, live, claimedForUpgrade)) {
            const staleId = item.downloadId;
            delete item.downloadId;
            progressSamples.delete(staleId);
            let recent = null;
            try { recent = await browser.downloads.search({}); }
            catch (error) { report(error); throw new Error('Could not check Firefox downloads. Retry this action.'); }
            const claimed = new Set(allItems()
              .map(({ item: entry }) => entry.downloadId).filter(Number.isInteger));
            const verified = findVerifiedCandidate(context, item, recent, claimed);
            if (!verified) {
              fail(context, item, 'Previous download could not be verified in Firefox. Retry this file.');
              try { await persist(context); } catch (persistError) { report(persistError); }
              await pump().catch(report);
              throw new Error('This download could not be verified in Firefox. Retry this file.');
            }
            item.downloadId = verified.id;
            try { await persist(context); } catch (persistError) { report(persistError); }
          }
        }
        const token = { downloadId: item.downloadId };
        pendingResumes.set(item.id, token);
        item.resuming = true;
        delete item.resumeError;
        // Firefox returns Download.start()'s promise, which can stay pending
        // for the entire transfer. Never hold the command queue on that promise.
        try {
          Promise.resolve(browser.downloads.resume(token.downloadId)).then(
            () => finishResume(context, item, token),
            (error) => finishResume(context, item, token, error)
          ).catch(report);
        } catch (error) {
          pendingResumes.delete(item.id); delete item.resuming; throw error;
        }
        // Firefox resets startTime on resume: refresh the persisted identity
        // from the live record. Pre-resume verification already proved this ID
        // is ours, so this refresh never weakens restart checks.
        try {
          const [resumedLive] = await browser.downloads.search({ id: item.downloadId });
          const claimed = new Set(allItems().map(({ item: entry }) => entry.downloadId).filter(Number.isInteger));
          if (isVerifiedOrUpgraded(context, item, resumedLive, claimed)) {
            inspectDownload(context, item, resumedLive);
          }
        } catch (error) { report(error); }
        try { await persist(context); } catch (persistError) { report(persistError); }
        return snapshot(context);
      }
      throw new Error('Unknown downloader command.');
    }
    const byId = new Map(context.state.items.map((entry) => [entry.id, entry]));
    const resolveItem = (id) => {
      const entry = byId.get(id);
      return entry && !entry.removeRequested ? entry : undefined;
    };
    const item = message.id ? resolveItem(message.id) : undefined;
    if (['edit', 'rename', 'apply-name-tags', 'quality', 'check-quality', 'cancel', 'remove'].includes(message.type) && !item) throw new Error('This video was removed from the list.');
    if (['quality', 'check-quality', 'rename', 'apply-name-tags'].includes(message.type)) {
      if (!VideoDownloader.isSelectable(item)) throw new Error('This file is not editable while it is active.');
      const snap = captureContext(context);
      try {
        if (message.type === 'rename') {
          const naming = Object.fromEntries(['author', 'videoTitle', 'channel'].map((key) => {
            if (typeof message[key] !== 'string' || message[key].length > 1000) throw new Error('Enter text of at most 1,000 characters for each name field.');
            return [key, message[key].trim()];
          }));
          naming.authors = naming.author ? [naming.author] : [];
          item.filename = VideoDownloader.structuredFilename(naming);
          item.naming = naming; item.keepFilename = true;
          const previous = context.state.namingPresets || {};
          const remember = (key) => [...new Set([naming[key], ...(previous[key] || [])].filter(Boolean))].slice(0, 50);
          context.state.namingPresets = { author: remember('author'), channel: remember('channel') };
        } else if (message.type === 'apply-name-tags') {
          if (!Array.isArray(message.authors) || message.authors.length > 20 ||
            message.authors.some((name) => typeof name !== 'string' || !VideoDownloader.nameTagOptions(context.state, item, 'author').includes(name)) ||
            typeof message.channel !== 'string' || (message.channel && !VideoDownloader.nameTagOptions(context.state, item, 'channel').includes(message.channel))) {
            throw new Error('Choose from your reusable author and channel tags.');
          }
          const authors = [...new Set(message.authors)];
          const naming = { authors, author: authors.join(' & '), channel: message.channel,
            videoTitle: VideoDownloader.filenameTitle(item) || 'Video Title' };
          item.filename = VideoDownloader.structuredFilename(naming);
          item.naming = naming; item.keepFilename = true;
        } else if (message.type === 'quality') {
          const height = message.height;
          if (height !== null && (!Number.isInteger(height) || height < 480 || !item.availableHeights?.includes(height))) {
            throw new Error('Check available qualities, then choose a supported resolution.');
          }
          item.qualityHeight = height;
        } else {
          item.keepFilename = true; item.qualityLookup = true;
          item.state = 'finding'; delete item.error;
          item.maxHeight = 0;
        }
        await persist(context);
      } catch (error) { rollbackContext(context, snap); throw error; }
      if (message.type === 'check-quality') await pump();
    } else if (message.type === 'edit') {
      if (!VideoDownloader.isSelectable(item)) throw new Error('This file is not editable while it is active.');
      const snap = captureContext(context);
      try {
        if (typeof message.filename === 'string') {
          if (item.naming) item.naming = { ...item.naming, videoTitle: VideoDownloader.filenameTitle(item, message.filename) };
          item.filename = message.filename; item.keepFilename = true;
        }
        if (typeof message.selected === 'boolean') item.selected = message.selected;
        await persist(context);
      } catch (error) {
        rollbackContext(context, snap);
        throw error;
      }
    } else if (message.type === 'cancel' || message.type === 'remove') {
      if (message.type === 'cancel' && !['queued', 'downloading', 'cancelling'].includes(item.state)) throw new Error('This download is no longer active.');
      try { await cancelItem(context, item, message.type === 'remove'); }
      finally {
        try { await persist(context); } catch (persistError) { report(persistError); throw persistError; }
        try { await pump(); } catch (pumpError) { report(pumpError); }
      }
    } else if (message.type === 'download') {
      const downloadById = new Map(context.state.items.map((entry) => [entry.id, entry]));
      const chosen = (message.items || []).map((choice) => {
        const entry = downloadById.get(choice.id);
        if (!entry || entry.removeRequested || !VideoDownloader.isSelectable(entry)) throw new Error('This file is already active or was removed.');
        return { item: entry, filename: VideoDownloader.fileBasename(choice.filename) };
      });
      if (!chosen.length || new Set(chosen.map(({ item: entry }) => entry.id)).size !== chosen.length) throw new Error('Select at least one file, without duplicates.');
      await checkDownloadSession(context.incognito);
      const snap = captureContext(context);
      const chosenIds = new Set(chosen.map(({ item: entry }) => entry.id));
      let committed = false;
      try {
        const quality = VideoDownloader.normalizeQualityOptions({
          maxHeight: message.maxHeight ?? context.state.maxHeight,
          preferredCodec: message.preferredCodec ?? context.state.preferredCodec
        });
        context.state.saveAs = message.saveAs === true;
        context.state.maxHeight = quality.maxHeight;
        context.state.preferredCodec = quality.preferredCodec;
        for (const { item: entry, filename } of chosen) {
          const itemQuality = { ...quality, maxHeight: entry.qualityHeight ?? quality.maxHeight };
          const discovered = VideoDownloader.normalizeQualityOptions({ maxHeight: entry.discoveredMaxHeight, preferredCodec: entry.discoveredPreferredCodec });
          entry.refresh = entry.state !== 'ready' || !entry.url ||
            discovered.maxHeight !== itemQuality.maxHeight || discovered.preferredCodec !== itemQuality.preferredCodec;
          entry.filename = filename; entry.saveAs = context.state.saveAs;
          entry.maxHeight = itemQuality.maxHeight; entry.preferredCodec = itemQuality.preferredCodec;
          entry.incognito = context.incognito; entry.selected = true; entry.state = 'queued'; entry.queuedAt = Date.now();
          for (const key of ['downloadId', 'downloadIdentity', 'error', 'bytesReceived', 'totalBytes', 'paused', 'cancelRequested', 'removeRequested']) delete entry[key];
        }
        await persist(context);
        committed = true;
      } catch (error) {
        if (!committed) {
          try { rollbackContext(context, snap); } catch { }
        }
        throw error;
      }
      try { await pump(); }
      catch (pumpError) {
        const anyDownloading = [...chosenIds].some((id) => {
          const entry = context.state.items.find((candidate) => candidate.id === id);
          return entry && entry.state === 'downloading';
        });
        if (!anyDownloading) {
          report(pumpError);
          throw pumpError;
        }
        report(pumpError);
      }
    } else throw new Error('Unknown downloader command.');
  }
  return snapshot(context);
}

async function senderContext(message, sender) {
  const tab = sender.tab || (Number.isInteger(message.tabId) ? await browser.tabs.get(message.tabId) : null);
  if (!tab || (tab.url && tab.url.split('#')[0] !== browser.runtime.getURL('app.html'))) throw new Error('Open the downloader from the extension toolbar.');
  return contexts[tab.incognito === true ? 1 : 0];
}

function finishResume(context, item, token, error) {
  return serialize(async () => {
    if (pendingResumes.get(item.id) !== token) return;
    pendingResumes.delete(item.id);
    if (!owned(context, item) || item.downloadId !== token.downloadId) return;
    delete item.resuming;
    if (error) item.resumeError = `Resume failed: ${error.message || error}. Try again.`;
    try {
      const [live] = await browser.downloads.search({ id: token.downloadId });
      const claimed = new Set(allItems().map(({ item: entry }) => entry.downloadId).filter(Number.isInteger));
      if (isVerifiedOrUpgraded(context, item, live, claimed)) inspectDownload(context, item, live);
    } catch (searchError) { report(searchError); }
    try { await persist(context); } catch (persistError) { report(persistError); }
    await pump().catch(report);
  });
}

async function requestThumbnail(message, sender) {
  const target = await serialize(async () => {
    const context = await senderContext(message, sender);
    if (context.listUnresolved) throw storageReadError();
    if (message.batchId !== context.state.batchId) throw new Error('The list changed. Try again.');
    const item = context.state.items.find((entry) => entry.id === message.id && !entry.removeRequested);
    if (!item) throw new Error('This video was removed from the list.');
    return { context, item };
  });
  const { context, item } = target;
  if (item.thumbnail) return snapshot(context);
  if (thumbnailRequests.has(item.id)) return thumbnailRequests.get(item.id);
  // A separate lookup object keeps hover requests from replacing or aborting
  // the controller for an active video-page lookup or download retry.
  const lookup = { id: `thumbnail-${item.id}`, pageUrl: item.pageUrl };
  const task = (async () => {
    try {
      const info = await readPage(context, lookup, { thumbnailOnly: true });
      return await serialize(async () => {
        if (!owned(context, item) || item.removeRequested) throw new Error('This video was removed from the list.');
        item.thumbnail = info.thumbnail;
        await persist(context);
        return snapshot(context);
      });
    } finally { thumbnailRequests.delete(item.id); }
  })();
  thumbnailRequests.set(item.id, task);
  return task;
}

const initialized = restore().catch((error) => { report(error); });
browser.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== browser.runtime.id || sender.url?.split('#')[0] !== browser.runtime.getURL('app.html')) return;
  const response = message.type === 'thumbnail' ? requestThumbnail(message, sender)
    : serialize(async () => handleMessage(await senderContext(message, sender), message));
  return response.then(
    (value) => ({ ok: true, state: value }), (error) => ({ ok: false, error: error.message }));
});

browser.downloads.onCreated.addListener((download) => {
  void serialize(async () => {
    if (download.byExtensionId !== browser.runtime.id) return;
    const claimed = new Set(allItems()
      .map(({ item }) => item.downloadId).filter(Number.isInteger));
    if (claimed.has(download.id)) return;
    // Verified attribution for rows that already have an identity but lost
    // their numeric ID (restart reassignment). Exact fingerprint only.
    const verifiedOwners = allItems().filter(({ context, item }) =>
      activeState(item) && !Number.isInteger(item.downloadId) && hasDownloadIdentity(item) &&
      isVerifiedDownload(context, item, download));
    if (verifiedOwners.length > 1) return;
    if (verifiedOwners.length === 1) {
      const { context, item } = verifiedOwners[0];
      item.downloadId = download.id;
      markVerified(item, download);
      if (item.cancelRequested) await cancelRunning(context, item);
      else inspectDownload(context, item, download);
      try { await persist(context); } catch (persistError) { report(persistError); }
      await pump().catch(report);
      return;
    }
    // Pending Save As without identity: match by URL and browsing mode only,
    // requiring exactly one candidate. No time window: a Save As dialog can
    // stay open indefinitely, and byExtensionId already proves ownership.
    const pending = allItems().filter(({ context, item }) =>
      activeState(item) && !Number.isInteger(item.downloadId) && !hasDownloadIdentity(item) &&
      item.startedAt && item.url === download.url && context.incognito === (download.incognito === true));
    if (pending.length !== 1) return;
    const { context, item } = pending[0];
    const identity = captureDownloadIdentity(download);
    if (identity) item.downloadIdentity = identity;
    item.downloadId = download.id;
    if (item.cancelRequested) await cancelRunning(context, item);
    else inspectDownload(context, item, download);
    try { await persist(context); } catch (persistError) { report(persistError); }
    await pump().catch(report);
  }).catch(report);
});
browser.downloads.onChanged.addListener((delta) => {
  void serialize(async () => {
    const owner = allItems().find(({ item }) => activeState(item) && item.downloadId === delta.id);
    if (!owner) return;
    const { context, item } = owner;
    let download;
    try { [download] = await browser.downloads.search({ id: delta.id }); }
    catch (error) { report(error); return; }
    {
      const claimedForUpgrade = new Set(allItems()
        .map(({ item: entry }) => entry.downloadId).filter(Number.isInteger));
      if (!isVerifiedOrUpgraded(context, item, download, claimedForUpgrade)) {
        // An unverified ID must never drive another transfer's state. Drop it
        // and try a verified re-identification instead of inspecting unrelated.
        const staleId = item.downloadId;
        delete item.downloadId;
        progressSamples.delete(staleId);
        if (!hasDownloadIdentity(item)) {
          if (item.cancelRequested) { cancelled(item); removeFinished(context, item); }
          else if (item.saveAs !== true) fail(context, item, 'Previous download could not be verified in Firefox. Retry this file.');
          try { await persist(context); } catch (persistError) { report(persistError); }
          await pump().catch(report);
          return;
        }
        let recent = null;
        try { recent = await browser.downloads.search({}); }
        catch (error) { report(error); return; }
        const claimed = new Set(allItems()
          .map(({ item: entry }) => entry.downloadId).filter(Number.isInteger));
        const verified = findVerifiedCandidate(context, item, recent, claimed);
        if (verified) {
          item.downloadId = verified.id;
          inspectDownload(context, item, verified);
          if (item.cancelRequested && owned(context, item) && activeState(item) && Number.isInteger(item.downloadId)) {
            try { await cancelRunning(context, item); } catch (error) { report(error); }
          }
        } else {
          if (item.cancelRequested) { cancelled(item); removeFinished(context, item); }
          else fail(context, item, 'Previous download could not be verified in Firefox. Retry this file.');
        }
        try { await persist(context); } catch (persistError) { report(persistError); }
        await pump().catch(report);
        return;
      }
    }
    inspectDownload(context, item, download);
    try { await persist(context); } catch (persistError) { report(persistError); }
    await pump().catch(report);
  }).catch(report);
});
browser.downloads.onErased.addListener((id) => {
  void serialize(async () => {
    const owner = allItems().find(({ item }) => activeState(item) && item.downloadId === id);
    if (!owner) return;
    const { context, item } = owner;
    // Failing our own row never harms another transfer, but a stale ID that
    // now names an unrelated download must not mask a verified transfer that
    // still exists under a new ID. Check for a verified transfer first.
    if (hasDownloadIdentity(item)) {
      let recent = null;
      try { recent = await browser.downloads.search({}); }
      catch (error) { report(error); }
      if (recent) {
        const claimed = new Set(allItems()
          .filter(({ item: entry }) => entry !== item)
          .map(({ item: entry }) => entry.downloadId).filter(Number.isInteger));
        const verified = findVerifiedCandidate(context, item, recent, claimed);
        if (verified) {
          item.downloadId = verified.id;
          inspectDownload(context, item, verified);
          try { await persist(context); } catch (persistError) { report(persistError); }
          await pump().catch(report);
          return;
        }
      }
    }
    fail(owner.context, owner.item, 'Download removed from Firefox. Retry this file.');
    try { await persist(owner.context); } catch (persistError) { report(persistError); }
    await pump().catch(report);
  }).catch(report);
});

browser.windows.onRemoved.addListener(() => {
  void serialize(async () => {
    let stillPrivate = false;
    try { stillPrivate = (await browser.windows.getAll()).some((window) => window.incognito); }
    catch (error) { report(error); return; }
    if (stillPrivate) return;
    const context = contexts[1];
    for (const item of context.state.items) {
      item.cancelRequested = true; controllers.get(item.id)?.abort();
      controllers.get(`thumbnail-${item.id}`)?.abort(); pendingResumes.delete(item.id);
      if (activeState(item) && Number.isInteger(item.downloadId)) {
        // Verify before cancelling: a stale private ID must never cancel an
        // unrelated transfer.
        let live = null;
        try { [live] = await browser.downloads.search({ id: item.downloadId }); }
        catch { live = null; }
        const claimedForUpgrade = new Set();
        const verified = live ? isVerifiedOrUpgraded(context, item, live, claimedForUpgrade) : false;
        if (verified) {
          try { await browser.downloads.cancel(item.downloadId); } catch { /* Closing the window may already have cancelled it. */ }
        }
      }
      progressSamples.delete(item.downloadId);
    }
    context.state = emptyState(true);
    context.listUnresolved = false;
    context.draftUnresolved = false;
    try { await browser.storage.session.remove(PRIVATE_STORAGE_KEY); } catch (error) { report(error); }
    try { await browser.storage.session.remove(PRIVATE_DRAFT_STORAGE_KEY); } catch (error) { report(error); }
    await pump().catch(report);
  }).catch(report);
});
browser.action.onClicked.addListener((tab) => {
  void (async () => {
    const url = browser.runtime.getURL('app.html');
    const existing = (await browser.tabs.query({ windowId: tab.windowId })).find((entry) => entry.url === url);
    if (existing) { await browser.tabs.update(existing.id, { active: true }); await browser.windows.update(existing.windowId, { focused: true }); }
    else await browser.tabs.create({ url, windowId: tab.windowId });
  })().catch(report);
});
browser.runtime.onStartup.addListener(() => { void serialize(pump).catch(report); });
void serialize(pump).catch(report);
