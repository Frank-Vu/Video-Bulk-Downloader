const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const sharedSource = fs.readFileSync(path.join(root, 'shared.js'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
const appCss = fs.readFileSync(path.join(root, 'app.css'), 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));

const ALL_IDS = ['urls', 'find', 'clear', 'download', 'rows', 'message', 'ask',
  'session', 'saved-rows', 'select-all', 'select-all-saved', 'select-all-compact', 'select-all-saved-compact',
  'cancel-selected', 'remove-selected',
  'download-saved', 'remove-saved', 'import-file', 'export-found', 'import-found', 'export-saved',
  'import-saved', 'found-format', 'saved-format', 'quality-max', 'codec-pref', 'permission-banner',
  'grant-access', 'found-search', 'found-status', 'found-sort', 'found-prev',
  'found-next', 'found-page-info', 'found-page-size', 'found-selection-hint', 'saved-search',
  'saved-status', 'saved-sort', 'saved-prev', 'saved-next', 'saved-page-info',
  'saved-page-size', 'saved-selection-hint', 'import-status', 'import-status-text', 'import-progress',
  'rename-dialog', 'rename-form', 'rename-author-chips', 'rename-channel-chips',
  'rename-preview', 'rename-error', 'rename-apply', 'rename-cancel', 'rename-manage-tags',
  'manage-name-tags', 'name-tags-dialog', 'name-tags-error', 'name-tags-close',
  'author-tag-form', 'author-tag-input', 'author-tag-library', 'add-author-tag',
  'channel-tag-form', 'channel-tag-input', 'channel-tag-library', 'add-channel-tag',
  'found-import-status', 'saved-import-status', 'name-tags-format', 'export-name-tags', 'import-name-tags',
  'name-tags-file', 'name-tags-status', 'thumbnail-preview', 'thumbnail-image', 'thumbnail-status', 'concurrency',
  'export-backup', 'import-backup', 'backup-file', 'backup-dialog', 'backup-summary', 'backup-error', 'backup-cancel', 'backup-restore',
  'open-settings', 'settings-dialog', 'settings-message', 'settings-close'];

function mount({ initialState, onMessage, permissions } = {}) {
  const stats = { childList: 0, textWrites: 0, trCreated: 0 };
  const elements = {};
  const documentEvents = {};
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const fakeSetTimeout = (fn, ms = 0) => { const id = ++timerId; timers.set(id, { fn, due: now + (ms || 0) }); return id; };
  const fakeClearTimeout = (id) => { timers.delete(id); };
  async function advance(ms) {
    const target = now + ms;
    while (true) {
      let next = null;
      for (const [id, t] of timers) if (t.due <= target && (!next || t.due < next.due)) next = { id, ...t };
      if (!next) break;
      now = next.due;
      timers.delete(next.id);
      await next.fn();
      await tick();
    }
    now = target;
    await tick();
  }

  class MockClassList {
    constructor(el) { this.el = el; this.set = new Set(); }
    add(...names) { for (const n of names) this.set.add(n); this.el.className = [...this.set].join(' '); }
    remove(...names) { for (const n of names) this.set.delete(n); this.el.className = [...this.set].join(' '); }
    contains(n) { return this.set.has(n); }
  }

  class MockElement {
    constructor(tag = 'div') {
      this.tag = tag;
      this.children = [];
      this.parent = null;
      this.parentNode = null;
      this.value = '';
      this.checked = false;
      this.disabled = false;
      this.hidden = false;
      this.indeterminate = false;
      this._textContent = '';
      this.title = '';
      this.className = '';
      this.classList = new MockClassList(this);
      this.listeners = {};
      this.attrs = {};
      this.tabIndex = 0;
      this.type = '';
      this.max = 100;
      this.href = '';
      this.colSpan = 1;
      this.style = {};
      if (tag === 'tr') stats.trCreated++;
    }
    get textContent() { return this._textContent; }
    set textContent(v) {
      v = String(v ?? '');
      if (this._textContent !== v) stats.textWrites++;
      this._textContent = v;
    }
    get firstChild() { return this.children[0] || null; }
    get nextSibling() {
      const p = this.parentNode || this.parent;
      if (!p) return null;
      const idx = p.children.indexOf(this);
      return idx >= 0 && idx + 1 < p.children.length ? p.children[idx + 1] : null;
    }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k]; }
    removeAttribute(k) { delete this.attrs[k]; }
    closest() { return null; }
    append(...nodes) {
      for (const n of nodes) {
        if (!n) continue;
        n.remove();
        n.parent = this; n.parentNode = this;
        this.children.push(n);
        stats.childList++;
      }
      return this;
    }
    insertBefore(node, anchor) {
      if (!node) return null;
      node.remove();
      node.parent = this; node.parentNode = this;
      if (anchor == null) {
        this.children.push(node);
      } else {
        const idx = this.children.indexOf(anchor);
        if (idx === -1) this.children.push(node);
        else this.children.splice(idx, 0, node);
      }
      stats.childList++;
      return node;
    }
    replaceChildren(...nodes) {
      const had = this.children.length;
      for (const c of this.children) { c.parent = null; c.parentNode = null; }
      this.children = [];
      if (had || nodes.length) stats.childList++;
      for (const n of nodes) {
        if (!n) continue;
        n.remove();
        n.parent = this; n.parentNode = this;
        this.children.push(n);
      }
      return this;
    }
    querySelector(sel) {
      if (sel === '.empty') return this.children.find((n) => n.className === 'empty' || n.className?.includes?.('empty')) || null;
      return null;
    }
    remove() {
      let detached = false;
      for (const p of [this.parent, this.parentNode]) {
        if (p && p.children && p.children.includes(this)) {
          p.children = p.children.filter((n) => n !== this);
          detached = true;
        }
      }
      if (detached) stats.childList++;
      this.parent = null; this.parentNode = null;
      return this;
    }
    click() { this.listeners.click?.({ target: this, preventDefault() {} }); }
    showModal() { this.open = true; }
    close() { this.open = false; this.listeners.close?.(); }
    focus() { doc.activeElement = this; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    getBoundingClientRect() { return { left: 100, top: 100, right: 640, bottom: 400 }; }
  }

  for (const id of ALL_IDS) elements[id] = new MockElement(id);
  const bodyEl = new MockElement('body');
  const doc = {
    getElementById: (id) => elements[id] || null,
    createElement: (tag) => new MockElement(tag),
    createElementNS: () => new MockElement('svg'),
    addEventListener: (t, fn) => { documentEvents[t] = fn; },
    hidden: false, activeElement: null, body: bodyEl,
  };
  const winEvents = {};
  const storageEvent = { listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(c, a) { for (const fn of this.listeners) fn(c, a); } };
  const permAdded = { listeners: [], addListener(fn) { this.listeners.push(fn); } };
  const permRemoved = { listeners: [], addListener(fn) { this.listeners.push(fn); } };
  const messages = [];
  let state = clone(initialState || { revision: 1, batchId: 'test-batch', saveAs: false, incognito: false, input: '', inputRevision: 0, maxHeight: 0, preferredCodec: 'AV1', items: [] });
  const sendMessage = async (message) => {
    messages.push(clone(message));
    if (onMessage) return onMessage(message, { messages, getState: () => clone(state), setState: (v) => { state = v; } });
    return { ok: true, state: clone(state) };
  };
  const context = vm.createContext({
    document: doc, window: { addEventListener: (t, fn) => { winEvents[t] = fn; } },
    setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
    Blob, URL: class extends URL { static createObjectURL() { return 'blob:mock'; } static revokeObjectURL() {} },
    browser: {
      tabs: { getCurrent: async () => ({ id: 100, incognito: false }) },
      storage: { onChanged: storageEvent },
      runtime: { sendMessage },
      permissions: permissions === null ? undefined : {
        contains: async () => true, request: async () => true,
        onAdded: permAdded, onRemoved: permRemoved, ...(permissions || {}),
      },
    },
  });
  vm.runInContext(sharedSource, context);
  vm.runInContext(appSource, context);
  return { elements, documentEvents, winEvents, timers, advance, messages, storageEvent, permAdded, permRemoved, stats,
    doc,
    getState: () => clone(state), setState: (v) => { state = clone(v); },
    backendState: (v) => { state = clone(v); }, tick,
    resetStats() { stats.childList = 0; stats.textWrites = 0; } };
}

function rowCells(rowsEl, index = 0) {
  const tr = rowsEl.children[index];
  return { tr, check: tr.children[0].children[0], nameInput: tr.children[3].children[0].children[0], badge: tr.children[5].children[0], actions: tr.children[6].children };
}

