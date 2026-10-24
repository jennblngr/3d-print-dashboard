// Drop-down lists drawn by the app, so they look the same in every browser (Firefox and Safari
// cannot style their own yet). The real <select> stays in the form, hidden: it holds the value
// that is sent, and the list drawn here only shows it and sets it.

let open = null; // the list on screen: { select, button, list }
let nextId = 0;
let typed = '';
let typedAt = 0;

const nativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');

// Enhances every <select> under `root`, now and whenever one is added later.
export function watchSelects(root) {
  const enhanceAll = () => root.querySelectorAll('select:not([data-pick])').forEach(enhance);
  new MutationObserver(enhanceAll).observe(root, { childList: true, subtree: true });
  enhanceAll();
}

function enhance(select) {
  select.dataset.pick = '';
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pick-btn';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  if (select.hasAttribute('aria-label')) button.setAttribute('aria-label', select.getAttribute('aria-label'));
  const list = document.createElement('div');
  list.className = 'pick-list';
  list.setAttribute('role', 'listbox');
  list.tabIndex = -1;
  list.popover = 'manual';
  // the button comes first, so a <label> around them names and opens the list
  const wrap = document.createElement('span');
  wrap.className = 'pick';
  select.before(wrap);
  wrap.append(button, select, list);

  // a value set by the code (a spool moved to another line...) shows at once
  Object.defineProperty(select, 'value', {
    configurable: true,
    get() { return nativeValue.get.call(this); },
    set(value) {
      nativeValue.set.call(this, value);
      show(select, button);
    },
  });
  show(select, button);

  button.addEventListener('click', () => (open?.select === select ? close() : openList(select, button, list)));
  button.addEventListener('keydown', e => {
    if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) return;
    e.preventDefault();
    openList(select, button, list);
  });
  select.addEventListener('focus', () => button.focus());
  list.addEventListener('keydown', onListKey);
  list.addEventListener('click', e => {
    const option = e.target.closest('[role=option]');
    if (option) choose(option);
  });
  list.addEventListener('pointermove', e => {
    const option = e.target.closest('[role=option]');
    if (option) setActive(option, false);
  });
}

function show(select, button) {
  const text = document.createElement('span');
  text.textContent = select.selectedOptions[0]?.text ?? '';
  button.replaceChildren(text);
}

function openList(select, button, list) {
  close();
  const item = option => {
    const el = document.createElement('div');
    el.className = 'pick-opt';
    el.id = `pick-${++nextId}`;
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', option.selected);
    el.dataset.index = option.index;
    el.textContent = option.text;
    return el;
  };
  list.replaceChildren();
  for (const child of select.children) {
    if (child.tagName !== 'OPTGROUP') {
      list.append(item(child));
      continue;
    }
    const group = document.createElement('div');
    group.className = 'pick-group';
    group.textContent = child.label;
    list.append(group, ...[...child.children].map(item));
  }
  list.showPopover();
  place(button, list);
  open = { select, button, list };
  button.setAttribute('aria-expanded', 'true');
  setActive(list.querySelector('[aria-selected=true]') || list.querySelector('[role=option]'));
  list.focus();
  document.addEventListener('pointerdown', onOutside, true);
  addEventListener('scroll', onScroll, true);
  addEventListener('resize', close);
}

// Under the button, or above it when the screen has more room there.
function place(button, list) {
  const r = button.getBoundingClientRect();
  const below = innerHeight - r.bottom - 12;
  const above = r.top - 12;
  const up = below < 200 && above > below;
  Object.assign(list.style, {
    left: `${Math.max(8, r.left)}px`,
    minWidth: `${r.width}px`,
    maxWidth: `${innerWidth - Math.max(8, r.left) - 8}px`,
    maxHeight: `${Math.min(320, up ? above : below)}px`,
    top: up ? 'auto' : `${r.bottom + 4}px`,
    bottom: up ? `${innerHeight - r.top + 4}px` : 'auto',
  });
}

function close() {
  if (!open) return;
  const { button, list } = open;
  open = null;
  button.setAttribute('aria-expanded', 'false');
  try {
    list.hidePopover();
  } catch {} // already gone with its window
  document.removeEventListener('pointerdown', onOutside, true);
  removeEventListener('scroll', onScroll, true);
  removeEventListener('resize', close);
}

function choose(option) {
  const { select, button } = open;
  const index = +option.dataset.index;
  const changed = select.selectedIndex !== index;
  select.selectedIndex = index;
  show(select, button);
  close();
  button.focus();
  if (!changed) return;
  // the form reacts as it would to the browser's own list (totals, "start from a past print")
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function setActive(option, scroll = true) {
  if (!option) return;
  const { list } = open || { list: option.parentElement };
  list.querySelector('.active')?.classList.remove('active');
  option.classList.add('active');
  list.setAttribute('aria-activedescendant', option.id);
  if (scroll) option.scrollIntoView({ block: 'nearest' });
}

function onListKey(e) {
  const { list, button } = open;
  const options = [...list.querySelectorAll('[role=option]')];
  const at = options.indexOf(list.querySelector('.active'));
  const moves = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: options.length - 1, PageDown: at + 8, PageUp: at - 8 };
  if (e.key in moves) {
    e.preventDefault();
    setActive(options[Math.max(0, Math.min(options.length - 1, moves[e.key]))]);
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (options[at]) choose(options[at]);
  } else if (e.key === 'Escape' || e.key === 'Tab') {
    // Escape closes the list only, not the window around it
    e.preventDefault();
    e.stopPropagation();
    close();
    button.focus();
  } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    // typing a few letters jumps to the first option that starts with them
    typed = Date.now() - typedAt > 700 ? e.key : typed + e.key;
    typedAt = Date.now();
    const hit = options.find(o => o.textContent.toLowerCase().startsWith(typed.toLowerCase()));
    if (hit) setActive(hit);
  }
}

function onOutside(e) {
  if (!open.list.contains(e.target) && !open.button.contains(e.target)) close();
}

function onScroll(e) {
  if (e.target !== open?.list) close();
}
