// Minimal DOM used by the original regression suite. Keep tree operations
// consistent with the browser so keyed row reconciliation can be exercised.
class Element {
  children = [];
  parentNode = null;
  value = '';
  checked = false;
  disabled = false;
  listeners = {};
  attributes = {};
  className = '';
  classList = {
    add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
    remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(' '); },
    contains: (name) => this.className.split(/\s+/).includes(name),
  };
  get firstChild() { return this.children[0] || null; }
  get nextSibling() {
    return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null;
  }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; delete this[name]; }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node, anchor) {
    if (node === anchor) return node;
    node.remove();
    const index = anchor === null ? this.children.length : this.children.indexOf(anchor);
    if (index < 0) throw new Error('Anchor is not a child');
    this.children.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }
  replaceChildren(...nodes) {
    for (const child of [...this.children]) child.remove();
    this.append(...nodes);
  }
  querySelector(selector) {
    return selector === '.empty' ? this.children.find((node) => node.className === 'empty') || null : null;
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((node) => node !== this);
    this.parentNode = null;
  }
  click() { this.listeners.click?.({ target: this }); }
  closest() { return null; }
}
module.exports = { Element };