test('name tag dialog closes only on a complete outside click, including return to picker', async () => {
  const ui = mount(); await tick();
  const dialog = ui.elements['name-tags-dialog'];
  ui.elements['manage-name-tags'].click();
  const event = (x, y, target = dialog) => ({ target, clientX: x, clientY: y });
  dialog.listeners.pointerdown(event(150, 150)); dialog.listeners.click(event(150, 150));
  assert.equal(dialog.open, true, 'dialog padding is inside');
  dialog.listeners.pointerdown(event(150, 150)); dialog.listeners.click(event(10, 10));
  assert.equal(dialog.open, true, 'drag from inside to outside must not dismiss');
  dialog.listeners.pointerdown(event(10, 10)); dialog.listeners.click(event(10, 10));
  assert.equal(dialog.open, false);
  ui.elements['manage-name-tags'].click();
  dialog.listeners.pointerdown(event(150, 150, ui.elements['author-tag-input']));
  dialog.listeners.click(event(150, 150, ui.elements['author-tag-input']));
  assert.equal(dialog.open, true);
});

test('concurrency control defaults to three, reflects saved values and rolls back a failed change', async () => {
  let release;
  const ui = mount({ onMessage: async (message, { getState, setState }) => {
    if (message.type === 'concurrency') {
      if (message.value === 7) return { ok: false, error: 'Storage failed' };
      if (message.value === 4) await new Promise(resolve => { release = resolve; });
      const state = getState(); state.concurrency = message.value; state.revision++; setState(state);
    }
    return { ok: true, state: getState() };
  } });
  await tick(); assert.equal(ui.elements.concurrency.value, '3');
  ui.elements['open-settings'].click();
  assert.equal(ui.elements['settings-dialog'].open, true);
  ui.elements.concurrency.value = '4'; ui.elements.concurrency.listeners.change(); await tick();
  ui.elements.concurrency.value = '6'; ui.elements.concurrency.listeners.change(); await tick();
  assert.equal(ui.elements.concurrency.value, '6'); release(); await tick();
  assert.equal(ui.elements.concurrency.value, '6', 'an older result must not overwrite the latest choice');
  ui.elements.concurrency.value = '7'; ui.elements.concurrency.listeners.change(); await tick();
  assert.equal(ui.elements.concurrency.value, '6');
  assert.match(ui.elements.message.textContent, /Storage failed/);
  assert.match(ui.elements['settings-message'].textContent, /Storage failed/);
  ui.elements['settings-close'].click();
  assert.equal(ui.elements['settings-dialog'].open, false);
});

test('full backup export flushes drafts and pending settings before reading the backup', async () => {
  let release;
  const ui = mount({ onMessage: async (message, { getState, setState }) => {
    if (message.type === 'settings') {
      await new Promise(resolve => { release = resolve; });
      const state = getState(); state.preferredCodec = message.preferredCodec; setState(state);
    }
    if (message.type === 'input') { const state = getState(); state.input = message.input; state.inputRevision++; setState(state); }
    if (message.type === 'export-backup') return { ok: true, state: { ...getState(), exportText: '{}' } };
    return { ok: true, state: getState() };
  } });
  await tick(); ui.elements['open-settings'].click();
  ui.elements['codec-pref'].value = 'H.264'; ui.elements['codec-pref'].listeners.change(); await tick();
  ui.elements.urls.value = 'Draft before backup'; ui.elements.urls.listeners.input();
  ui.elements['export-backup'].click(); await tick();
  assert.equal(ui.messages.some(m => m.type === 'export-backup'), false);
  release(); await tick(); await tick();
  assert.ok(ui.messages.findIndex(m => m.type === 'input') < ui.messages.findIndex(m => m.type === 'export-backup'));
  assert.equal(ui.elements['export-backup'].disabled, false);
  assert.match(ui.elements.message.textContent, /Full backup exported/);
  assert.match(ui.elements['settings-message'].textContent, /Full backup exported/);
});

test('backup import previews replacement first; cancel makes no restore and confirm refreshes the saved state', async () => {
  const summary = { normal: { videos: 2, saved: 1, authors: 1, channels: 2, hasDraft: true },
    private: { videos: 0, saved: 0, authors: 0, channels: 0, hasDraft: false }, concurrency: 4 };
  const ui = mount({ onMessage: async (message, { getState, setState }) => {
    if (message.type === 'preview-backup') return { ok: true, state: { ...getState(), backupSummary: summary } };
    if (message.type === 'restore-backup') {
      const state = { ...getState(), batchId: 'restored', revision: 5, inputRevision: 5, input: 'Restored draft', concurrency: 4 };
      setState(state); return { ok: true, state: { ...state, notice: 'Backup restored.' } };
    }
    return { ok: true, state: getState() };
  } });
  await tick(); ui.elements['open-settings'].click();
  const input = ui.elements['backup-file']; input.files = [{ size: 2, text: async () => '{}' }];
  input.listeners.change(); await tick(); await tick();
  assert.equal(ui.elements['backup-dialog'].open, true);
  assert.match(ui.elements['backup-summary'].textContent, /2 video\(s\).*1 author and 2 channel/);
  assert.equal(ui.messages.some(m => m.type === 'restore-backup'), false);
  ui.elements['backup-cancel'].click();
  assert.equal(ui.messages.some(m => m.type === 'restore-backup'), false);
  input.listeners.change(); await tick(); await tick();
  ui.elements['backup-restore'].click(); await tick(); await tick();
  assert.equal(ui.elements['backup-dialog'].open, false);
  assert.equal(ui.elements['settings-dialog'].open, true);
  assert.equal(ui.elements.urls.value, 'Restored draft');
  assert.equal(ui.elements.concurrency.value, '4');
  assert.equal(ui.messages.filter(m => m.type === 'restore-backup').length, 1);
});

test('failed backup validation and restore surface errors and leave replacement unconfirmed', async () => {
  let valid = false;
  const ui = mount({ onMessage: async (message, { getState }) => {
    if (message.type === 'preview-backup') {
      if (!valid) return { ok: false, error: 'Invalid backup' };
      return { ok: true, state: { ...getState(), backupSummary: { normal: { videos: 0, saved: 0, authors: 0, channels: 0 },
        private: { videos: 0, saved: 0, authors: 0, channels: 0 }, concurrency: 3 } } };
    }
    if (message.type === 'restore-backup') return { ok: false, error: 'Cancel downloads before restoring' };
    return { ok: true, state: getState() };
  } });
  await tick(); const input = ui.elements['backup-file'];
  input.files = [{ size: 2, text: async () => '{}' }]; input.listeners.change(); await tick(); await tick();
  assert.match(ui.elements.message.textContent, /Invalid backup/);
  assert.notEqual(ui.elements['backup-dialog'].open, true);
  valid = true; input.listeners.change(); await tick(); await tick();
  ui.elements['backup-restore'].click(); await tick(); await tick();
  assert.equal(ui.elements['backup-dialog'].open, true);
  assert.match(ui.elements['backup-error'].textContent, /Cancel downloads/);
  assert.equal(ui.elements['backup-restore'].disabled, false);
});

test('a delayed resume request locks only its row controls and leaves selection, tags and edits usable', async () => {
  let release;
  const initialState = { revision: 1, batchId: 'batch', items: [
    { id: 'paused', title: 'Paused', pageUrl: 'https://www.eporner.com/video-p/title/', filename: 'P',
      state: 'downloading', paused: true, downloadId: 1, history: [] },
    { id: 'ready', title: 'Ready', pageUrl: 'https://www.eporner.com/video-r/title/', filename: 'R',
      state: 'ready', selected: true, history: [] }
  ] };
  const ui = mount({ initialState, onMessage: async (message, { getState }) => {
    if (message.type === 'resume') await new Promise((resolve) => { release = resolve; });
    return { ok: true, state: getState() };
  } });
  await tick();
  const paused = rowCells(ui.elements.rows, 0), ready = rowCells(ui.elements.rows, 1);
  paused.actions[4].click(); await tick();
  assert.equal(paused.actions[4].disabled, true);
  assert.equal(ui.elements.find.disabled, false);
  assert.equal(ui.elements['manage-name-tags'].disabled, false);
  assert.equal(ready.nameInput.disabled, false);
  ready.check.checked = false; ready.check.listeners.change(); await tick();
  assert.ok(ui.messages.some((message) => message.type === 'select'));
  paused.actions[4].click(); await tick();
  assert.equal(ui.messages.filter((message) => message.type === 'resume').length, 1);
  release(); await tick();
  assert.equal(paused.actions[4].disabled, false);
});

