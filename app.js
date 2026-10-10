const VD = globalThis.VideoDownloader || VideoDownloader;
const { STORAGE_KEY, PRIVATE_STORAGE_KEY, fileBasename, isSelectable, isSaved, formatBytes, formatDuration, createActionIcon } = VD;
const DRAFT_STORAGE_KEY = VD.DRAFT_STORAGE_KEY || 'downloaderDraft';
const PRIVATE_DRAFT_STORAGE_KEY = VD.PRIVATE_DRAFT_STORAGE_KEY || 'privateDownloaderDraft';
const SITE_ORIGIN = 'https://www.eporner.com/*';
const DRAFT_DELAY = 300;
const FILENAME_DELAY = 300;

function byId(id) {
  return document.getElementById(id);
}
const urlsEl = byId('urls');
const findBtn = byId('find');
const clearBtn = byId('clear');
const downloadBtn = byId('download');
const rowsEl = byId('rows');
const messageEl = byId('message');
const sessionEl = byId('session');
const askEl = byId('ask');
const savedRowsEl = byId('saved-rows');
const selectAllEl = byId('select-all');
const selectSavedEl = byId('select-all-saved');
const selectAllCompactEl = byId('select-all-compact');
const selectSavedCompactEl = byId('select-all-saved-compact');
const cancelSelectedBtn = byId('cancel-selected');
const removeSelectedBtn = byId('remove-selected');
const downloadSavedBtn = byId('download-saved');
const removeSavedBtn = byId('remove-saved');
const importFileEl = byId('import-file');
const qualityMaxEl = byId('quality-max');
const codecPrefEl = byId('codec-pref');
const concurrencyEl = byId('concurrency');
const permissionBannerEl = byId('permission-banner');
const grantAccessBtn = byId('grant-access');
const foundSearchEl = byId('found-search');
const foundStatusEl = byId('found-status');
const foundSortEl = byId('found-sort');
const foundPrevBtn = byId('found-prev');
const foundNextBtn = byId('found-next');
const foundPageInfoEl = byId('found-page-info');
const foundPageSizeEl = byId('found-page-size');
const foundHintEl = byId('found-selection-hint');
const savedSearchEl = byId('saved-search');
const savedStatusEl = byId('saved-status');
const savedSortEl = byId('saved-sort');
const savedPrevBtn = byId('saved-prev');
const savedNextBtn = byId('saved-next');
const savedPageInfoEl = byId('saved-page-info');
const savedPageSizeEl = byId('saved-page-size');
const savedHintEl = byId('saved-selection-hint');

let pendingImport = null;
let readingImport = false;
let importPhase = '';
let renameTarget = null;
let renameSelection = { authors: [], channel: '' };
let tagManagerBusy = false;
let reopenTagPicker = false;
let tagLibraryKey = '';
let tagPickerKey = '';
let scopeKey, scopeArea, draftKey, draftArea;
let state = { revision: -1, batchId: '', items: [], saveAs: false, maxHeight: 0, preferredCodec: 'AV1', input: '', inputRevision: 0 };
let loaded = false;
let actionPending = false;
let inputDirty = null;
let inputSequence = 0;
let draftTimer = null;
let draftInFlight = null;
const rowViews = new Map();
const rowActions = new Set();
const thumbnailCache = new Map();
let thumbnailTarget = null;
let thumbnailTimer = null;
let thumbnailSequence = 0;
const edits = new Map();
const liveProgress = new Map();
const filenameTimers = new Map();
const filenameFlights = new Map();
let editSequence = 0;
let progressTimer = null;
let pollingProgress = false;
let disposed = false;
let hasSitePermission = true;
let pendingSettings = null;
let pendingConcurrency = null;
let concurrencySequence = 0;
let settingsFlight = null;
let concurrencyFlight = null;
let backupBusy = false;
let backupText = null;
let settingsSeq = 0;
const filters = {
  found: { search: '', status: 'all', sort: 'default', page: 0, pageSize: 50 },
  saved: { search: '', status: 'all', sort: 'default', page: 0, pageSize: 50 },
};
const active = (item) => ['downloading', 'cancelling'].includes(item.state);
const tabContext = browser.tabs.getCurrent().then((tab) => {
  if (!tab) throw new Error('Open the downloader from the extension toolbar.');
  scopeKey = tab.incognito ? PRIVATE_STORAGE_KEY : STORAGE_KEY;
  scopeArea = tab.incognito ? 'session' : 'local';
  draftKey = tab.incognito ? PRIVATE_DRAFT_STORAGE_KEY : DRAFT_STORAGE_KEY;
  draftArea = tab.incognito ? 'session' : 'local';
  if (sessionEl) sessionEl.textContent = tab.incognito ? 'Private window' : 'Normal window';
  return tab;
});
tabContext.catch(() => { }).then(() => { void refreshPermission(); });