test('tag file controls export and import both libraries and show errors inside the dialog', async () => {
  const ui = mount({ onMessage: async (message, { getState }) => {
    if (message.type === 'export-name-tags') return { ok: true, state: { ...getState(), exportText: '[Authors]\nAlice\n[Channels]\nChannel' } };
    if (message.type === 'import-name-tags') {
      if (message.text === 'Invalid') return { ok: false, error: 'Invalid tags' };
      return { ok: true, state: { ...getState(), revision: 2, namingPresets: { author: ['Alice'], channel: ['Channel'] }, notice: '2 reusable tags added.' } };
    }
    return { ok: true, state: getState() };
  } });
  await tick(); ui.elements['manage-name-tags'].click();
  ui.elements['name-tags-format'].value = 'txt'; ui.elements['export-name-tags'].click(); await tick();
  assert.ok(ui.messages.some((message) => message.type === 'export-name-tags' && message.format === 'txt'));
  assert.equal(ui.elements['name-tags-status'].textContent, 'Tags exported.');
  ui.elements['import-name-tags'].click();
  const input = ui.elements['name-tags-file'];
  assert.equal(input.accept, '.txt,text/plain');
  input.files = [{ name: 'tags.txt', size: 50, text: async () => '[Authors]\nAlice\n[Channels]\nChannel' }];
  input.listeners.change(); await tick(); await tick();
  assert.equal(ui.elements['name-tags-status'].textContent, '2 reusable tags added.');
  assert.equal(ui.elements['author-tag-library'].children[0].children[0].textContent, 'Alice');
  assert.equal(ui.elements['channel-tag-library'].children[0].children[0].textContent, 'Channel');
  input.files = [{ name: 'bad.txt', size: 10, text: async () => 'Invalid' }];
  input.listeners.change(); await tick();
  assert.equal(ui.elements['name-tags-error'].textContent, 'Invalid tags');
  assert.equal(ui.elements['import-name-tags'].disabled, false);
});

test('hover and keyboard focus show lazy thumbnails in found and saved rows and ignore late hover responses', async () => {
  let release;
  const thumbnail = 'https://static.eporner.com/thumbs/sample.jpg';
  const ui = mount({ initialState: { revision: 1, batchId: 'batch', items: [
    { id: 'found', title: 'Found', pageUrl: 'https://www.eporner.com/video-f/title/', filename: 'Found', state: 'ready', thumbnail, history: [] },
    { id: 'saved', title: 'Saved', pageUrl: 'https://www.eporner.com/video-s/title/', filename: 'Saved', state: 'done', history: [] }
  ] }, onMessage: async (message, { getState }) => {
    if (message.type === 'thumbnail') await new Promise((resolve) => { release = resolve; });
    return { ok: true, state: getState() };
  } });
  await tick();
  const foundLink = ui.elements.rows.children[0].children[1].children[0];
  const savedLink = ui.elements['saved-rows'].children[0].children[1].children[0];
  const image = ui.elements['thumbnail-image'], preview = ui.elements['thumbnail-preview'];
  foundLink.listeners.mouseenter(); await ui.advance(180);
  assert.equal(preview.hidden, false); assert.equal(image.src, thumbnail);
  assert.equal(ui.messages.filter((message) => message.type === 'thumbnail').length, 0);
  image.onload(); assert.equal(image.hidden, false);
  foundLink.listeners.mouseleave(); assert.equal(preview.hidden, true);
  savedLink.listeners.focus(); await ui.advance(180);
  assert.equal(ui.messages.filter((message) => message.type === 'thumbnail').length, 1);
  assert.match(ui.elements['thumbnail-status'].textContent, /Loading/);
  savedLink.listeners.blur();
  foundLink.listeners.focus(); await ui.advance(180);
  release(); await tick();
  assert.equal(image.src, thumbnail, 'a late saved response cannot replace the found image');
  image.onload(); assert.equal(image.hidden, false);
  ui.documentEvents.keydown({ key: 'Escape' }); assert.equal(preview.hidden, true);
});

test('draft typed during an in-flight save is saved after that request completes', async () => {
  let release;
  const ui = mount({ onMessage: async (message, { getState, setState }) => {
    if (message.type === 'input') {
      if (message.input === 'First') await new Promise((resolve) => { release = resolve; });
      const value = getState(); value.input = message.input; value.inputRevision++;
      setState(value);
    }
    return { ok: true, state: getState() };
  } });
  await tick();
  ui.elements.urls.value = 'First'; ui.elements.urls.listeners.input();
  await ui.advance(300);
  ui.elements.urls.value = 'Latest'; ui.elements.urls.listeners.input();
  await ui.advance(300);
  release();
  await tick(); await tick();
  assert.deepEqual(ui.messages.filter((m) => m.type === 'input').map((m) => m.input), ['First', 'Latest']);
  assert.equal(ui.getState().input, 'Latest');
  assert.equal(ui.elements.urls.value, 'Latest');
});

test('initial legacy draft with revision zero is displayed', async () => {
  const ui = mount({ initialState: { revision: 0, batchId: 'legacy', input: 'Restored draft', inputRevision: 0, items: [] } });
  await tick();
  assert.equal(ui.elements.urls.value, 'Restored draft');
});

test('failed quality save restores the last confirmed settings', async () => {
  const ui = mount({ onMessage: async (message, { getState }) => message.type === 'settings'
    ? { ok: false, error: 'Storage unavailable' } : { ok: true, state: getState() } });
  await tick();
  ui.doc.activeElement = ui.elements['quality-max'];
  ui.elements['quality-max'].value = '720'; ui.elements['quality-max'].listeners.change();
  await tick(); await tick();
  assert.equal(ui.elements['quality-max'].value, '0');
  assert.match(ui.elements.message.textContent, /Storage unavailable/);
});

test('filename typed during an in-flight save is not stranded by its debounce timer', async () => {
  let release;
  const ui = mount({ initialState: { revision: 1, batchId: 'files', items: [
    { id: 'one', state: 'ready', title: 'Video', filename: 'Original', selected: true, pageUrl: 'https://www.eporner.com/video-one/' },
  ] }, onMessage: async (message, { getState, setState }) => {
    if (message.type === 'edit') {
      if (message.filename === 'First') await new Promise((resolve) => { release = resolve; });
      const value = getState(); value.items[0].filename = message.filename; value.revision++;
      setState(value);
    }
    return { ok: true, state: getState() };
  } });
  await tick();
  const input = rowCells(ui.elements.rows).nameInput;
  input.value = 'First'; input.listeners.input(); await ui.advance(300);
  input.value = 'Latest'; input.listeners.input(); await ui.advance(300);
  release(); await tick(); await tick();
  assert.deepEqual(ui.messages.filter((m) => m.type === 'edit').map((m) => m.filename), ['First', 'Latest']);
  assert.equal(ui.getState().items[0].filename, 'Latest');
});

test('debounced draft autosave flushes before find and preserves newer typing', async () => {
  let inputCalls = [];
  const ui = mount({ initialState: { revision: 1, batchId: 'b1', saveAs: false, input: '', inputRevision: 0, items: [] } });
  const ui2 = mount({ initialState: { revision: 1, batchId: 'b1', saveAs: false, input: '', inputRevision: 0, items: [] },
    onMessage: async (m, { getState }) => {
      if (m.type === 'input') { inputCalls.push(m.input); const s = getState(); s.revision++; s.input = m.input; return { ok: true, state: s }; }
      if (m.type === 'find') {
        const s = getState(); s.revision++;
        s.lastFind = { maxHeight: m.maxHeight, preferredCodec: m.preferredCodec };
        return { ok: true, state: { ...s, notice: '1 new video(s) added' } };
      }
      return { ok: true, state: getState() };
    } });
  await tick(); await tick();
  ui2.elements.urls.value = 'https://www.eporner.com/video-1/a/';
  ui2.elements.urls.listeners.input();
  assert.equal(inputCalls.length, 0, 'draft must debounce, not send per keystroke');
  await tick();
  ui2.elements.find.listeners.click();
  await tick(); await tick(); await tick();
  await ui2.advance(400);
  await tick();
  assert.ok(inputCalls.length >= 1, 'pending draft flushes before find');
  assert.equal(inputCalls[0], 'https://www.eporner.com/video-1/a/');
  const findMsg = ui2.messages.find((m) => m.type === 'find');
  assert.ok(findMsg, 'find sent');
  assert.equal(typeof findMsg.maxHeight, 'number');
  assert.ok(ui2.messages.indexOf(ui2.messages.find((m) => m.type === 'input')) < ui2.messages.indexOf(findMsg), 'input flushed before find');
  void ui;
});

test('filename edits debounce while selection sends immediately', async () => {
  const item = { id: 'v1', pageUrl: 'https://www.eporner.com/video-1/a/', title: 'Video 1', filename: 'Video 1', state: 'ready', selected: true, history: [] };
  const seen = [];
  const ui = mount({ initialState: { revision: 1, batchId: 'b1', saveAs: false, input: '', items: [item] },
    onMessage: async (m, { getState }) => {
      seen.push(m.type);
      const s = getState();
      if (m.type === 'edit') { s.revision++; s.items[0].filename = m.filename; return { ok: true, state: s }; }
      if (m.type === 'select') { s.revision++; s.items[0].selected = m.selected; return { ok: true, state: s }; }
      return { ok: true, state: s };
    } });
  await tick(); await tick();
  const { nameInput, check } = rowCells(ui.elements.rows, 0);
  nameInput.value = 'Renamed';
  nameInput.listeners.input();
  await tick();
  assert.ok(!seen.includes('edit'), 'filename must debounce');
  assert.equal(nameInput.disabled, false, 'editing must not disable the field per keystroke');
  assert.equal(check.disabled, false);
  assert.equal(nameInput.value, 'Renamed');
  check.checked = false;
  check.listeners.change();
  await tick(); await tick();
  assert.ok(seen.includes('select'), 'selection change is immediate');
  await ui.advance(400);
  await tick();
  assert.ok(seen.includes('edit'), 'debounced filename eventually sent');
  const editMsg = ui.messages.find((m) => m.type === 'edit');
  assert.equal(editMsg.filename, 'Renamed');
});

test('draft storage key updates input but dirty typing wins', async () => {
  const ui = mount({ initialState: { revision: 1, batchId: 'b1', saveAs: false, input: 'old', inputRevision: 1, items: [] },
    onMessage: async (m, { getState }) => getState() && { ok: true, state: getState() } });
  await tick(); await tick();
  assert.equal(ui.elements.urls.value, 'old');
  ui.backendState({ revision: 2, batchId: 'b1', saveAs: false, input: 'draft text', inputRevision: 2, items: [] });
  ui.storageEvent.emit({ downloaderDraft: { newValue: { input: 'draft text', inputRevision: 2 } } }, 'local');
  await tick(); await tick(); await tick();
  assert.equal(ui.elements.urls.value, 'draft text');
  ui.elements.urls.value = 'user typing';
  ui.elements.urls.listeners.input();
  await tick();
  ui.storageEvent.emit({ downloaderDraft: { newValue: { input: 'other draft', inputRevision: 3 } } }, 'local');
  await tick(); await tick();
  assert.equal(ui.elements.urls.value, 'user typing');
  await ui.advance(400);
});

test('efficient rendering caches badge/icon DOM and bounds 10k lists with pagination', async () => {
  const items = Array.from({ length: 120 }, (_, i) => ({ id: `v${i}`, pageUrl: `https://www.eporner.com/video-${i}/t/`, title: `Video ${i}`, filename: `Video ${i}`, state: 'ready', selected: false, history: [] }));
  const ui = mount({ initialState: { revision: 1, batchId: 'b1', saveAs: false, input: '', items } });
  await tick(); await tick();
  assert.equal(ui.elements.rows.children.length, 50, 'DOM bounded to page size');
  assert.match(ui.elements['found-page-info'].textContent, /Page 1 of 3/);
  const firstBadge = ui.elements.rows.children[0].children[5].children[0];
  const firstText = firstBadge.textContent;
  ui.backendState({ revision: 2, batchId: 'b1', saveAs: false, input: '', items });
  ui.storageEvent.emit({ downloaderState: { newValue: ui.getState() } }, 'local');
  await tick();
  const sameBadge = ui.elements.rows.children[0].children[5].children[0];
  assert.equal(sameBadge, firstBadge, 'unchanged badge DOM must not be recreated');
  assert.equal(sameBadge.textContent, firstText);
  ui.elements['found-next'].listeners.click();
  await tick();
  assert.match(ui.elements['found-page-info'].textContent, /Page 2 of 3/);
  assert.equal(ui.elements.rows.children.length, 50);
  ui.elements['found-page-size'].value = '100';
  ui.elements['found-page-size'].listeners.change();
  await tick();
  assert.equal(ui.elements.rows.children.length, 100);
});

test('bulk and download actions use filtered selection, not just rendered rows', async () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ id: `v${i}`, pageUrl: `https://www.eporner.com/video-${i}/t/`, title: i < 30 ? `Cats ${i}` : `Dogs ${i}`, filename: `File ${i}`, state: 'ready', selected: true, history: [] }));
  let downloaded = null;
  const ui = mount({ initialState: { revision: 1, batchId: 'b1', saveAs: false, input: '', items },
    onMessage: async (m, { getState }) => {
      if (m.type === 'download') { downloaded = m.items.map((x) => x.id); const s = getState(); s.revision++; return { ok: true, state: s }; }
      if (m.type === 'select' || m.type === 'bulk-remove') { const s = getState(); s.revision++; return { ok: true, state: s }; }
      return { ok: true, state: getState() };
    } });
  await tick(); await tick();
  assert.equal(ui.elements.rows.children.length, 50);
  ui.elements['found-search'].value = 'Cats';
  ui.elements['found-search'].listeners.input();
  await tick();
  assert.equal(ui.elements.rows.children.length, 30);
  ui.elements.download.listeners.click();
  await tick(); await tick(); await tick();
  assert.ok(downloaded, 'download sent');
  assert.equal(downloaded.length, 30, 'bulk download affects filtered rows across pagination, not just rendered page');
  assert.ok(downloaded.every((id) => Number(id.slice(1)) < 30));
});

test('search, status filter, sorting and hidden-selection hint behave predictably', async () => {
  const items = [
    { id: 'a', pageUrl: 'https://www.eporner.com/video-a/t/', title: 'Zebra', filename: 'Zebra', state: 'ready', selected: true, history: [] },
    { id: 'b', pageUrl: 'https://www.eporner.com/video-b/t/', title: 'Apple', filename: 'Apple', state: 'failed', error: 'x', selected: true, history: [] },
    { id: 'c', pageUrl: 'https://www.eporner.com/video-c/t/', title: 'Mango', filename: 'Mango', state: 'ready', selected: false, history: [] },
  ];
  const ui = mount({ initialState: { revision: 1, batchId: 'b1', saveAs: false, input: '', items } });
  await tick(); await tick();
  assert.equal(ui.elements['select-all'].checked, false);
  ui.elements['found-status'].value = 'ready';
  ui.elements['found-status'].listeners.change();
  await tick();
  assert.equal(ui.elements.rows.children.length, 2);
  assert.equal(ui.elements['found-selection-hint'].hidden, false);
  assert.match(ui.elements['found-selection-hint'].textContent, /Bulk actions apply to shown rows/);
  assert.equal(ui.elements['select-all'].attrs['aria-label'], 'Select all filtered found videos');
  ui.elements['found-status'].value = 'all';
  ui.elements['found-status'].listeners.change();
  ui.elements['found-sort'].value = 'title-asc';
  ui.elements['found-sort'].listeners.change();
  await tick();
  const titles = ui.elements.rows.children.filter((n) => n.className.startsWith('video-row')).map((tr) => tr.children[1].children[0].textContent);
  assert.deepEqual(titles, ['Apple', 'Mango', 'Zebra']);
  ui.elements['found-search'].value = 'zzz-no-match';
  ui.elements['found-search'].listeners.input();
  await tick();
  assert.equal(ui.elements.rows.children.length, 1);
  assert.equal(ui.elements.rows.children[0].className, 'empty');
  assert.match(ui.elements.rows.children[0].children[0].textContent, /No videos match/);
});