function statusText(item) {
  switch (item.state) {
    case 'finding': return 'Finding links…';
    case 'ready': return 'Ready';
    case 'queued': return 'Queued';
    case 'downloading': return item.resuming ? 'Resuming…' : item.paused ? item.resumeError || 'Paused' : 'Downloading…';
    case 'cancelling': return 'Cancel requested…';
    case 'cancelled': return 'Cancelled';
    case 'done': return 'Saved';
    case 'failed': return `Failed: ${item.error}`;
    case 'error': return `Error: ${item.error}`;
    default: return '';
  }
}
function currentMaxHeight() {
  if (qualityMaxEl && typeof qualityMaxEl.value === 'string' && qualityMaxEl.value !== '') {
    const value = Number(qualityMaxEl.value);
    return Number.isFinite(value) ? value : 0;
  }
  if (pendingSettings && typeof pendingSettings.maxHeight === 'number') return pendingSettings.maxHeight;
  return Number.isFinite(state.maxHeight) ? state.maxHeight : 0;
}
function currentCodec() {
  if (codecPrefEl && typeof codecPrefEl.value === 'string' && codecPrefEl.value !== '') return codecPrefEl.value;
  if (pendingSettings && typeof pendingSettings.preferredCodec === 'string') return pendingSettings.preferredCodec;
  return state.preferredCodec || 'AV1';
}
function effectiveItem(original) {
  return { ...original, ...edits.get(original.id)?.values };
}
function isSelected(item) {
  return edits.get(item.id)?.values.selected ?? item.selected;
}
function filenameFor(item) {
  const pending = edits.get(item.id)?.values.filename;
  if (typeof pending === 'string') return pending;
  return item.filename || '';
}
function setMessage(text, kind) {
  const targets = [messageEl, byId('settings-dialog')?.open ? byId('settings-message') : null];
  for (const target of targets) {
    if (!target) continue;
    target.textContent = text || '';
    if (target.classList) {
      target.classList.remove('error', 'notice');
      if (kind) target.classList.add(kind);
    }
    if (!kind) target.removeAttribute('data-kind');
    else target.setAttribute('data-kind', kind);
  }
}
async function request(message) {
  const tab = await tabContext;
  const response = await browser.runtime.sendMessage({ ...message, tabId: tab.id });
  if (!response?.ok) throw new Error(response?.error || 'The background queue is unavailable. Reload the extension.');
  return response.state;
}
function cell(child) { const td = document.createElement('td'); td.append(child); return td; }
function labeledCell(child, label) {
  const td = cell(child);
  td.setAttribute('data-label', label);
  return td;
}
function actionIcon(button, icon, label) {
  button.title = label;
  button.setAttribute('aria-label', label);
  button.classList.add('icon-button');
  button.replaceChildren(createActionIcon(document, icon));
}
function hideThumbnail() {
  if (thumbnailTimer !== null) { clearTimeout(thumbnailTimer); thumbnailTimer = null; }
  thumbnailSequence++;
  thumbnailTarget?.link.removeAttribute('aria-describedby');
  thumbnailTarget = null;
  if (byId('thumbnail-preview')) byId('thumbnail-preview').hidden = true;
}
function positionThumbnail() {
  const preview = byId('thumbnail-preview');
  const rect = thumbnailTarget?.link.getBoundingClientRect?.();
  if (!preview || !rect) return;
  const width = Math.min(320, window.innerWidth - 24);
  const height = preview.offsetHeight || 194;
  preview.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
  const below = rect.bottom + 8;
  preview.style.top = `${Math.max(12, below + height <= window.innerHeight - 12 ? below : rect.top - height - 8)}px`;
}
function showThumbnail(id, link) {
  hideThumbnail();
  thumbnailTarget = { id, link };
  const sequence = thumbnailSequence;
  thumbnailTimer = setTimeout(() => {
    thumbnailTimer = null;
    void (async () => {
      const preview = byId('thumbnail-preview'), image = byId('thumbnail-image'), status = byId('thumbnail-status');
      const item = state.items.find((entry) => entry.id === id);
      if (!preview || !item || sequence !== thumbnailSequence) return;
      link.setAttribute('aria-describedby', 'thumbnail-preview');
      preview.hidden = false; image.hidden = true; status.hidden = false;
      status.textContent = 'Loading thumbnail…'; positionThumbnail();
      let url = VD.thumbnailUrl(item.thumbnail, item.pageUrl);
      if (!url) {
        if (!thumbnailCache.has(id)) thumbnailCache.set(id, request({ type: 'thumbnail', batchId: state.batchId, id })
          .then((value) => {
            applyState(value);
            const updated = value.items.find((entry) => entry.id === id);
            return { url: VD.thumbnailUrl(updated?.thumbnail, item.pageUrl) };
          }).catch((error) => ({ error: error.message })));
        const result = await thumbnailCache.get(id);
        if (sequence !== thumbnailSequence) return;
        url = result.url;
        if (result.error) { status.textContent = `Thumbnail unavailable: ${result.error}`; return; }
      }
      if (sequence !== thumbnailSequence) return;
      if (!url) { status.textContent = 'No thumbnail available.'; return; }
      image.alt = `Thumbnail for ${item.title || 'video'}`;
      image.onload = () => {
        if (sequence !== thumbnailSequence) return;
        status.hidden = true; image.hidden = false; positionThumbnail();
      };
      image.onerror = () => {
        if (sequence !== thumbnailSequence) return;
        image.hidden = true; status.hidden = false; status.textContent = 'Thumbnail could not be loaded.';
      };
      image.src = url;
      if (image.complete && image.naturalWidth > 0) image.onload();
    })();
  }, 180);
}
function createRow(item) {
  const tr = document.createElement('tr');
  tr.className = 'video-row'; tr.tabIndex = 0;
  const toggleRow = () => {
    if (loaded && !actionPending && !readingImport) {
      const view = rowViews.get(item.id);
      const checked = view ? view.check.checked : Boolean(isSelected(item));
      void saveSelection(item.id, !checked);
    }
  };
  tr.addEventListener('click', (event) => { if (!event.target.closest('a, button, input, select, textarea, label')) toggleRow(); });
  tr.addEventListener('keydown', (event) => {
    if (event.target === tr && [' ', 'Enter'].includes(event.key)) { event.preventDefault(); toggleRow(); }
  });
  const check = document.createElement('input'); check.type = 'checkbox';
  check.setAttribute('aria-label', 'Select video');
  check.addEventListener('change', () => { void saveSelection(item.id, check.checked); });
  const nameInput = document.createElement('input'); nameInput.className = 'name';
  nameInput.setAttribute('aria-label', 'File name without .mp4');
  nameInput.addEventListener('input', () => { queueFilenameEdit(item.id, nameInput.value); });
  nameInput.addEventListener('blur', () => { void flushFilenameEdit(item.id).catch(() => { }); });
  const titleLink = document.createElement('a'); titleLink.target = '_blank'; titleLink.rel = 'noopener noreferrer';
  titleLink.addEventListener('mouseenter', () => showThumbnail(item.id, titleLink));
  titleLink.addEventListener('mouseleave', () => { if (thumbnailTarget?.link === titleLink) hideThumbnail(); });
  titleLink.addEventListener('focus', () => showThumbnail(item.id, titleLink));
  titleLink.addEventListener('blur', () => { if (thumbnailTarget?.link === titleLink) hideThumbnail(); });
  const history = document.createElement('div'); history.className = 'history-detail';
  const title = document.createElement('td'); title.setAttribute('data-label', 'Title'); title.append(titleLink, history);
  const quality = document.createElement('td'); quality.setAttribute('data-label', 'Quality');
  const qualitySelect = document.createElement('select'); qualitySelect.className = 'row-quality';
  qualitySelect.setAttribute('aria-label', 'Quality for next download');
  qualitySelect.addEventListener('change', () => {
    void perform({
      type: 'quality', batchId: state.batchId, id: item.id,
      height: qualitySelect.value === '' ? null : Number(qualitySelect.value)
    });
  });
  const qualityDetail = document.createElement('div'); qualityDetail.className = 'history-detail';
  const checkQuality = document.createElement('button'); checkQuality.className = 'secondary quality-check';
  checkQuality.textContent = 'Check qualities';
  checkQuality.addEventListener('click', () => { void perform({ type: 'check-quality', batchId: state.batchId, id: item.id }); });
  quality.append(qualitySelect, qualityDetail, checkQuality);
  const nameCell = document.createElement('td'); nameCell.className = 'filename-cell'; nameCell.setAttribute('data-label', 'File name');
  const nameEditor = document.createElement('div'); nameEditor.className = 'filename-editor';
  const rename = document.createElement('button'); rename.className = 'secondary rename-button';
  rename.type = 'button'; actionIcon(rename, 'pencil', 'Choose author and channel tags');
  rename.addEventListener('click', () => openRename(item.id));
  nameEditor.append(nameInput, rename); nameCell.append(nameEditor);
  const progressCell = document.createElement('td'); progressCell.setAttribute('data-label', 'Progress');
  const progress = document.createElement('progress'); progress.className = 'download-progress'; progress.max = 100;
  progress.setAttribute('aria-label', 'Download progress');
  const transfer = document.createElement('div'); transfer.className = 'transfer-size';
  const speed = document.createElement('span');
  const eta = document.createElement('span'); eta.className = 'remaining-time'; eta.title = 'Estimated time remaining';
  const rate = document.createElement('div'); rate.className = 'transfer-speed transfer-rate'; rate.append(speed, eta);
  progressCell.append(progress, transfer, rate);
  const status = document.createElement('td'); status.setAttribute('data-label', 'Status');
  const actions = document.createElement('td'); actions.className = 'row-actions'; actions.setAttribute('data-label', 'Actions');
  const download = document.createElement('button'); download.className = 'secondary';
  download.addEventListener('click', () => downloadItems([item.id]));
  const cancel = document.createElement('button'); cancel.className = 'secondary'; actionIcon(cancel, 'cancel', 'Cancel download');
  cancel.addEventListener('click', () => { void perform({ type: 'cancel', batchId: state.batchId, id: item.id }); });
  const remove = document.createElement('button'); remove.className = 'secondary danger'; actionIcon(remove, 'trash', 'Remove video');
  remove.addEventListener('click', () => { void perform({ type: 'remove', batchId: state.batchId, id: item.id }); });
  const pause = document.createElement('button'); pause.className = 'secondary'; actionIcon(pause, 'pause', 'Pause download');
  pause.addEventListener('click', () => { void perform({ type: 'pause', batchId: state.batchId, id: item.id }); });
  const resume = document.createElement('button'); resume.className = 'secondary'; actionIcon(resume, 'play', 'Resume download');
  resume.addEventListener('click', () => { void perform({ type: 'resume', batchId: state.batchId, id: item.id }); });
  const showFile = document.createElement('button'); showFile.className = 'secondary'; actionIcon(showFile, 'folder', 'Show in folder');
  showFile.addEventListener('click', () => { void perform({ type: 'show-file', batchId: state.batchId, id: item.id }); });
  actions.append(download, cancel, remove, pause, resume, showFile);
  const checkCell = document.createElement('td'); checkCell.setAttribute('data-label', 'Select'); checkCell.append(check);
  tr.append(checkCell, title, quality, nameCell, progressCell, status, actions);
  return { id: item.id, tr, check, nameInput, rename, titleLink, history, quality, qualitySelect, qualityDetail, checkQuality, progress, transfer, speed, eta, rate, status, download, cancel, remove, pause, resume, showFile, cache: {} };
}
function isImportedOnly(item) {
  if (item.state !== 'done') return false;
  if ((item.bytesReceived ?? 0) > 0 || (item.totalBytes ?? 0) > 0) return false;
  const history = item.history || [];
  if (!history.length) return false;
  return history.some((entry) => entry.imported);
}
function renderProgress(item, view) {
  const cache = view.cache;
  const cached = liveProgress.get(item.id);
  const stats = cached && cached.downloadId === item.downloadId && cached.attempt === item.attempt ? cached.progress : null;
  let progressHidden; let rateHidden; let progressValue = null; let indeterminate = false;
  let transferText; let speedText = ''; let etaText = '';
  if (isImportedOnly(item)) {
    progressHidden = true; rateHidden = true;
    const latest = (item.history || [])[(item.history || []).length - 1] || {};
    if (Number.isFinite(latest.bytesReceived) && Number.isFinite(latest.totalBytes) && latest.totalBytes > 0) {
      transferText = `100% · ${formatBytes(latest.bytesReceived)} / ${formatBytes(latest.totalBytes)}`;
    } else if (Number.isFinite(latest.bytesReceived) && latest.bytesReceived > 0) {
      transferText = `${formatBytes(latest.bytesReceived)} downloaded · size unknown`;
    } else {
      transferText = 'Imported history · size unknown';
    }
  } else {
    const bytes = stats?.bytesReceived ?? item.bytesReceived ?? 0;
    const total = stats ? stats.totalBytes : item.totalBytes;
    const running = active(item);
    const show = running || item.state === 'done' || (['failed', 'cancelled'].includes(item.state) && bytes > 0);
    progressHidden = !show; rateHidden = !running;
    if (!show) {
      transferText = '—';
    } else if (item.state === 'done') {
      progressValue = 100;
      transferText = total > 0
        ? `100% · ${formatBytes(bytes)} / ${formatBytes(total)}`
        : `${formatBytes(bytes)} downloaded · size unknown`;
    } else if (total > 0) {
      progressValue = Math.min(100, bytes * 100 / total);
      const percent = Math.min(100, bytes * 100 / total);
      transferText = `${percent.toFixed(1)}% · ${formatBytes(bytes)} / ${formatBytes(total)}`;
    } else {
      indeterminate = true;
      transferText = `${formatBytes(bytes)} downloaded · size unknown`;
    }
    if (running && show) {
      const paused = stats?.paused ?? item.paused;
      speedText = item.state === 'cancelling' ? 'Cancelling…' : paused ? 'Paused' : stats?.bytesPerSecond == null
        ? 'Calculating speed…' : `${formatBytes(stats.bytesPerSecond)}/s`;
      etaText = paused || item.state === 'cancelling' ? '—' : formatDuration(stats?.etaSeconds);
    }
  }
  if (cache.progressHidden !== progressHidden) { view.progress.hidden = progressHidden; cache.progressHidden = progressHidden; }
  if (cache.rateHidden !== rateHidden) { view.rate.hidden = rateHidden; cache.rateHidden = rateHidden; }
  if (progressHidden) {
    if (cache.progressValue !== null || cache.progressIndeterminate) { cache.progressValue = null; cache.progressIndeterminate = false; }
  } else if (indeterminate) {
    if (!cache.progressIndeterminate) { view.progress.removeAttribute('value'); cache.progressIndeterminate = true; cache.progressValue = null; }
  } else if (cache.progressValue !== progressValue || cache.progressIndeterminate) {
    view.progress.value = progressValue;
    cache.progressValue = progressValue; cache.progressIndeterminate = false;
  }
  if (cache.transferText !== transferText) { view.transfer.textContent = transferText; cache.transferText = transferText; }
  if (cache.speedText !== speedText) { view.speed.textContent = speedText; cache.speedText = speedText; }
  if (cache.etaText !== etaText) { view.eta.textContent = etaText; cache.etaText = etaText; }
}
function updateView(view, item, locked) {
  const cache = view.cache;
  const checked = Boolean(item.selected);
  if (cache.checked !== checked) { view.check.checked = checked; cache.checked = checked; }
  const checkDisabled = locked;
  if (cache.checkDisabled !== checkDisabled) { view.check.disabled = checkDisabled; cache.checkDisabled = checkDisabled; }
  const aria = String(Boolean(item.selected));
  if (cache.aria !== aria) { view.tr.setAttribute('aria-selected', aria); cache.aria = aria; }
  const cls = `video-row${item.selected ? ' selected' : ''}`;
  if (cache.cls !== cls) { view.tr.className = cls; cache.cls = cls; }
  const nameDisabled = locked || !isSelectable(item);
  if (cache.nameDisabled !== nameDisabled) { view.nameInput.disabled = nameDisabled; cache.nameDisabled = nameDisabled; }
  view.rename.disabled = nameDisabled;
  if (document.activeElement !== view.nameInput) {
    const nameValue = item.filename || '';
    if (cache.nameValue !== nameValue || view.nameInput.value !== nameValue) {
      view.nameInput.value = nameValue; cache.nameValue = nameValue;
    }
  } else if (cache.nameValue !== item.filename) cache.nameValue = item.filename;
  const titleText = item.title || item.pageUrl;
  if (cache.titleText !== titleText) { view.titleLink.textContent = titleText; cache.titleText = titleText; }
  if (cache.href !== item.pageUrl) { view.titleLink.href = item.pageUrl; cache.href = item.pageUrl; }
  const saved = item.history || [];
  const historyHidden = !saved.length;
  if (cache.historyHidden !== historyHidden) { view.history.hidden = historyHidden; cache.historyHidden = historyHidden; }
  if (saved.length) {
    const latest = saved[saved.length - 1];
    const when = latest.savedAt ? new Date(latest.savedAt).toLocaleString() : 'previously';
    const text = latest.imported && !latest.savedAt ? 'Imported saved entry'
      : `Saved ${saved.length} time(s) · last ${when}`;
    if (cache.historyText !== text) { view.history.textContent = text; cache.historyText = text; }
    const historyTitle = latest.filename || '';
    if (cache.historyTitle !== historyTitle) { view.history.title = historyTitle; cache.historyTitle = historyTitle; }
  } else if (cache.historyText !== '') { view.history.textContent = ''; cache.historyText = ''; }
  const heights = item.availableHeights || [];
  const qualityKey = JSON.stringify([heights, item.qualityHeight, state.maxHeight]);
  if (cache.qualityKey !== qualityKey) {
    const options = [['', `Default (${state.maxHeight ? `up to ${state.maxHeight}p` : 'highest'})`],
    ...heights.map((height) => [String(height), `${height}p`])];
    if (item.qualityHeight != null && !heights.includes(item.qualityHeight)) options.push([String(item.qualityHeight), `${item.qualityHeight}p (check availability)`]);
    view.qualitySelect.replaceChildren(...options.map(([value, text]) => {
      const option = document.createElement('option'); option.value = value; option.textContent = text; return option;
    }));
    cache.qualityKey = qualityKey;
  }
  view.qualitySelect.value = item.qualityHeight == null ? '' : String(item.qualityHeight);
  view.qualitySelect.disabled = nameDisabled || !heights.length;
  view.qualitySelect.title = 'Resolution for the next download; overrides Quality max';
  view.checkQuality.hidden = heights.length > 0 && (item.qualityHeight == null || heights.includes(item.qualityHeight));
  view.checkQuality.disabled = nameDisabled;
  const qualityText = `${heights.length ? `Max ${heights[0]}p` : 'Available qualities unknown'}${item.height ? ` · ${item.height}p ${item.codec || ''} link` : ''}`;
  if (cache.qualityText !== qualityText) { view.qualityDetail.textContent = qualityText; cache.qualityText = qualityText; }
  renderProgress(item, view);
  const badgeText = statusText(item);
  const badgeClass = `badge ${item.state}${item.paused ? ' paused' : ''}`;
  if (cache.badgeText !== badgeText || cache.badgeClass !== badgeClass) {
    const badge = document.createElement('span'); badge.className = badgeClass;
    badge.textContent = badgeText; badge.title = badgeText;
    view.status.replaceChildren(badge); cache.badgeText = badgeText; cache.badgeClass = badgeClass;
  }
  const downloadHidden = !isSelectable(item);
  if (cache.downloadHidden !== downloadHidden) { view.download.hidden = downloadHidden; cache.downloadHidden = downloadHidden; }
  const downloadDisabled = locked;
  if (cache.downloadDisabled !== downloadDisabled) { view.download.disabled = downloadDisabled; cache.downloadDisabled = downloadDisabled; }
  const downloadIcon = item.state === 'ready' ? 'download' : 'retry';
  const downloadLabel = item.state === 'done' ? 'Download again' : item.state === 'ready' ? 'Download video' : 'Retry download';
  if (cache.downloadIcon !== downloadIcon || cache.downloadLabel !== downloadLabel) {
    actionIcon(view.download, downloadIcon, downloadLabel); cache.downloadIcon = downloadIcon; cache.downloadLabel = downloadLabel;
  } else if (view.download.title !== downloadLabel) view.download.title = downloadLabel;
  const cancelHidden = !['queued', 'downloading', 'cancelling'].includes(item.state);
  if (cache.cancelHidden !== cancelHidden) { view.cancel.hidden = cancelHidden; cache.cancelHidden = cancelHidden; }
  const cancelDisabled = locked || item.state === 'cancelling';
  if (cache.cancelDisabled !== cancelDisabled) { view.cancel.disabled = cancelDisabled; cache.cancelDisabled = cancelDisabled; }
  const removeDisabled = locked;
  if (cache.removeDisabled !== removeDisabled) { view.remove.disabled = removeDisabled; cache.removeDisabled = removeDisabled; }
  const hasDownloadId = Number.isInteger(item.downloadId);
  const pauseHidden = !(item.state === 'downloading' && !item.paused && hasDownloadId);
  if (cache.pauseHidden !== pauseHidden) { view.pause.hidden = pauseHidden; cache.pauseHidden = pauseHidden; }
  const pauseDisabled = locked || rowActions.has(item.id) || item.resuming === true;
  if (cache.pauseDisabled !== pauseDisabled) { view.pause.disabled = pauseDisabled; cache.pauseDisabled = pauseDisabled; }
  const resumeHidden = !(item.state === 'downloading' && item.paused && hasDownloadId);
  if (cache.resumeHidden !== resumeHidden) { view.resume.hidden = resumeHidden; cache.resumeHidden = resumeHidden; }
  const resumeDisabled = locked || rowActions.has(item.id) || item.resuming === true;
  if (cache.resumeDisabled !== resumeDisabled) { view.resume.disabled = resumeDisabled; cache.resumeDisabled = resumeDisabled; }
  const hasLocalHistory = (item.history || []).some((entry) => !entry.imported);
  const showHidden = !(item.state === 'done' && hasDownloadId && !isImportedOnly(item) && hasLocalHistory);
  if (cache.showHidden !== showHidden) { view.showFile.hidden = showHidden; cache.showHidden = showHidden; }
  const showDisabled = locked;
  if (cache.showDisabled !== showDisabled) { view.showFile.disabled = showDisabled; cache.showDisabled = showDisabled; }
}
function readFilter(section) {
  const f = filters[section];
  const searchEl = section === 'found' ? foundSearchEl : savedSearchEl;
  const statusEl = section === 'found' ? foundStatusEl : savedStatusEl;
  const sortEl = section === 'found' ? foundSortEl : savedSortEl;
  const sizeEl = section === 'found' ? foundPageSizeEl : savedPageSizeEl;
  if (searchEl && typeof searchEl.value === 'string') f.search = searchEl.value;
  if (statusEl && typeof statusEl.value === 'string' && statusEl.value) f.status = statusEl.value;
  if (sortEl && typeof sortEl.value === 'string' && sortEl.value) f.sort = sortEl.value;
  if (sizeEl && (sizeEl.value === '50' || sizeEl.value === '100')) f.pageSize = Number(sizeEl.value);
  return f;
}
function applyFilterSort(list, f) {
  let out = list;
  const query = (f.search || '').trim().toLowerCase();
  if (query) {
    out = out.filter((item) => `${item.title || ''}\n${item.filename || ''}\n${item.pageUrl || ''}`.toLowerCase().includes(query));
  }
  if (f.status && f.status !== 'all') {
    if (f.status === 'failed') out = out.filter((item) => item.state === 'failed' || item.state === 'error');
    else out = out.filter((item) => item.state === f.status);
  }
  if (f.sort === 'title-asc') out = [...out].sort((a, b) => `${a.title || a.pageUrl}`.localeCompare(`${b.title || b.pageUrl}`));
  else if (f.sort === 'quality-desc') out = [...out].sort((a, b) => (b.height || 0) - (a.height || 0));
  else if (f.sort === 'quality-asc') out = [...out].sort((a, b) => (a.height || 0) - (b.height || 0));
  return out;
}
function setEmpty(body, text) {
  const existing = body.querySelector('.empty');
  if (existing) {
    const td = existing.children && existing.children[0];
    if (td && td.textContent !== text) td.textContent = text;
    return;
  }
  const tr = document.createElement('tr'); tr.className = 'empty';
  const td = document.createElement('td'); td.colSpan = 7; td.textContent = text; tr.append(td); body.append(tr);
}
function reconcileHost(host, desiredViews) {
  if (!host) return;
  for (const child of [...host.children]) {
    if (child.className && String(child.className).startsWith('video-row')) {
      let wanted = false;
      for (const view of desiredViews) {
        if (view.tr === child) { wanted = true; break; }
      }
      if (!wanted) child.remove();
    }
  }
  if (desiredViews.length) {
    const empty = host.querySelector('.empty');
    if (empty) empty.remove();
  }
  let anchor = null;
  for (let i = desiredViews.length - 1; i >= 0; i--) {
    const tr = desiredViews[i].tr;
    if (tr.parentNode !== host || tr.nextSibling !== anchor) {
      host.insertBefore(tr, anchor);
    }
    anchor = tr;
  }
}
function render() {
  const locked = !loaded || actionPending || readingImport || backupBusy;
  if (byId('open-settings')) byId('open-settings').disabled = locked;
  if (byId('settings-close')) byId('settings-close').disabled = backupBusy;
  renderImportStatus();
  if (byId('manage-name-tags')) byId('manage-name-tags').disabled = locked;
  renderTagLibrary();
  if (byId('rename-dialog')?.open) renderTagPicker();
  const currentIds = new Set(state.items.map((item) => item.id));
  if (thumbnailTarget && !currentIds.has(thumbnailTarget.id)) hideThumbnail();
  for (const id of thumbnailCache.keys()) if (!currentIds.has(id)) thumbnailCache.delete(id);
  for (const id of [...rowViews.keys()]) if (!currentIds.has(id)) {
    rowViews.get(id).tr.remove();
    rowViews.delete(id); edits.delete(id); liveProgress.delete(id);
    if (filenameTimers.has(id)) { clearTimeout(filenameTimers.get(id)); filenameTimers.delete(id); }
  }
  // A removed item may have been on another page, without a cached row.
  for (const id of edits.keys()) if (!currentIds.has(id)) {
    edits.delete(id);
    if (filenameTimers.has(id)) { clearTimeout(filenameTimers.get(id)); filenameTimers.delete(id); }
  }
  for (const id of liveProgress.keys()) if (!currentIds.has(id)) liveProgress.delete(id);
  const foundAll = state.items.filter((item) => !isSaved({ ...item, ...edits.get(item.id)?.values }));
  const savedAll = state.items.filter((item) => isSaved({ ...item, ...edits.get(item.id)?.values }));
  const foundFilter = readFilter('found');
  const savedFilter = readFilter('saved');
  const foundFiltered = applyFilterSort(foundAll.map(effectiveItem), foundFilter);
  const savedFiltered = applyFilterSort(savedAll.map(effectiveItem), savedFilter);
  const foundPages = Math.max(1, Math.ceil(foundFiltered.length / foundFilter.pageSize));
  const savedPages = Math.max(1, Math.ceil(savedFiltered.length / savedFilter.pageSize));
  if (foundFilter.page >= foundPages) foundFilter.page = foundPages - 1;
  if (savedFilter.page >= savedPages) savedFilter.page = savedPages - 1;
  if (foundFilter.page < 0) foundFilter.page = 0;
  if (savedFilter.page < 0) savedFilter.page = 0;
  const foundPage = foundFiltered.slice(foundFilter.page * foundFilter.pageSize, (foundFilter.page + 1) * foundFilter.pageSize);
  const savedPage = savedFiltered.slice(savedFilter.page * savedFilter.pageSize, (savedFilter.page + 1) * savedFilter.pageSize);
  const visibleIds = new Set([...foundPage, ...savedPage].map((item) => item.id));
  for (const [id, view] of [...rowViews]) {
    if (!visibleIds.has(id)) {
      if (thumbnailTarget?.id === id) hideThumbnail();
      view.tr.remove();
      rowViews.delete(id);
    }
  }
  const renderSection = (body, all, filtered, page, filter, emptyLabel) => {
    if (!body) return;
    if (!all.length) setEmpty(body, emptyLabel);
    else if (!filtered.length) setEmpty(body, 'No videos match the current search or filter.');
    else {
      const stale = body.querySelector('.empty');
      if (stale) stale.remove();
    }
    for (const item of page) {
      if (!rowViews.has(item.id)) rowViews.set(item.id, createRow(item));
    }
    const desired = [];
    for (const item of page) {
      const view = rowViews.get(item.id);
      if (view) desired.push(view);
    }
    reconcileHost(body, desired);
    for (const item of page) {
      const view = rowViews.get(item.id);
      if (view) updateView(view, item, locked);
    }
  };
  renderSection(rowsEl, foundAll, foundFiltered, foundPage, foundFilter, 'No found videos.');
  renderSection(savedRowsEl, savedAll, savedFiltered, savedPage, savedFilter, 'No saved videos.');
  const selectedIds = (list) => list.filter((item) => effectiveItem(item).selected).map((item) => item.id);
  const foundSelectedIds = new Set(selectedIds(foundAll));
  const savedSelectedIds = new Set(selectedIds(savedAll));
  const foundVisibleSelected = foundFiltered.filter((item) => foundSelectedIds.has(item.id));
  const savedVisibleSelected = savedFiltered.filter((item) => savedSelectedIds.has(item.id));
  const updateHint = (el, allSelected, visibleSelected) => {
    if (!el) return;
    const hidden = allSelected - visibleSelected;
    if (hidden > 0) {
      el.hidden = false;
      el.textContent = `${allSelected} selected in total · ${visibleSelected} shown with the current filter. Bulk actions apply to shown rows.`;
    } else if (allSelected > 0 && visibleSelected !== allSelected) {
      el.hidden = false;
      el.textContent = `${allSelected} selected.`;
    } else { el.hidden = true; el.textContent = ''; }
  };
  updateHint(foundHintEl, foundSelectedIds.size, foundVisibleSelected.length);
  updateHint(savedHintEl, savedSelectedIds.size, savedVisibleSelected.length);
  const updatePager = (prev, next, info, filter, total) => {
    const pages = Math.max(1, Math.ceil(total / filter.pageSize));
    if (info) info.textContent = total ? `Page ${filter.page + 1} of ${pages}` : '';
    if (prev) prev.disabled = locked || filter.page <= 0;
    if (next) next.disabled = locked || filter.page + 1 >= pages;
  };
  updatePager(foundPrevBtn, foundNextBtn, foundPageInfoEl, foundFilter, foundFiltered.length);
  updatePager(savedPrevBtn, savedNextBtn, savedPageInfoEl, savedFilter, savedFiltered.length);
  if (findBtn) findBtn.disabled = locked;
  if (clearBtn) clearBtn.disabled = locked || !(urlsEl && urlsEl.value);
  if (downloadBtn) downloadBtn.disabled = locked || !foundVisibleSelected.some(isSelectable);
  if (downloadSavedBtn) downloadSavedBtn.disabled = locked || !savedVisibleSelected.some(isSelectable);
  if (cancelSelectedBtn) cancelSelectedBtn.disabled = locked || !foundVisibleSelected.some((item) => !active(item));
  if (removeSelectedBtn) removeSelectedBtn.disabled = locked || !foundVisibleSelected.some((item) => !active(item));
  if (removeSavedBtn) removeSavedBtn.disabled = locked || !savedVisibleSelected.some((item) => !active(item));
  const updateSelectAll = (box, all, visibleSelected) => {
    if (!box) return;
    box.disabled = locked || !all.length;
    box.checked = Boolean(all.length) && visibleSelected.length === all.length && all.length > 0;
    box.indeterminate = visibleSelected.length > 0 && visibleSelected.length < all.length;
    const label = box === selectAllEl || box === selectAllCompactEl ? 'Select all filtered found videos' : 'Select all filtered saved videos';
    box.setAttribute('aria-label', label); box.title = label;
  };
  const foundBasis = (foundFilter.search || foundFilter.status !== 'all') ? foundFiltered : foundAll.map(effectiveItem);
  const savedBasis = (savedFilter.search || savedFilter.status !== 'all') ? savedFiltered : savedAll.map(effectiveItem);
  const foundBasisSelected = foundBasis.filter((item) => (foundSelectedIds.has(item.id)));
  const savedBasisSelected = savedBasis.filter((item) => (savedSelectedIds.has(item.id)));
  updateSelectAll(selectAllEl, foundBasis, foundBasisSelected);
  updateSelectAll(selectSavedEl, savedBasis, savedBasisSelected);
  updateSelectAll(selectAllCompactEl, foundBasis, foundBasisSelected);
  updateSelectAll(selectSavedCompactEl, savedBasis, savedBasisSelected);
  for (const section of ['found', 'saved']) {
    const exportBtn = byId(`export-${section}`);
    const importBtn = byId(`import-${section}`);
    const formatEl = byId(`${section}-format`);
    const list = section === 'found' ? foundAll : savedAll;
    if (exportBtn) exportBtn.disabled = locked || !list.length;
    if (importBtn) importBtn.disabled = locked || VD.importStatus(state)?.busy === true;
    if (formatEl) formatEl.disabled = locked;
  }
  if (urlsEl) urlsEl.disabled = !loaded;
  if (askEl) {
    askEl.disabled = locked;
    const desiredSaveAs = pendingSettings && typeof pendingSettings.saveAs === 'boolean' ? pendingSettings.saveAs : state.saveAs;
    if (askEl.checked !== desiredSaveAs) askEl.checked = desiredSaveAs;
  }
  if (qualityMaxEl) {
    const desired = pendingSettings && typeof pendingSettings.maxHeight === 'number'
      ? String(pendingSettings.maxHeight)
      : String(state.maxHeight ?? 0);
    if (qualityMaxEl.value !== desired) qualityMaxEl.value = desired;
    qualityMaxEl.disabled = locked;
  }
  if (codecPrefEl) {
    const desired = pendingSettings && typeof pendingSettings.preferredCodec === 'string'
      ? pendingSettings.preferredCodec
      : state.preferredCodec || 'AV1';
    if (codecPrefEl.value !== desired) codecPrefEl.value = desired;
    codecPrefEl.disabled = locked;
  }
  if (concurrencyEl) {
    concurrencyEl.value = String(pendingConcurrency?.value ?? state.concurrency ?? VD.CONCURRENCY);
    concurrencyEl.disabled = locked;
  }
  for (const id of ['export-backup', 'import-backup']) if (byId(id)) byId(id).disabled = locked;
  scheduleProgressPoll();
}
function applyState(value) {
  if (!value || value.revision < state.revision) return;
  if (loaded && value.batchId && value.batchId !== state.batchId) {
    hideThumbnail(); edits.clear(); liveProgress.clear(); thumbnailCache.clear();
    for (const timer of filenameTimers.values()) clearTimeout(timer);
    filenameTimers.clear();
    reopenTagPicker = false;
    for (const id of ['rename-dialog', 'name-tags-dialog']) if (byId(id)?.open) byId(id).close();
    renameTarget = null;
    inputDirty = null;
    if (draftTimer !== null) { clearTimeout(draftTimer); draftTimer = null; }
    pendingSettings = null; settingsSeq++; pendingConcurrency = null; concurrencySequence++;
  }
  value = { ...value, items: (value.items || []).filter((item) => !item.removeRequested) };
  for (const item of value.items) {
    const cached = liveProgress.get(item.id);
    if (cached && (cached.downloadId !== item.downloadId || cached.attempt !== item.attempt)) liveProgress.delete(item.id);
    if (item.progress && (!liveProgress.has(item.id) || item.progress.sampledAt >= liveProgress.get(item.id).progress.sampledAt)) {
      liveProgress.set(item.id, { downloadId: item.downloadId, attempt: item.attempt, progress: item.progress });
    }
  }
  const prevInput = state.input ?? '';
  const prevRevision = typeof state.inputRevision === 'number' ? state.inputRevision : 0;
  let nextInput = prevInput;
  let nextRevision = prevRevision;
  if (value.input !== undefined || value.inputRevision !== undefined) {
    if (typeof value.inputRevision === 'number') {
      if (!loaded || value.inputRevision > prevRevision) {
        nextRevision = value.inputRevision;
        nextInput = typeof value.input === 'string' ? value.input : prevInput;
      }
    } else if (typeof value.input === 'string') {
      nextInput = value.input;
    }
  }
  state = { maxHeight: 0, preferredCodec: 'AV1', ...value, input: nextInput, inputRevision: nextRevision };
  loaded = true;
  const desiredInput = inputDirty?.value ?? state.input ?? '';
  if (urlsEl && urlsEl.value !== desiredInput) urlsEl.value = desiredInput;
  render();
}
function scheduleProgressPoll() {
  const running = loaded && state.items.some(active);
  if (disposed || (typeof document !== 'undefined' && document.hidden) || !running) {
    if (progressTimer !== null) { clearTimeout(progressTimer); progressTimer = null; }
  } else if (progressTimer === null && !pollingProgress) {
    progressTimer = setTimeout(() => { progressTimer = null; void pollProgress(); }, 1000);
  }
}
async function pollProgress() {
  if (disposed || (typeof document !== 'undefined' && document.hidden) || pollingProgress) return;
  pollingProgress = true;
  try { applyState(await request({ type: 'get-progress' })); } catch { /* Retry on the next tick. */ }
  finally { pollingProgress = false; scheduleProgressPoll(); }
}
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('visibilitychange', () => {
    scheduleProgressPoll(); if (!document.hidden && state.items.some(active)) void pollProgress();
  });
}
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('pagehide', () => {
    hideThumbnail();
    disposed = true;
    if (progressTimer !== null) { clearTimeout(progressTimer); progressTimer = null; }
    void flushDraft(true).catch(() => { });
    void flushAllFilenames(true).catch(() => { });
  });
  window.addEventListener('pageshow', () => { disposed = false; scheduleProgressPoll(); });
  window.addEventListener('scroll', hideThumbnail, true);
  window.addEventListener('resize', hideThumbnail);
}
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideThumbnail(); });
function queueDraftSave() {
  if (draftTimer !== null) { clearTimeout(draftTimer); draftTimer = null; }
  draftTimer = setTimeout(() => { draftTimer = null; void flushDraft().catch(() => { }); }, DRAFT_DELAY);
}
async function flushDraft(sync) {
  void sync;
  if (draftTimer !== null) { clearTimeout(draftTimer); draftTimer = null; }
  if (draftInFlight) {
    await draftInFlight;
    return flushDraft();
  }
  if (!loaded || !inputDirty) return;
  const { sequence, value } = inputDirty;
  const capturedSequence = sequence;
  const capturedValue = value;
  const task = (async () => {
    let result;
    try {
      result = await request({ type: 'input', input: capturedValue });
    } catch (error) {
      setMessage(error.message, 'error');
      throw error;
    }
    if (inputDirty?.sequence === capturedSequence) inputDirty = null;
    if (capturedSequence !== inputSequence && inputDirty === null) {
      return;
    }
    applyState(result);
  })();
  draftInFlight = task;
  try {
    await task;
  } finally {
    if (draftInFlight === task) draftInFlight = null;
  }
  // A newer edit may arrive while this save is awaiting the background.
  if (inputDirty) return flushDraft();
}
function queueFilenameEdit(id, value) {
  if (!loaded || actionPending) return;
  const sequence = ++editSequence;
  const prev = edits.get(id)?.values || {};
  edits.set(id, { sequence, values: { ...prev, filename: value } });
  const view = rowViews.get(id);
  if (view) {
    const effective = effectiveItem(state.items.find((entry) => entry.id === id) || { id, filename: value });
    updateView(view, effective, !loaded || actionPending || readingImport);
    renderSelectionChrome();
  } else {
    render();
  }
  if (filenameTimers.has(id)) { clearTimeout(filenameTimers.get(id)); }
  filenameTimers.set(id, setTimeout(() => { filenameTimers.delete(id); void flushFilenameEdit(id, sequence).catch(() => { }); }, FILENAME_DELAY));
}
function renderSelectionChrome() {
  const locked = !loaded || actionPending || readingImport;
  const foundAll = state.items.filter((item) => !isSaved({ ...item, ...edits.get(item.id)?.values }));
  const savedAll = state.items.filter((item) => isSaved({ ...item, ...edits.get(item.id)?.values }));
  const foundFilter = filters.found;
  const savedFilter = filters.saved;
  const foundFiltered = applyFilterSort(foundAll.map(effectiveItem), foundFilter);
  const savedFiltered = applyFilterSort(savedAll.map(effectiveItem), savedFilter);
  const foundSelectedIds = new Set(foundAll.filter((item) => effectiveItem(item).selected).map((item) => item.id));
  const savedSelectedIds = new Set(savedAll.filter((item) => effectiveItem(item).selected).map((item) => item.id));
  const foundVisibleSelected = foundFiltered.filter((item) => foundSelectedIds.has(item.id));
  const savedVisibleSelected = savedFiltered.filter((item) => savedSelectedIds.has(item.id));
  if (downloadBtn) downloadBtn.disabled = locked || !foundVisibleSelected.some(isSelectable);
  if (downloadSavedBtn) downloadSavedBtn.disabled = locked || !savedVisibleSelected.some(isSelectable);
  if (cancelSelectedBtn) cancelSelectedBtn.disabled = locked || !foundVisibleSelected.some((item) => !active(item));
  if (removeSelectedBtn) removeSelectedBtn.disabled = locked || !foundVisibleSelected.some((item) => !active(item));
  if (removeSavedBtn) removeSavedBtn.disabled = locked || !savedVisibleSelected.some((item) => !active(item));
  if (clearBtn) clearBtn.disabled = locked || !(urlsEl && (inputDirty?.value ?? urlsEl.value));
}
async function flushFilenameEdit(id, expected) {
  if (filenameFlights.has(id)) {
    await filenameFlights.get(id);
    const pending = edits.get(id);
    if (pending && typeof pending.values.filename === 'string' &&
      (expected === undefined || pending.sequence === expected)) {
      return flushFilenameEdit(id, expected);
    }
    return;
  }
  const entry = edits.get(id);
  if (!entry) return;
  if (expected !== undefined && entry.sequence !== expected) return;
  if (filenameTimers.has(id)) { clearTimeout(filenameTimers.get(id)); filenameTimers.delete(id); }
  if (!loaded || actionPending) return;
  const values = entry.values;
  if (typeof values.filename !== 'string' && typeof values.selected !== 'boolean') return;
  const capturedSequence = entry.sequence;
  const payload = { type: 'edit', batchId: state.batchId, id };
  if (typeof values.filename === 'string') payload.filename = values.filename;
  if (typeof values.selected === 'boolean' && values.selectedDirty) payload.selected = values.selected;
  if (payload.filename === undefined && payload.selected === undefined) return;
  const task = (async () => {
    let result;
    try {
      result = await request(payload);
    } catch (error) {
      setMessage(error.message, 'error');
      throw error;
    }
    if (edits.get(id)?.sequence === capturedSequence) {
      const remaining = { ...edits.get(id).values };
      if (payload.filename !== undefined) delete remaining.filename;
      if (payload.selected !== undefined) { delete remaining.selected; delete remaining.selectedDirty; }
      if (Object.keys(remaining).length) edits.set(id, { sequence: capturedSequence, values: remaining });
      else edits.delete(id);
    }
    applyState(result);
  })();
  filenameFlights.set(id, task);
  try {
    await task;
  } catch (error) {
    throw error;
  } finally {
    if (filenameFlights.get(id) === task) filenameFlights.delete(id);
  }
  if (expected === undefined && typeof edits.get(id)?.values.filename === 'string') {
    return flushFilenameEdit(id);
  }
}
async function flushAllFilenames(sync) {
  void sync;
  const ids = new Set([...filenameTimers.keys(), ...filenameFlights.keys()]);
  for (const [id, entry] of edits) {
    if (typeof entry.values.filename === 'string') ids.add(id);
  }
  for (const id of [...filenameTimers.keys()]) {
    clearTimeout(filenameTimers.get(id));
    filenameTimers.delete(id);
  }
  let firstError = null;
  for (const id of ids) {
    if (filenameFlights.has(id)) {
      try {
        await filenameFlights.get(id);
        if (edits.get(id)?.values.filename !== undefined && !filenameFlights.has(id)) {
          await flushFilenameEdit(id);
        }
      } catch (error) { if (!firstError) firstError = error; }
    } else {
      try {
        await flushFilenameEdit(id);
      } catch (error) { if (!firstError) firstError = error; }
    }
  }
  if (firstError) throw firstError;
}
async function flushPendingEdits() {
  await flushDraft();
  await flushAllFilenames();
}
async function saveSelection(id, selected) {
  if (!loaded || actionPending) return;
  if (filenameTimers.has(id)) { clearTimeout(filenameTimers.get(id)); filenameTimers.delete(id); }
  const sequence = ++editSequence;
  const prev = edits.get(id)?.values || {};
  edits.set(id, { sequence, values: { ...prev, selected } }); render();
  try {
    const payload = { type: 'select', batchId: state.batchId, ids: [id], selected };
    const value = await request(payload);
    if (edits.get(id)?.sequence === sequence) {
      const remaining = { ...edits.get(id).values };
      delete remaining.selected; delete remaining.selectedDirty;
      if (typeof remaining.filename === 'string') {
        edits.set(id, { sequence, values: remaining });
        queueFilenameEdit(id, remaining.filename);
      } else edits.delete(id);
    }
    applyState(value);
  } catch (error) {
    if (edits.get(id)?.sequence === sequence) edits.delete(id);
    try { applyState(await request({ type: 'get-state' })); } catch { /* Keep the last snapshot. */ }
    setMessage(error.message, 'error'); render();
  }
}
async function saveEdit(id, change) {
  if (typeof change.selected === 'boolean' && typeof change.filename !== 'string') return saveSelection(id, change.selected);
  if (typeof change.filename === 'string' && typeof change.selected !== 'boolean') return queueFilenameEdit(id, change.filename);
  if (!loaded || actionPending) return;
  const sequence = ++editSequence;
  const values = { ...edits.get(id)?.values, ...change }; edits.set(id, { sequence, values }); render();
  try {
    const value = await request(typeof change.selected === 'boolean' && typeof change.filename !== 'string'
      ? { type: 'select', batchId: state.batchId, ids: [id], selected: change.selected }
      : { type: 'edit', batchId: state.batchId, id, ...values });
    if (edits.get(id)?.sequence === sequence) edits.delete(id); applyState(value);
  } catch (error) {
    if (edits.get(id)?.sequence === sequence) edits.delete(id);
    try { applyState(await request({ type: 'get-state' })); } catch { /* Keep the last snapshot. */ }
    setMessage(error.message, 'error'); render();
  }
}
async function perform(message) {
  if (['pause', 'resume', 'show-file'].includes(message.type)) {
    if (!loaded || actionPending || rowActions.has(message.id)) return;
    rowActions.add(message.id); setMessage('', ''); render();
    try { const value = await request(message); applyState(value); return value; }
    catch (error) { setMessage(error.message, 'error'); }
    finally { rowActions.delete(message.id); render(); }
    return;
  }
  if (!loaded || actionPending) return;
  try {
    await flushPendingEdits();
  } catch (error) {
    setMessage(error.message || 'Save the pending edits, then retry.', 'error');
    render();
    return;
  }
  if (!loaded || actionPending) return;
  actionPending = true; setMessage('', ''); render();
  try {
    const value = await request(message); applyState(value);
    if (value.notice) setMessage(value.notice, 'notice');
    else if (value.type === 'notice') setMessage(value.type, 'notice');
    if (message.type === 'find' || message.type === 'download') void refreshPermission();
    return value;
  } catch (error) {
    try { applyState(await request({ type: 'get-state' })); } catch { /* Keep the last snapshot. */ }
    setMessage(error.message, 'error');
    if (message.type === 'find') void refreshPermission();
  } finally { actionPending = false; render(); }
}
function selectedFilteredItems(saved) {
  const f = filters[saved ? 'saved' : 'found'];
  const section = [];
  for (const item of state.items) {
    if (isSaved(effectiveItem(item)) !== saved) continue;
    section.push(effectiveItem(item));
  }
  const filtered = applyFilterSort(section, { ...f, page: 0, pageSize: Math.max(section.length, 1) });
  return filtered.filter((item) => isSelected(item));
}
function selectedFilteredIds(saved) {
  return selectedFilteredItems(saved).map((item) => item.id);
}
function downloadItems(ids) {
  if (!loaded || actionPending) return;
  const byIdMap = new Map(state.items.map((entry) => [entry.id, entry]));
  let files;
  try {
    files = ids.map((id) => {
      const item = byIdMap.get(id);
      const raw = edits.get(id)?.values.filename ?? item?.filename ?? '';
      return { id, filename: fileBasename(raw) };
    });
  } catch (error) { setMessage(error.message, 'error'); return; }
  void perform({ type: 'download', batchId: state.batchId, items: files, saveAs: askEl ? askEl.checked : false, maxHeight: currentMaxHeight(), preferredCodec: currentCodec() }).catch((error) => { setMessage(error.message, 'error'); });
}
async function refreshPermission() {
  if (!browser.permissions || typeof browser.permissions.contains !== 'function') {
    if (permissionBannerEl) permissionBannerEl.hidden = true;
    return true;
  }
  try {
    const granted = await browser.permissions.contains({ origins: [SITE_ORIGIN] });
    hasSitePermission = granted === true;
    if (permissionBannerEl) permissionBannerEl.hidden = hasSitePermission;
    return hasSitePermission;
  } catch {
    if (permissionBannerEl) permissionBannerEl.hidden = true;
    return true;
  }
}
if (urlsEl) {
  urlsEl.addEventListener('input', () => {
    if (!loaded) return;
    const sequence = ++inputSequence; const value = urlsEl.value;
    inputDirty = { sequence, value }; renderSelectionChrome();
    queueDraftSave();
  });
  urlsEl.addEventListener('blur', () => { void flushDraft().catch(() => { }); });
}
if (findBtn) findBtn.addEventListener('click', () => {
  void (async () => {
    const input = urlsEl ? urlsEl.value : '';
    const maxHeight = currentMaxHeight();
    const preferredCodec = currentCodec();
    try {
      await flushPendingEdits();
    } catch (error) {
      setMessage(error.message, 'error');
      return;
    }
    await perform({ type: 'find', input, maxHeight, preferredCodec });
  })().catch((error) => { setMessage(error.message, 'error'); });
});
if (clearBtn) clearBtn.addEventListener('click', () => {
  if (draftTimer !== null) { clearTimeout(draftTimer); draftTimer = null; }
  const inFlight = draftInFlight;
  inputSequence++;
  inputDirty = null;
  if (urlsEl) urlsEl.value = '';
  const run = async () => {
    if (inFlight) {
      try { await inFlight; } catch { /* A stale draft save must not restore the cleared text. */ }
    }
    if (inputDirty) return;
    if (urlsEl) urlsEl.value = '';
    await perform({ type: 'clear-input' });
    if (!inputDirty && urlsEl) urlsEl.value = state.input || '';
    render();
  };
  void run().catch((error) => { setMessage(error.message, 'error'); });
});
if (downloadBtn) downloadBtn.addEventListener('click', () => {
  const byIdMap = new Map(state.items.map((entry) => [entry.id, entry]));
  const ids = [];
  for (const item of selectedFilteredItems(false)) {
    const raw = byIdMap.get(item.id);
    if (raw && !isSaved(effectiveItem(raw)) && isSelectable(effectiveItem(raw))) ids.push(item.id);
  }
  downloadItems(ids);
});
if (downloadSavedBtn) downloadSavedBtn.addEventListener('click', () => {
  const byIdMap = new Map(state.items.map((entry) => [entry.id, entry]));
  const ids = [];
  for (const item of selectedFilteredItems(true)) {
    const raw = byIdMap.get(item.id);
    if (raw && isSaved(effectiveItem(raw)) && isSelectable(effectiveItem(raw))) ids.push(item.id);
  }
  downloadItems(ids);
});
for (const [box, saved] of [[selectAllEl, false], [selectSavedEl, true], [selectAllCompactEl, false], [selectSavedCompactEl, true]]) {
  if (!box) continue;
  box.addEventListener('change', () => {
    const checked = box.checked;
    const f = filters[saved ? 'saved' : 'found'];
    const section = [];
    for (const item of state.items) {
      if (isSaved(effectiveItem(item)) === saved) section.push(effectiveItem(item));
    }
    const basis = (f.search || f.status !== 'all') ? applyFilterSort(section, { ...f, page: 0, pageSize: Math.max(section.length, 1) }) : section;
    void perform({ type: 'select', batchId: state.batchId, ids: basis.map((item) => item.id), selected: checked });
  });
}
function bulkAction(type, saved) {
  const ids = selectedFilteredIds(saved);
  void perform({ type, batchId: state.batchId, ids });
}
if (cancelSelectedBtn) cancelSelectedBtn.addEventListener('click', () => bulkAction('bulk-cancel', false));
if (removeSelectedBtn) removeSelectedBtn.addEventListener('click', () => bulkAction('bulk-remove', false));
if (removeSavedBtn) removeSavedBtn.addEventListener('click', () => bulkAction('bulk-remove', true));
for (const section of ['found', 'saved']) {
  const exportBtn = byId(`export-${section}`);
  const importBtn = byId(`import-${section}`);
  if (exportBtn) exportBtn.addEventListener('click', () => {
    void (async () => {
      try {
        await flushPendingEdits();
      } catch (error) {
        setMessage(error.message, 'error');
        return;
      }
      const formatEl = byId(`${section}-format`);
      const format = formatEl ? formatEl.value : 'json';
      const value = await perform({ type: 'export', section, format });
      if (!value) return;
      const blob = new Blob([value.exportText], { type: format === 'json' ? 'application/json' : 'text/plain' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url;
      link.download = VD.exportFilename(section, format, state.incognito);
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    })().catch((error) => { setMessage(error.message, 'error'); });
  });
  if (importBtn) importBtn.addEventListener('click', () => {
    const formatEl = byId(`${section}-format`);
    pendingImport = { section, format: formatEl ? formatEl.value : 'json' };
    if (importFileEl) {
      importFileEl.accept = pendingImport.format === 'json' ? '.json,application/json' : '.txt,text/plain';
      importFileEl.value = ''; importFileEl.click();
    }
  });
}
if (importFileEl) importFileEl.addEventListener('change', () => {
  void (async () => {
    const file = importFileEl.files?.[0], target = pendingImport;
    if (!file || !target) return;
    if (file.size > 5 * 1024 * 1024) throw new Error('Import a file smaller than 5 MiB.');
    if (actionPending || readingImport) throw new Error('Wait for the current action to finish, then import again.');
    readingImport = true; importPhase = `Reading ${file.name}…`; render();
    try {
      await flushPendingEdits();
      const text = await file.text();
      importPhase = 'Importing videos…'; render();
      await perform({ type: 'import', ...target, text });
    } finally {
      readingImport = false; importPhase = ''; importFileEl.value = ''; render();
    }
  })().catch((error) => { setMessage(error.message, 'error'); });
});

function renderImportStatus() {
  const host = byId('import-status'), text = byId('import-status-text'), progress = byId('import-progress');
  if (!host || !text || !progress) return;
  const task = VD.importStatus(state);
  host.hidden = !readingImport && !task;
  host.setAttribute('aria-busy', String(readingImport || task?.busy === true));
  if (readingImport) {
    text.textContent = importPhase;
    progress.hidden = false; progress.removeAttribute('value');
  } else if (task) {
    text.textContent = task.busy
      ? `Importing ${task.section} videos: ${task.completed} of ${task.total} checked…${task.failed ? ` ${task.failed} failed.` : ''}`
      : `Import complete: ${task.added} added; ${task.updated} moved to saved; ${task.skipped} skipped${task.failed ? `; ${task.failed} lookups failed — retry those rows` : ''}.`;
    progress.hidden = !task.busy; progress.max = Math.max(1, task.total); progress.value = task.completed;
  }
  for (const section of ['found', 'saved']) {
    const localStatus = byId(`${section}-import-status`);
    if (!localStatus) continue;
    localStatus.hidden = host.hidden || section !== (readingImport ? pendingImport?.section : task?.section);
    if (!localStatus.hidden) {
      localStatus.textContent = text.textContent;
      localStatus.classList[readingImport || task?.busy ? 'add' : 'remove']('loading');
    }
  }
}

function updateRenamePreview() {
  const item = state.items.find((entry) => entry.id === renameTarget?.id);
  if (!item) return;
  try {
    byId('rename-preview').textContent = `${VD.structuredFilename({
      author: renameSelection.authors.join(' & '),
      videoTitle: VD.filenameTitle(item, filenameFor(item)) || 'Video Title', channel: renameSelection.channel
    })}.mp4`;
  }
  catch (error) { byId('rename-preview').textContent = error.message; }
}
function renderTagPicker() {
  const item = state.items.find((entry) => entry.id === renameTarget?.id);
  if (!item || !byId('rename-author-chips')) return;
  const authors = VD.nameTagOptions(state, item, 'author');
  const channels = VD.nameTagOptions(state, item, 'channel');
  renameSelection = {
    authors: renameSelection.authors.filter((name) => authors.includes(name)),
    channel: channels.includes(renameSelection.channel) ? renameSelection.channel : ''
  };
  const key = JSON.stringify([authors, channels, renameSelection]);
  if (tagPickerKey !== key) {
    for (const [kind, names] of [['author', authors], ['channel', channels]]) {
      const chips = names.map((name) => {
        const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'name-chip'; chip.textContent = name;
        const selected = kind === 'author' ? renameSelection.authors.includes(name) : renameSelection.channel === name;
        chip.setAttribute('aria-pressed', String(selected));
        if (selected) chip.classList.add('chosen');
        chip.addEventListener('click', () => {
          if (kind === 'author') renameSelection = {
            ...renameSelection, authors: selected
              ? renameSelection.authors.filter((value) => value !== name) : [...renameSelection.authors, name]
          };
          else renameSelection = { ...renameSelection, channel: selected ? '' : name };
          renderTagPicker();
          [...byId(`rename-${kind}-chips`).children].find((button) => button.textContent === name)?.focus?.();
        });
        return chip;
      });
      if (!chips.length) { const empty = document.createElement('span'); empty.className = 'hint'; empty.textContent = `No ${kind} tags.`; chips.push(empty); }
      byId(`rename-${kind}-chips`).replaceChildren(...chips);
    }
    tagPickerKey = key;
  }
  updateRenamePreview();
}
function openRename(id) {
  const item = state.items.find((entry) => entry.id === id);
  if (!item || !isSelectable(item) || actionPending || readingImport) return;
  renameTarget = { id, batchId: state.batchId };
  const selected = VD.selectedNameTags(item);
  renameSelection = { authors: [...selected.authors], channel: selected.channel };
  tagPickerKey = '';
  byId('rename-error').textContent = '';
  renderTagPicker(); byId('rename-dialog').showModal();
}
byId('rename-cancel')?.addEventListener('click', () => byId('rename-dialog').close());
byId('rename-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  void (async () => {
    const apply = byId('rename-apply');
    if (apply.disabled || !renameTarget) return;
    apply.disabled = true;
    try {
      const selection = { authors: [...renameSelection.authors], channel: renameSelection.channel };
      await flushPendingEdits();
      const result = await perform({ type: 'apply-name-tags', ...renameTarget, ...selection });
      if (result) {
        byId('rename-dialog').close();
        const item = result.items.find((entry) => entry.id === renameTarget.id);
        const input = rowViews.get(renameTarget.id)?.nameInput;
        if (input && item) {
          input.focus?.();
          const start = item.naming?.author ? `${VD.sanitize(item.naming.author)} - `.length : 0;
          const end = item.naming?.channel ? item.filename.lastIndexOf(' [') : item.filename.length;
          input.setSelectionRange?.(start, Math.max(start, end));
        }
      }
      else byId('rename-error').textContent = messageEl?.textContent || 'The name could not be saved. Retry.';
    } catch (error) { byId('rename-error').textContent = error.message; }
    finally { apply.disabled = false; }
  })();
});

function renderTagLibrary() {
  if (!byId('author-tag-library')) return;
  const key = JSON.stringify([state.namingPresets, tagManagerBusy]);
  if (tagLibraryKey === key) return;
  for (const kind of ['author', 'channel']) {
    const chips = (state.namingPresets?.[kind] || []).map((name) => {
      const chip = document.createElement('span'); chip.className = 'name-chip library-chip';
      const label = document.createElement('span'); label.textContent = name;
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'chip-remove'; remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${kind} tag: ${name}`); remove.title = `Remove ${name} from reusable tags`;
      remove.disabled = tagManagerBusy;
      remove.addEventListener('click', () => { void changeNameTag(kind, 'remove', name); });
      chip.append(label, remove); return chip;
    });
    if (!chips.length) { const empty = document.createElement('span'); empty.className = 'hint'; empty.textContent = `No reusable ${kind} tags yet.`; chips.push(empty); }
    byId(`${kind}-tag-library`).replaceChildren(...chips);
    byId(`add-${kind}-tag`).disabled = tagManagerBusy;
    byId(`${kind}-tag-input`).disabled = tagManagerBusy;
  }
  for (const id of ['name-tags-format', 'export-name-tags', 'import-name-tags']) {
    if (byId(id)) byId(id).disabled = tagManagerBusy;
  }
  tagLibraryKey = key;
}
async function changeNameTag(kind, action, name) {
  if (tagManagerBusy) return;
  tagManagerBusy = true; byId('name-tags-error').textContent = ''; renderTagLibrary();
  try {
    const result = await perform({ type: 'name-tag', kind, action, name });
    if (!result) byId('name-tags-error').textContent = messageEl?.textContent || 'The tag could not be saved. Retry.';
    else if (action === 'add') byId(`${kind}-tag-input`).value = '';
  } finally { tagManagerBusy = false; renderTagLibrary(); byId(`${kind}-tag-input`).focus?.(); }
}
function openTagManager(fromPicker = false) {
  if (!loaded || actionPending || readingImport || (fromPicker && byId('rename-apply').disabled)) return;
  reopenTagPicker = fromPicker;
  if (fromPicker) byId('rename-dialog').close();
  byId('name-tags-error').textContent = '';
  renderTagLibrary(); byId('name-tags-dialog').showModal();
}
byId('manage-name-tags')?.addEventListener('click', () => openTagManager());
byId('rename-manage-tags')?.addEventListener('click', () => openTagManager(true));
byId('name-tags-close')?.addEventListener('click', () => byId('name-tags-dialog').close());
function dismissOnOutsideClick(dialog, canClose = () => true) {
  if (!dialog) return;
  let backdropPointer = false;
  const outside = (event) => {
    if (event.target !== dialog) return false;
    const rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  };
  dialog.addEventListener('pointerdown', (event) => { backdropPointer = outside(event); });
  dialog.addEventListener('click', (event) => {
    if (backdropPointer && outside(event) && canClose()) dialog.close();
    backdropPointer = false;
  });
}
dismissOnOutsideClick(byId('name-tags-dialog'));
dismissOnOutsideClick(byId('settings-dialog'), () => !backupBusy);
byId('open-settings')?.addEventListener('click', () => {
  if (!loaded || actionPending || readingImport || backupBusy) return;
  hideThumbnail();
  byId('settings-message').textContent = '';
  byId('settings-dialog').showModal();
});
byId('settings-close')?.addEventListener('click', () => { if (!backupBusy) byId('settings-dialog').close(); });
byId('settings-dialog')?.addEventListener('cancel', (event) => { if (backupBusy) event.preventDefault(); });
byId('name-tags-dialog')?.addEventListener('close', () => {
  if (reopenTagPicker) { reopenTagPicker = false; tagPickerKey = ''; renderTagPicker(); byId('rename-dialog').showModal(); }
});
for (const kind of ['author', 'channel']) byId(`${kind}-tag-form`)?.addEventListener('submit', (event) => {
  event.preventDefault(); void changeNameTag(kind, 'add', byId(`${kind}-tag-input`).value);
});
let tagImportFormat = 'json';
byId('import-name-tags')?.addEventListener('click', () => {
  if (tagManagerBusy) return;
  tagImportFormat = byId('name-tags-format').value;
  const input = byId('name-tags-file');
  input.accept = tagImportFormat === 'json' ? '.json,application/json' : '.txt,text/plain';
  input.value = ''; input.click();
});
async function tagFileAction(work) {
  if (tagManagerBusy) return;
  tagManagerBusy = true; byId('name-tags-error').textContent = ''; byId('name-tags-status').textContent = '';
  renderTagLibrary();
  try { await work(); }
  catch (error) { byId('name-tags-error').textContent = error.message; }
  finally { tagManagerBusy = false; renderTagLibrary(); }
}
byId('export-name-tags')?.addEventListener('click', () => {
  void tagFileAction(async () => {
    const format = byId('name-tags-format').value;
    const value = await request({ type: 'export-name-tags', format });
    const url = URL.createObjectURL(new Blob([value.exportText], { type: format === 'json' ? 'application/json' : 'text/plain' }));
    const link = document.createElement('a'); link.href = url;
    link.download = VD.exportFilename('name-tags', format, state.incognito).replace('name-tags-videos', 'name-tags');
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    byId('name-tags-status').textContent = 'Tags exported.';
  });
});
byId('name-tags-file')?.addEventListener('change', () => {
  void tagFileAction(async () => {
    const input = byId('name-tags-file'), file = input.files?.[0];
    try {
      if (!file) return;
      if (file.size > 1024 * 1024) throw new Error('Import a tag file smaller than 1 MiB.');
      byId('name-tags-status').textContent = `Reading ${file.name}…`;
      const value = await request({ type: 'import-name-tags', format: tagImportFormat, text: await file.text() });
      applyState(value); byId('name-tags-status').textContent = value.notice;
    } finally { input.value = ''; }
  });
});
function saveSettingsFromControls() {
  const seq = ++settingsSeq;
  const options = {
    saveAs: askEl ? askEl.checked : state.saveAs,
    maxHeight: currentMaxHeight(), preferredCodec: currentCodec()
  };
  pendingSettings = { seq, ...options };
  render();
  const flight = (async () => {
    try {
      await flushPendingEdits();
      if (seq !== settingsSeq) return;
      const result = await request({ type: 'settings', ...options });
      if (seq !== settingsSeq) return;
      pendingSettings = null;
      applyState(result);
    } catch (error) {
      if (seq !== settingsSeq) return;
      pendingSettings = null;
      setMessage(error.message, 'error');
      render();
    }
  })();
  settingsFlight = flight;
  void flight.finally(() => { if (settingsFlight === flight) settingsFlight = null; });
}
if (askEl) askEl.addEventListener('change', saveSettingsFromControls);
if (qualityMaxEl) qualityMaxEl.addEventListener('change', saveSettingsFromControls);
if (codecPrefEl) codecPrefEl.addEventListener('change', saveSettingsFromControls);
concurrencyEl?.addEventListener('change', () => {
  const seq = ++concurrencySequence, value = Number(concurrencyEl.value);
  pendingConcurrency = { seq, value }; render();
  const flight = (async () => {
    try {
      const result = await request({ type: 'concurrency', value });
      if (seq !== concurrencySequence) return;
      pendingConcurrency = null; applyState(result);
    } catch (error) {
      if (seq !== concurrencySequence) return;
      pendingConcurrency = null; setMessage(error.message, 'error'); render();
    }
  })();
  concurrencyFlight = flight;
  void flight.finally(() => { if (concurrencyFlight === flight) concurrencyFlight = null; });
});

async function flushBackupEdits() {
  await flushPendingEdits();
  if (settingsFlight) await settingsFlight;
  if (concurrencyFlight) await concurrencyFlight;
}
function downloadJson(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = filename;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
byId('export-backup')?.addEventListener('click', () => {
  if (backupBusy || actionPending || readingImport) return;
  backupBusy = true; render();
  void (async () => {
    try {
      await flushBackupEdits();
      const value = await request({ type: 'export-backup' });
      downloadJson(value.exportText, VD.exportFilename('backup', 'json', false).replace('backup-videos', 'extension-backup'));
      setMessage('Full backup exported, including the current private session.', 'notice');
    } catch (error) { setMessage(error.message, 'error'); }
    finally { backupBusy = false; render(); }
  })();
});
byId('import-backup')?.addEventListener('click', () => {
  if (backupBusy || actionPending || readingImport) return;
  const input = byId('backup-file'); input.value = ''; input.click();
});
byId('backup-file')?.addEventListener('change', () => {
  const input = byId('backup-file'), file = input.files?.[0];
  if (!file || backupBusy) return;
  backupBusy = true; backupText = null; render();
  void (async () => {
    try {
      if (file.size > VD.BACKUP_MAX_BYTES) throw new Error('Choose a JSON backup smaller than 50 MiB.');
      await flushBackupEdits();
      const text = await file.text();
      const value = await request({ type: 'preview-backup', text });
      const summary = value.backupSummary;
      const describe = (label, section) => `${label}: ${section.videos} video(s), including ${section.saved} saved; ${section.authors} author and ${section.channels} channel tags${section.hasDraft ? '; a pasted URL draft' : ''}.`;
      byId('backup-summary').textContent = `${describe('Normal session', summary.normal)} ${describe('Private session', summary.private)} Concurrent downloads: ${summary.concurrency}.`;
      byId('backup-error').textContent = '';
      backupText = text; byId('backup-dialog').showModal();
    } catch (error) { setMessage(error.message, 'error'); }
    finally { backupBusy = false; input.value = ''; render(); }
  })();
});
byId('backup-cancel')?.addEventListener('click', () => byId('backup-dialog').close());
byId('backup-dialog')?.addEventListener('close', () => { backupText = null; });
byId('backup-dialog')?.addEventListener('cancel', (event) => { if (backupBusy) event.preventDefault(); });
byId('backup-restore')?.addEventListener('click', () => {
  if (!backupText || backupBusy) return;
  const text = backupText;
  backupBusy = true; byId('backup-restore').disabled = true; byId('backup-cancel').disabled = true;
  byId('backup-error').textContent = ''; render();
  void (async () => {
    try {
      await flushBackupEdits();
      const value = await request({ type: 'restore-backup', text });
      applyState(value); byId('backup-dialog').close(); setMessage(value.notice, 'notice');
    } catch (error) { byId('backup-error').textContent = error.message; }
    finally {
      backupBusy = false; byId('backup-restore').disabled = false; byId('backup-cancel').disabled = false; render();
    }
  })();
});
const bindFilter = (searchEl, statusEl, sortEl, section) => {
  if (searchEl) searchEl.addEventListener('input', () => { filters[section].page = 0; void flushPendingEdits().catch(() => { }); render(); });
  if (statusEl) statusEl.addEventListener('change', () => { filters[section].page = 0; void flushPendingEdits().catch(() => { }); render(); });
  if (sortEl) sortEl.addEventListener('change', () => { void flushPendingEdits().catch(() => { }); render(); });
};
bindFilter(foundSearchEl, foundStatusEl, foundSortEl, 'found');
bindFilter(savedSearchEl, savedStatusEl, savedSortEl, 'saved');
const bindPager = (prev, next, sizeEl, section) => {
  if (prev) prev.addEventListener('click', () => { if (filters[section].page > 0) { filters[section].page--; void flushPendingEdits().catch(() => { }); render(); } });
  if (next) next.addEventListener('click', () => { filters[section].page++; void flushPendingEdits().catch(() => { }); render(); });
  if (sizeEl) sizeEl.addEventListener('change', () => {
    const value = sizeEl.value === '100' ? 100 : 50;
    filters[section].pageSize = value; filters[section].page = 0; void flushPendingEdits().catch(() => { }); render();
  });
};
bindPager(foundPrevBtn, foundNextBtn, foundPageSizeEl, 'found');
bindPager(savedPrevBtn, savedNextBtn, savedPageSizeEl, 'saved');
if (grantAccessBtn) grantAccessBtn.addEventListener('click', async () => {
  try {
    if (!browser.permissions || typeof browser.permissions.request !== 'function') {
      setMessage('Site permission must be granted in the extension settings.', 'error');
      return;
    }
    const granted = await browser.permissions.request({ origins: [SITE_ORIGIN] });
    if (granted) { hasSitePermission = true; if (permissionBannerEl) permissionBannerEl.hidden = true; setMessage('', ''); }
    else setMessage('Site access was not granted. Allow access to the site, then retry.', 'error');
  } catch (error) { setMessage(error.message, 'error'); }
});
if (browser.permissions?.onAdded?.addListener) browser.permissions.onAdded.addListener(() => { void refreshPermission(); });
if (browser.permissions?.onRemoved?.addListener) browser.permissions.onRemoved.addListener(() => { void refreshPermission(); });
if (browser.storage?.onChanged?.addListener) browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && scopeArea === 'session' && changes[STORAGE_KEY]?.newValue) {
    void request({ type: 'get-state' }).then(applyState).catch(() => { });
  }
  if (scopeKey && area === scopeArea && changes[scopeKey]?.newValue) applyState(changes[scopeKey].newValue);
  if (draftKey && area === draftArea && changes[draftKey]?.newValue) {
    const draft = changes[draftKey].newValue;
    if (draft && typeof draft.input === 'string') {
      const revision = typeof draft.inputRevision === 'number' ? draft.inputRevision : null;
      if (revision !== null && revision <= (state.inputRevision ?? 0)) {
        return;
      }
      if (revision !== null) {
        state.input = draft.input;
        state.inputRevision = revision;
      } else {
        state.input = draft.input;
      }
      if (!inputDirty && urlsEl && urlsEl.value !== draft.input) urlsEl.value = draft.input;
      void request({ type: 'get-state' }).then(applyState).catch(() => { });
    }
  }
});
render();
void request({ type: 'get-state' }).then(applyState).catch((error) => { setMessage(error.message, 'error'); });