test('primary controls are visibly labeled with accessible names and responsive layout', () => {
  assert.match(appHtml, /id="find"[^>]*>.*?<span class="btn-label">Find links<\/span>/s);
  assert.match(appHtml, /id="download"[^>]*>.*?<span class="btn-label">Download selected<\/span>/s);
  assert.match(appHtml, /aria-label="Find links"/);
  assert.match(appHtml, /aria-label="Download selected/);
  assert.match(appHtml, /id="permission-banner"/);
  assert.match(appHtml, /id="quality-max"/);
  assert.match(appHtml, /id="codec-pref"/);
  assert.ok(!appHtml.includes('<use'), 'no external SVG use');
  const svgs = appHtml.match(/<svg[^>]*class="action-icon"[^>]*>.*?<\/svg>/gs);
  assert.equal(svgs.length, 12, 'toolbar icons and settings gear render inline');
  assert.match(appCss, /@media \(max-width: 900px\)/);
  assert.match(appCss, /\.table-wrap/);
  assert.match(appCss, /prefers-color-scheme/ || /color-scheme/);
  assert.match(appCss, /:focus-visible/);
  assert.match(appCss, /button\.labeled/);
});

test('imported saved rows show imported history instead of fake progress', async () => {
  const withMetrics = { id: 'm', pageUrl: 'https://www.eporner.com/video-m/t/', title: 'M', filename: 'M', state: 'done', selected: false, history: [{ imported: true, savedAt: null, filename: 'M.mp4', bytesReceived: 800, totalBytes: 1000 }] };
  const withoutMetrics = { id: 'n', pageUrl: 'https://www.eporner.com/video-n/t/', title: 'N', filename: 'N', state: 'done', selected: false, history: [{ imported: true, savedAt: null, filename: 'N.mp4' }] };
  const ui = mount({ initialState: { revision: 1, batchId: 'b1', saveAs: false, input: '', items: [withMetrics, withoutMetrics] } });
  await tick(); await tick();
  assert.equal(ui.elements['saved-rows'].children.length, 2);
  const firstTransfer = ui.elements['saved-rows'].children[0].children[4].children[1].textContent;
  const secondTransfer = ui.elements['saved-rows'].children[1].children[4].children[1].textContent;
  const texts = [firstTransfer, secondTransfer].join(' | ');
  assert.match(texts, /Imported history/);
  assert.ok(texts.includes('Imported history · size unknown'), 'imported row without metrics shows unavailable message');
  assert.ok(firstTransfer.includes('800') && firstTransfer.includes('1000'), 'uses most recent history metrics when known');
  const bars = ui.elements['saved-rows'].children.map((tr) => tr.children[4].children[0]);
  assert.ok(bars.every((b) => b.hidden === true), 'no fake completed bar for imported history');
});

test('permission banner reacts to contains/request and permission events', async () => {
  let granted = false;
  const requests = [];
  const ui = mount({ initialState: { revision: 1, batchId: 'b1', saveAs: false, input: '', items: [] },
    permissions: {
      contains: async () => granted,
      request: async (req) => { requests.push(req); granted = true; return true; },
    } });
  await tick(); await tick(); await tick(); await tick(); await tick();
  assert.equal(ui.elements['permission-banner'].hidden, false, 'banner shows when permission missing');
  ui.elements['grant-access'].listeners.click();
  await tick(); await tick();
  assert.equal(requests.length, 1, 'request called from direct click');
  assert.equal(JSON.stringify(requests[0]), JSON.stringify({ origins: ['https://www.eporner.com/*'] }));
  assert.equal(ui.elements['permission-banner'].hidden, true);
  granted = false;
  for (const fn of ui.permRemoved.listeners) await fn();
  await tick();
  assert.equal(ui.elements['permission-banner'].hidden, false);
});

test('quality and codec selectors send contract fields and reflect state', async () => {
  let lastSettings = null; let lastFind = null;
  const ui = mount({ initialState: { revision: 1, batchId: 'b1', saveAs: false, input: '', maxHeight: 720, preferredCodec: 'H.264', items: [] },
    onMessage: async (m, { getState }) => {
      const s = getState();
      if (m.type === 'settings') { lastSettings = { maxHeight: m.maxHeight, preferredCodec: m.preferredCodec }; s.revision++; s.maxHeight = m.maxHeight; s.preferredCodec = m.preferredCodec; return { ok: true, state: s }; }
      if (m.type === 'find') { lastFind = { maxHeight: m.maxHeight, preferredCodec: m.preferredCodec }; s.revision++; return { ok: true, state: s }; }
      return { ok: true, state: s };
    } });
  await tick(); await tick();
  assert.equal(ui.elements['quality-max'].value, '720');
  assert.equal(ui.elements['codec-pref'].value, 'H.264');
  ui.elements['quality-max'].value = '1080';
  ui.elements['quality-max'].listeners.change();
  await tick(); await tick();
  assert.deepEqual(lastSettings, { maxHeight: 1080, preferredCodec: 'H.264' });
  ui.elements['codec-pref'].value = 'AV1';
  ui.elements['codec-pref'].listeners.change();
  await tick(); await tick();
  assert.deepEqual(lastSettings, { maxHeight: 1080, preferredCodec: 'AV1' });
  ui.elements.urls.value = 'https://www.eporner.com/video-1/a/';
  ui.elements.find.listeners.click();
  await tick(); await tick(); await tick();
  assert.deepEqual(lastFind, { maxHeight: 1080, preferredCodec: 'AV1' });
});

test('pause, resume and show-file actions are offered only when valid', async () => {
  const items = [
    { id: 'run', pageUrl: 'https://www.eporner.com/video-r/t/', title: 'R', filename: 'R', state: 'downloading', paused: false, downloadId: 1, history: [] },
    { id: 'paused', pageUrl: 'https://www.eporner.com/video-p/t/', title: 'P', filename: 'P', state: 'downloading', paused: true, downloadId: 2, history: [] },
    { id: 'done', pageUrl: 'https://www.eporner.com/video-d/t/', title: 'D', filename: 'D', state: 'done', selected: false, downloadId: 9, history: [{ savedAt: '2026-01-01T00:00:00.000Z', filename: 'D.mp4' }] },
    { id: 'imported', pageUrl: 'https://www.eporner.com/video-i/t/', title: 'I', filename: 'I', state: 'done', selected: false, history: [{ imported: true, savedAt: null, filename: 'I.mp4' }] },
  ];
  const sent = [];
  const ui = mount({ initialState: { revision: 1, batchId: 'b1', saveAs: false, input: '', items },
    onMessage: async (m, { getState }) => { sent.push(m.type); return { ok: true, state: getState() }; } });
  await tick(); await tick();
  const runRow = ui.elements.rows.children.find((tr) => tr.className.startsWith('video-row') && tr.children[1].children[0].textContent === 'R');
  const pausedRow = ui.elements.rows.children.find((tr) => tr.className.startsWith('video-row') && tr.children[1].children[0].textContent === 'P');
  assert.ok(runRow && pausedRow);
  const runActions = runRow.children[6].children;
  const pausedActions = pausedRow.children[6].children;
  assert.equal(runActions[3].hidden, false, 'pause offered while running');
  assert.equal(runActions[4].hidden, true, 'resume hidden while running');
  assert.equal(pausedActions[3].hidden, true);
  assert.equal(pausedActions[4].hidden, false, 'resume offered while paused');
  runActions[3].listeners.click();
  await tick(); await tick();
  assert.ok(sent.includes('pause'));
  pausedActions[4].listeners.click();
  await tick(); await tick();
  assert.ok(sent.includes('resume'));
  const doneRow = ui.elements['saved-rows'].children.find((tr) => tr.className.startsWith('video-row') && tr.children[1].children[0].textContent === 'D');
  const importedRow = ui.elements['saved-rows'].children.find((tr) => tr.className.startsWith('video-row') && tr.children[1].children[0].textContent === 'I');
  assert.equal(doneRow.children[6].children[5].hidden, false, 'show-file for known download id');
  assert.equal(importedRow.children[6].children[5].hidden, true, 'no show-file for imported without id');
  doneRow.children[6].children[5].listeners.click();
  await tick(); await tick();
  assert.ok(sent.includes('show-file'));
});

test('backend invalid-paste notice is surfaced without confirmation dialogs', async () => {
  const ui = mount({ initialState: { revision: 1, batchId: 'b1', saveAs: false, input: '', items: [] },
    onMessage: async (m, { getState }) => {
      if (m.type === 'find') { const s = getState(); s.revision++; return { ok: true, state: { ...s, notice: '0 new video(s) added; 2 rejected (examples: not-a-url, https://evil.test/x).' } }; }
      return { ok: true, state: getState() };
    } });
  await tick(); await tick();
  ui.elements.urls.value = 'not-a-url https://evil.test/x';
  ui.elements.find.listeners.click();
  await tick(); await tick(); await tick();
  assert.match(ui.elements.message.textContent, /rejected/);
  assert.match(ui.elements.message.textContent, /not-a-url/);
  assert.ok(!appSource.includes('confirm('), 'no unsolicited confirmation flows');
});

// ---- Round 2 blocking findings ----

test('unchanged render performs zero child-list moves and preserves focus', async () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ id: `v${i}`, pageUrl: `https://www.eporner.com/video-${i}/t/`, title: `Video ${i}`, filename: `Video ${i}`, state: 'ready', selected: false, history: [] }));
  const ui = mount({ initialState: { revision: 1, batchId: 'b1', saveAs: false, input: '', items } });
  await tick(); await tick();
  assert.equal(ui.elements.rows.children.length, 50);
  const firstTr = ui.elements.rows.children[0];
  const { nameInput } = rowCells(ui.elements.rows, 0);
  ui.doc.activeElement = nameInput;
  ui.resetStats();
  ui.backendState({ revision: 2, batchId: 'b1', saveAs: false, input: '', items: clone(items) });
  ui.storageEvent.emit({ downloaderState: { newValue: ui.getState() } }, 'local');
  await tick();
  assert.equal(ui.elements.rows.children[0], firstTr, 'row identity preserved without moves');
  assert.equal(ui.stats.childList, 0, `unchanged 50-row render must cause zero child-list mutations, got ${ui.stats.childList}`);
  assert.equal(ui.doc.activeElement, nameInput, 'focused input stays attached');
  // Typing path: queueFilenameEdit must not move the focused row either
  ui.resetStats();
  nameInput.value = 'Typing…';
  nameInput.listeners.input();
  await tick();
  assert.equal(ui.doc.activeElement, nameInput, 'typing does not lose focus before debounce');
  assert.equal(ui.stats.childList, 0, `keystroke render must not move DOM, got ${ui.stats.childList}`);
  await ui.advance(400);
  await tick();
});

test('transfer and progress text is cached so idle renders write nothing', async () => {
  const item = { id: 'v1', pageUrl: 'https://www.eporner.com/video-1/a/', title: 'V', filename: 'V', state: 'ready', selected: false, history: [] };
  const ui = mount({ initialState: { revision: 1, batchId: 'b1', saveAs: false, input: '', items: [item] } });
  await tick(); await tick();
  ui.resetStats();
  ui.backendState({ revision: 2, batchId: 'b1', saveAs: false, input: '', items: [clone(item)] });
  ui.storageEvent.emit({ downloaderState: { newValue: ui.getState() } }, 'local');
  await tick();
  assert.equal(ui.stats.textWrites, 0, `idle render must not rewrite transfer text, got ${ui.stats.textWrites}`);
});

test('narrow layout keeps a visible select-all and labeled stacked cells without overflow', () => {
  assert.match(appHtml, /id="select-all-compact"/, 'compact found select-all exists outside thead');
  assert.match(appHtml, /id="select-all-saved-compact"/, 'compact saved select-all exists outside thead');
  assert.match(appCss, /\.select-bar/, 'selection bar styled');
  assert.match(appCss, /\.select-bar\s*\{[^}]*display:\s*none/s, 'selection bar hidden on wide layout');
  assert.match(appCss, /data-label/, 'stacked cells use data-label markers');
  assert.match(appCss, /td\[data-label\]::before/, 'stacked labels rendered via CSS');
  assert.match(appCss, /max-width:\s*calc\(100vw/, 'stacked cards bound to viewport width');
  assert.match(appCss, /overflow-x:\s*hidden/, 'narrow tables do not overflow horizontally');
  assert.match(appCss, /overflow-wrap:\s*anywhere/, 'long titles wrap instead of overflowing');
});

test('compact select-all mirrors the header checkbox', async () => {
  const items = [
    { id: 'a', pageUrl: 'https://www.eporner.com/video-a/t/', title: 'A', filename: 'A', state: 'ready', selected: false, history: [] },
    { id: 'b', pageUrl: 'https://www.eporner.com/video-b/t/', title: 'B', filename: 'B', state: 'ready', selected: false, history: [] },
  ];
  let lastSelect = null;
  const ui = mount({ initialState: { revision: 1, batchId: 'b1', saveAs: false, input: '', items },
    onMessage: async (m, { getState }) => {
      if (m.type === 'select') { lastSelect = { ids: m.ids, selected: m.selected }; const s = getState(); s.revision++; return { ok: true, state: s }; }
      return { ok: true, state: getState() };
    } });
  await tick(); await tick();
  assert.equal(ui.elements['select-all-compact'].attrs['aria-label'], 'Select all filtered found videos');
  ui.elements['select-all-compact'].checked = true;
  ui.elements['select-all-compact'].listeners.change();
  await tick(); await tick();
  assert.ok(lastSelect, 'compact select-all sends select');
  assert.equal(lastSelect.selected, true);
  assert.deepEqual([...lastSelect.ids].sort(), ['a', 'b']);
});

test('off-page views are evicted while filename edits survive paging', async () => {
  const items = Array.from({ length: 120 }, (_, i) => ({ id: `v${i}`, pageUrl: `https://www.eporner.com/video-${i}/t/`, title: `Video ${i}`, filename: `Video ${i}`, state: 'ready', selected: false, history: [] }));
  const seenEdits = [];
  const ui = mount({ initialState: { revision: 1, batchId: 'b1', saveAs: false, input: '', items },
    onMessage: async (m, { getState }) => {
      if (m.type === 'edit') seenEdits.push(m.filename);
      return { ok: true, state: getState() };
    } });
  await tick(); await tick();
  const firstTr = ui.elements.rows.children[0];
  assert.equal(ui.elements.rows.children.length, 50);
  ui.elements['found-next'].listeners.click();
  await tick();
  assert.equal(ui.elements.rows.children.length, 50);
  ui.elements['found-next'].listeners.click();
  await tick();
  assert.equal(ui.elements.rows.children.length, 20);
  ui.elements['found-prev'].listeners.click();
  await tick();
  ui.elements['found-prev'].listeners.click();
  await tick();
  assert.equal(ui.elements.rows.children.length, 50);
  assert.notEqual(ui.elements.rows.children[0], firstTr, 'evicted page views are recreated, not retained forever');
  // Pending edit on a visible row survives a page switch before debounce fires
  const { nameInput } = rowCells(ui.elements.rows, 0);
  nameInput.value = 'Pending rename';
  nameInput.listeners.input();
  await tick();
  ui.elements['found-next'].listeners.click();
  await tick();
  await ui.advance(400);
  await tick();
  assert.ok(seenEdits.includes('Pending rename'), 'edits live separately from evicted views');
});

test('download uses authoritative state filenames, ignores stale detached inputs, validates blank names', async () => {
  const item = { id: 'v1', pageUrl: 'https://www.eporner.com/video-1/a/', title: 'V', filename: 'Authoritative', state: 'ready', selected: true, history: [] };
  let sent = null;
  const ui = mount({ initialState: { revision: 1, batchId: 'b1', saveAs: false, input: '', items: [item] },
    onMessage: async (m, { getState }) => {
      if (m.type === 'download') { sent = m.items; const s = getState(); s.revision++; return { ok: true, state: s }; }
      return { ok: true, state: getState() };
    } });
  await tick(); await tick();
  const { nameInput } = rowCells(ui.elements.rows, 0);
  nameInput.value = 'Stale detached value';
  await tick();
  ui.elements.download.listeners.click();
  await tick(); await tick(); await tick();
  assert.ok(sent, 'download sent');
  assert.equal(sent[0].filename, 'Authoritative', 'stale detached field must not overwrite authoritative filename');
  // Blank-name validation preserved
  const ui2 = mount({ initialState: { revision: 1, batchId: 'b1', saveAs: false, input: '', items: [{ id: 'w1', pageUrl: 'https://www.eporner.com/video-9/a/', title: 'W', filename: '.mp4', state: 'ready', selected: true, history: [] }] },
    onMessage: async (m, { getState }) => {
      if (m.type === 'download') { sent = 'SHOULD-NOT-HAPPEN'; const s = getState(); s.revision++; return { ok: true, state: s }; }
      return { ok: true, state: getState() };
    } });
  await tick(); await tick();
  sent = null;
  ui2.elements.download.listeners.click();
  await tick(); await tick();
  assert.equal(sent, null, 'blank names must not start a download');
  assert.match(ui2.elements.message.textContent, /needs a name/, 'blank-name validation message preserved');
});

test('pagehide nulls the progress timer so pageshow can reschedule polling', async () => {
  const item = { id: 'v1', pageUrl: 'https://www.eporner.com/video-1/a/', title: 'V', filename: 'V', state: 'downloading', downloadId: 1, selected: false, history: [] };
  const ui = mount({ initialState: { revision: 1, batchId: 'b1', saveAs: false, input: '', items: [item] } });
  await tick(); await tick();
  assert.equal(ui.timers.size, 1, 'downloading schedules progress polling');
  ui.winEvents.pagehide();
  await tick();
  assert.equal(ui.timers.size, 0, 'pagehide clears the timer');
  ui.winEvents.pageshow();
  await tick();
  assert.equal(ui.timers.size, 1, 'pageshow reschedules after the timer was nulled');
});

test('failed draft save preserves dirty input, reports, and blocks dependent actions', async () => {
  let failInput = true;
  let findSent = 0;
  const ui = mount({ initialState: { revision: 1, batchId: 'b1', saveAs: false, input: '', inputRevision: 0, items: [] },
    onMessage: async (m, { getState }) => {
      if (m.type === 'input') {
        if (failInput) return { ok: false, error: 'Draft save failed' };
        const s = getState(); s.revision++; s.input = m.input; s.inputRevision = 1; return { ok: true, state: s };
      }
      if (m.type === 'find') { findSent++; const s = getState(); s.revision++; return { ok: true, state: s }; }
      return { ok: true, state: getState() };
    } });
  await tick(); await tick();
  ui.elements.urls.value = 'https://www.eporner.com/video-1/a/';
  ui.elements.urls.listeners.input();
  await tick();
  ui.elements.find.listeners.click();
  await tick(); await tick(); await tick();
  await ui.advance(400);
  await tick();
  assert.equal(findSent, 0, 'find must not run while the draft save failed');
  assert.match(ui.elements.message.textContent, /Draft save failed/);
  assert.equal(ui.elements.urls.value, 'https://www.eporner.com/video-1/a/', 'failed dirty input preserved');
  failInput = false;
  ui.elements.find.listeners.click();
  await tick(); await tick(); await tick();
  await ui.advance(400);
  await tick();
  assert.equal(findSent, 1, 'retry succeeds after the save recovers');
});

test('failed filename save preserves the dirty edit and blocks export until retry', async () => {
  let failEdit = true;
  let exportSent = 0;
  const item = { id: 'v1', pageUrl: 'https://www.eporner.com/video-1/a/', title: 'V', filename: 'V', state: 'ready', selected: false, history: [] };
  const ui = mount({ initialState: { revision: 1, batchId: 'b1', saveAs: false, input: '', items: [item] },
    onMessage: async (m, { getState }) => {
      if (m.type === 'edit') {
        if (failEdit) return { ok: false, error: 'Name save failed' };
        const s = getState(); s.revision++; s.items[0].filename = m.filename; return { ok: true, state: s };
      }
      if (m.type === 'export') { exportSent++; const s = getState(); return { ok: true, state: { ...s, exportText: '{}' } }; }
      return { ok: true, state: getState() };
    } });
  await tick(); await tick();
  const { nameInput } = rowCells(ui.elements.rows, 0);
  nameInput.value = 'Keep me';
  nameInput.listeners.input();
  await tick();
  await ui.advance(400);
  await tick(); await tick();
  assert.match(ui.elements.message.textContent, /Name save failed/);
  assert.equal(nameInput.value, 'Keep me', 'failed filename edit stays visible for retry');
  failEdit = false;
  ui.elements['export-found'].listeners.click();
  await tick(); await tick(); await tick();
  assert.equal(exportSent, 1, 'export proceeds after the pending rename finally saves');
  const editMsg = ui.messages.find((m) => m.type === 'edit' && m.filename === 'Keep me');
  assert.ok(editMsg, 'retry sends the preserved dirty filename');
});

test('clear prevents an in-flight draft echo from restoring old input', async () => {
  let releaseInput;
  const gate = new Promise((resolve) => { releaseInput = resolve; });
  const ui = mount({ initialState: { revision: 1, batchId: 'b1', saveAs: false, input: '', inputRevision: 0, items: [] },
    onMessage: async (m, { getState }) => {
      if (m.type === 'input') { await gate; const s = getState(); s.revision++; s.input = m.input; s.inputRevision = 5; return { ok: true, state: s }; }
      if (m.type === 'clear-input') { const s = getState(); s.revision++; s.input = ''; s.inputRevision = 6; return { ok: true, state: s }; }
      return { ok: true, state: getState() };
    } });
  await tick(); await tick();
  ui.elements.urls.value = 'stale draft';
  ui.elements.urls.listeners.input();
  await tick();
  await ui.advance(400);
  await tick();
  ui.elements.clear.listeners.click();
  await tick();
  assert.equal(ui.elements.urls.value, '', 'clear empties immediately');
  releaseInput();
  await tick(); await tick(); await tick();
  assert.equal(ui.elements.urls.value, '', 'in-flight draft must not echo stale text after clear');
});

test('quality choice is captured synchronously and survives interleaved snapshots', async () => {
  let releaseSettings;
  const gate = new Promise((resolve) => { releaseSettings = resolve; });
  const ui = mount({ initialState: { revision: 1, batchId: 'b1', saveAs: false, input: '', maxHeight: 720, preferredCodec: 'H.264', items: [] },
    onMessage: async (m, { getState }) => {
      if (m.type === 'settings') { await gate; const s = getState(); s.revision++; s.maxHeight = m.maxHeight; s.preferredCodec = m.preferredCodec; return { ok: true, state: s }; }
      return { ok: true, state: getState() };
    } });
  await tick(); await tick();
  assert.equal(ui.elements['quality-max'].value, '720');
  ui.elements['quality-max'].value = '1080';
  ui.elements['quality-max'].listeners.change();
  await tick();
  ui.backendState({ revision: 2, batchId: 'b1', saveAs: false, input: '', maxHeight: 720, preferredCodec: 'H.264', items: [] });
  ui.storageEvent.emit({ downloaderState: { newValue: ui.getState() } }, 'local');
  await tick();
  assert.equal(ui.elements['quality-max'].value, '1080', 'pending choice survives an interleaved snapshot');
  releaseSettings();
  await tick(); await tick();
  assert.equal(ui.elements['quality-max'].value, '1080', 'acknowledged choice remains');
});

test('rapid quality changes keep the latest pending value', async () => {
  const seen = [];
  let firstRelease;
  const firstGate = new Promise((resolve) => { firstRelease = resolve; });
  let calls = 0;
  const ui = mount({ initialState: { revision: 1, batchId: 'b1', saveAs: false, input: '', maxHeight: 0, preferredCodec: 'AV1', items: [] },
    onMessage: async (m, { getState }) => {
      if (m.type === 'settings') {
        calls++;
        seen.push(m.maxHeight);
        if (calls === 1) await firstGate;
        const s = getState(); s.revision++; s.maxHeight = m.maxHeight; return { ok: true, state: s };
      }
      return { ok: true, state: getState() };
    } });
  await tick(); await tick();
  ui.elements['quality-max'].value = '1080';
  ui.elements['quality-max'].listeners.change();
  await tick();
  ui.elements['quality-max'].value = '480';
  ui.elements['quality-max'].listeners.change();
  await tick();
  assert.equal(ui.elements['quality-max'].value, '480', 'second change wins immediately');
  firstRelease();
  await tick(); await tick(); await tick();
  assert.equal(ui.elements['quality-max'].value, '480', 'stale first response must not revert the pending choice');
  await ui.advance(100);
  await tick();
});

test('list snapshots without input preserve the draft and ignore older revisions', async () => {
  const ui = mount({ initialState: { revision: 5, batchId: 'b1', saveAs: false, input: 'keep me', inputRevision: 4, items: [] },
    onMessage: async (m, { getState }) => getState() && { ok: true, state: getState() } });
  await tick(); await tick();
  assert.equal(ui.elements.urls.value, 'keep me');
  const withoutInput = ui.getState();
  delete withoutInput.input;
  delete withoutInput.inputRevision;
  withoutInput.revision = 6;
  ui.backendState(withoutInput);
  ui.storageEvent.emit({ downloaderState: { newValue: withoutInput } }, 'local');
  await tick();
  assert.equal(ui.elements.urls.value, 'keep me', 'omitted input must not clear the draft');
  const older = { ...ui.getState(), revision: 7, input: 'stale', inputRevision: 2 };
  ui.backendState(older);
  ui.storageEvent.emit({ downloaderState: { newValue: older } }, 'local');
  await tick();
  assert.equal(ui.elements.urls.value, 'keep me', 'older draft revisions are ignored');
  // Draft event fetches latest snapshot even while dirty without clobbering typing
  ui.elements.urls.value = 'typing…';
  ui.elements.urls.listeners.input();
  await tick();
  let fetched = 0;
  const origMessages = ui.messages.length;
  ui.storageEvent.emit({ downloaderDraft: { newValue: { input: 'new draft', inputRevision: 9 } } }, 'local');
  await tick(); await tick(); await tick();
  fetched = ui.messages.filter((m) => m.type === 'get-state').length;
  assert.ok(fetched >= 1, 'draft event fetches latest snapshot even when dirty');
  assert.equal(ui.elements.urls.value, 'typing…', 'dirty typing not clobbered by draft event');
  void origMessages;
  await ui.advance(400);
});

test('pause needs a download id and show-file needs local history', async () => {
  const items = [
    { id: 'nodl', pageUrl: 'https://www.eporner.com/video-n/t/', title: 'N', filename: 'N', state: 'downloading', paused: false, history: [] },
    { id: 'paused-nodl', pageUrl: 'https://www.eporner.com/video-p/t/', title: 'P', filename: 'P', state: 'downloading', paused: true, history: [] },
    { id: 'stale', pageUrl: 'https://www.eporner.com/video-s/t/', title: 'S', filename: 'S', state: 'done', selected: false, downloadId: 77, history: [{ imported: true, savedAt: null, filename: 'S.mp4' }] },
    { id: 'local', pageUrl: 'https://www.eporner.com/video-l/t/', title: 'L', filename: 'L', state: 'done', selected: false, downloadId: 78, history: [{ savedAt: '2026-01-01T00:00:00.000Z', filename: 'L.mp4' }] },
  ];
  const ui = mount({ initialState: { revision: 1, batchId: 'b1', saveAs: false, input: '', items } });
  await tick(); await tick();
  const nodlRow = ui.elements.rows.children.find((tr) => tr.className.startsWith('video-row') && tr.children[1].children[0].textContent === 'N');
  const pausedNodlRow = ui.elements.rows.children.find((tr) => tr.className.startsWith('video-row') && tr.children[1].children[0].textContent === 'P');
  assert.equal(nodlRow.children[6].children[3].hidden, true, 'no pause before the download id exists');
  assert.equal(pausedNodlRow.children[6].children[4].hidden, true, 'no resume before the download id exists');
  const staleRow = ui.elements['saved-rows'].children.find((tr) => tr.className.startsWith('video-row') && tr.children[1].children[0].textContent === 'S');
  const localRow = ui.elements['saved-rows'].children.find((tr) => tr.className.startsWith('video-row') && tr.children[1].children[0].textContent === 'L');
  assert.equal(staleRow.children[6].children[5].hidden, true, 'imported stale id must not offer show-file');
  assert.equal(localRow.children[6].children[5].hidden, false, 'local completed history offers show-file');
});

test('compact selection bars stay in sync with header checkboxes', async () => {
  const items = [
    { id: 'a', pageUrl: 'https://www.eporner.com/video-a/t/', title: 'A', filename: 'A', state: 'ready', selected: true, history: [] },
    { id: 'b', pageUrl: 'https://www.eporner.com/video-b/t/', title: 'B', filename: 'B', state: 'ready', selected: false, history: [] },
  ];
  const ui = mount({ initialState: { revision: 1, batchId: 'b1', saveAs: false, input: '', items } });
  await tick(); await tick();
  assert.equal(ui.elements['select-all'].checked, ui.elements['select-all-compact'].checked, 'found header and compact stay in sync');
  assert.equal(ui.elements['select-all'].indeterminate, ui.elements['select-all-compact'].indeterminate, 'indeterminate mirrors');
});

test('row qualities list supported resolutions in both sections and persist explicit choices', async () => {
  const ui = mount({ initialState: { revision: 1, batchId: 'qualities', maxHeight: 720, items: [
    { id: 'a', pageUrl: 'https://www.eporner.com/video-a/', filename: 'A', state: 'ready', availableHeights: [2160, 1080, 720, 480] },
    { id: 'b', pageUrl: 'https://www.eporner.com/video-b/', filename: 'B', state: 'done', saved: true, history: [] },
  ] }, onMessage: async (message, { getState, setState }) => {
    const state = getState();
    if (message.type === 'quality') { state.items[0].qualityHeight = message.height; state.revision++; setState(state); }
    return { ok: true, state };
  } });
  await tick();
  const found = ui.elements.rows.children[0].children[2];
  const saved = ui.elements['saved-rows'].children[0].children[2];
  assert.deepEqual(found.children[0].children.map((option) => option.value), ['', '2160', '1080', '720', '480']);
  assert.match(found.children[1].textContent, /Max 2160p/);
  assert.equal(saved.children[0].disabled, true);
  assert.equal(saved.children[2].hidden, false);
  saved.children[2].click(); await tick();
  assert.ok(ui.messages.some((message) => message.type === 'check-quality' && message.id === 'b'));
  found.children[0].value = '480'; found.children[0].listeners.change(); await tick();
  assert.ok(ui.messages.some((message) => message.type === 'quality' && message.height === 480));
  assert.equal(found.children[0].value, '480');
});

test('row pencil opens tag chips, applies selected tags, and focuses the filename title', async () => {
  const ui = mount({ initialState: { revision: 1, batchId: 'names',
    namingPresets: { author: ['Author'], channel: ['Channel'] }, items: [
      { id: 'a', pageUrl: 'https://www.eporner.com/video-a/', title: 'Title', filename: 'Original', state: 'ready' },
    ] }, onMessage: async (message, { getState, setState }) => {
    const state = getState();
    if (message.type === 'apply-name-tags') {
      state.items[0].filename = 'Author - Original [Channel]';
      state.items[0].naming = { author: 'Author', authors: ['Author'], channel: 'Channel', videoTitle: 'Original' };
      state.revision++; setState(state);
    }
    return { ok: true, state };
  } });
  await tick();
  ui.elements.rows.children[0].children[3].children[0].children[1].click();
  assert.equal(ui.elements['rename-dialog'].open, true);
  const author = ui.elements['rename-author-chips'].children[0];
  assert.equal(author.textContent, 'Author');
  assert.equal(author.getAttribute('aria-pressed'), 'false');
  author.click(); ui.elements['rename-channel-chips'].children[0].click();
  assert.equal(ui.elements['rename-author-chips'].children[0].getAttribute('aria-pressed'), 'true');
  assert.equal(ui.elements['rename-preview'].textContent, 'Author - Original [Channel].mp4');
  ui.elements['rename-form'].listeners.submit({ preventDefault() {} }); await tick(); await tick();
  assert.equal(ui.elements['rename-dialog'].open, false);
  const input = rowCells(ui.elements.rows).nameInput;
  assert.equal(input.value, 'Author - Original [Channel]');
  assert.equal(ui.doc.activeElement, input);
  assert.equal(input.value.slice(input.selectionStart, input.selectionEnd), 'Original');
  const message = ui.messages.find((message) => message.type === 'apply-name-tags');
  assert.deepEqual(message.authors, ['Author']); assert.equal(message.channel, 'Channel');
});

test('header tag manager adds chips without videos and removes them from the library', async () => {
  const ui = mount({ onMessage: async (message, { getState, setState }) => {
    const state = getState();
    if (message.type === 'name-tag') {
      const previous = state.namingPresets || { author: [], channel: [] };
      state.namingPresets = { ...previous, [message.kind]: message.action === 'add'
        ? [...previous[message.kind], message.name] : previous[message.kind].filter((name) => name !== message.name) };
      state.revision++; setState(state);
    }
    return { ok: true, state };
  } });
  await tick();
  assert.equal(ui.elements['manage-name-tags'].disabled, false);
  ui.elements['manage-name-tags'].click();
  assert.equal(ui.elements['name-tags-dialog'].open, true);
  ui.elements['author-tag-input'].value = 'Author';
  ui.elements['author-tag-form'].listeners.submit({ preventDefault() {} });
  await tick(); await tick();
  assert.equal(ui.elements['author-tag-input'].value, '');
  assert.equal(ui.elements['author-tag-library'].children[0].children[0].textContent, 'Author');
  ui.elements['author-tag-library'].children[0].children[1].click();
  await tick(); await tick();
  assert.match(ui.elements['author-tag-library'].children[0].textContent, /No reusable author tags/);
  assert.equal(ui.getState().items.length, 0);
  assert.ok(ui.messages.some((message) => message.type === 'name-tag' && message.action === 'remove'));
});

test('chip picker supports multiple authors, one channel, and returns from the tag manager', async () => {
  const ui = mount({ initialState: { revision: 1, batchId: 'chips',
    namingPresets: { author: ['Alice', 'Beth'], channel: ['Channel A', 'Channel B'] }, items: [
      { id: 'a', pageUrl: 'https://www.eporner.com/video-a/', title: 'Title', filename: 'Title', state: 'ready' },
    ] } });
  await tick();
  const pencil = ui.elements.rows.children[0].children[3].children[0].children[1];
  assert.equal(pencil.getAttribute('aria-label'), 'Choose author and channel tags');
  assert.equal(pencil.children[0].tag, 'svg');
  pencil.click();
  ui.elements['rename-author-chips'].children[0].click();
  ui.elements['rename-author-chips'].children[1].click();
  ui.elements['rename-channel-chips'].children[0].click();
  ui.elements['rename-channel-chips'].children[1].click();
  assert.equal(ui.elements['rename-channel-chips'].children[0].getAttribute('aria-pressed'), 'false');
  assert.equal(ui.elements['rename-preview'].textContent, 'Alice & Beth - Title [Channel B].mp4');
  ui.elements['rename-manage-tags'].click();
  assert.equal(ui.elements['rename-dialog'].open, false);
  assert.equal(ui.elements['name-tags-dialog'].open, true);
  ui.elements['name-tags-close'].click();
  assert.equal(ui.elements['rename-dialog'].open, true);
  assert.equal(ui.elements['rename-preview'].textContent, 'Alice & Beth - Title [Channel B].mp4');
  ui.elements['rename-channel-chips'].children[1].click();
  ui.elements['rename-author-chips'].children[0].click();
  assert.equal(ui.elements['rename-preview'].textContent, 'Beth - Title.mp4');
});

test('import indicator spans file reading, background acknowledgement, and final lookups', async () => {
  let readFile, acknowledge;
  const ui = mount({ onMessage: async (message, { getState, setState }) => {
    if (message.type !== 'import') return { ok: true, state: getState() };
    await new Promise((resolve) => { acknowledge = resolve; });
    const state = getState(); state.revision++;
    state.items = [{ id: 'imported', pageUrl: 'https://www.eporner.com/video-a/', state: 'finding' }];
    state.importTask = { section: 'found', ids: ['imported'], added: 1, updated: 0, skipped: 0 };
    setState(state); return { ok: true, state };
  } });
  await tick();
  ui.elements['found-format'].value = 'txt'; ui.elements['import-found'].click();
  ui.elements['import-file'].files = [{ name: 'list.txt', size: 12, text: () => new Promise((resolve) => { readFile = resolve; }) }];
  ui.elements['import-file'].listeners.change(); await tick();
  assert.equal(ui.elements['import-status'].hidden, false);
  assert.match(ui.elements['import-status-text'].textContent, /Reading list.txt/);
  assert.match(ui.elements['found-import-status'].textContent, /Reading/);
  readFile('https://www.eporner.com/video-a/'); await tick();
  assert.match(ui.elements['import-status-text'].textContent, /Importing videos/);
  assert.equal(ui.elements['import-found'].disabled, true);
  acknowledge(); await tick(); await tick();
  assert.match(ui.elements['import-status-text'].textContent, /0 of 1 checked/);
  assert.equal(ui.elements['import-progress'].hidden, false);
  assert.equal(ui.elements['import-saved'].disabled, true);
  const completed = ui.getState(); completed.revision++; completed.items[0].state = 'ready';
  ui.storageEvent.emit({ downloaderState: { newValue: completed } }, 'local');
  assert.match(ui.elements['import-status-text'].textContent, /Import complete: 1 added/);
  assert.equal(ui.elements['import-progress'].hidden, true);
  assert.equal(ui.elements['import-found'].disabled, false);
});
