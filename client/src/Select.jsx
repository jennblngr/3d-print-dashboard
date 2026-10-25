import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

// Drop-down lists drawn by the app, so they look the same in every browser (Firefox and Safari
// cannot style their own yet). The real <select> stays in the form, hidden: it holds the value
// that is sent, and the list drawn here only shows it and sets it.
//
// `options` lists { value, label }, or { group, options } for a group of them under a title.
// The list follows `value` when it is given (with `onChange`), or keeps its own from `defaultValue`.
export function Select({ options, value, defaultValue, onChange, name, required, id, 'aria-label': ariaLabel }) {
  const flat = options.flatMap(o => o.options || [o]);
  const [own, setOwn] = useState(() => String(defaultValue ?? flat[0]?.value ?? ''));
  const wanted = value != null ? String(value) : own;
  // like the browser's own list, a value it does not offer shows the first option
  const at = Math.max(0, flat.findIndex(o => String(o.value) === wanted));
  const current = flat[at];

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const button = useRef(null);
  const list = useRef(null);
  const scrollTo = useRef(false); // the active option moved by the keyboard comes into view
  const typed = useRef({ text: '', at: 0 });
  const uid = useId();

  const close = () => setOpen(false);
  const openList = () => {
    setActive(at);
    scrollTo.current = true;
    setOpen(true);
  };
  const choose = index => {
    const next = String(flat[index].value);
    setOwn(next);
    close();
    button.current.focus();
    if (next !== String(current?.value)) onChange?.(next);
  };
  const move = index => {
    scrollTo.current = true;
    setActive(index);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const el = list.current;
    el.showPopover();
    place(button.current, el);
    el.focus();
    const onOutside = e => !el.contains(e.target) && !button.current.contains(e.target) && close();
    const onScroll = e => e.target !== el && close();
    document.addEventListener('pointerdown', onOutside, true);
    addEventListener('scroll', onScroll, true);
    addEventListener('resize', close);
    return () => {
      try {
        el.hidePopover();
      } catch {} // already gone with its window
      document.removeEventListener('pointerdown', onOutside, true);
      removeEventListener('scroll', onScroll, true);
      removeEventListener('resize', close);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !scrollTo.current) return;
    scrollTo.current = false;
    list.current.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  function onListKey(e) {
    const moves = { ArrowDown: active + 1, ArrowUp: active - 1, Home: 0, End: flat.length - 1, PageDown: active + 8, PageUp: active - 8 };
    if (e.key in moves) {
      e.preventDefault();
      move(Math.max(0, Math.min(flat.length - 1, moves[e.key])));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (flat[active]) choose(active);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      // Escape closes the list only, not the window around it
      e.preventDefault();
      e.stopPropagation();
      close();
      button.current.focus();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // typing a few letters jumps to the first option that starts with them
      const t = typed.current;
      t.text = Date.now() - t.at > 700 ? e.key : t.text + e.key;
      t.at = Date.now();
      const hit = flat.findIndex(o => o.label.toLowerCase().startsWith(t.text.toLowerCase()));
      if (hit >= 0) move(hit);
    }
  }

  let index = 0;
  const item = o => {
    const i = index++;
    return (
      <div
        key={i}
        id={`${uid}-${i}`}
        className={`pick-opt${i === active ? ' active' : ''}`}
        role="option"
        aria-selected={i === at}
        onClick={() => choose(i)}
        onPointerMove={() => i !== active && setActive(i)}
      >
        {o.label}
      </div>
    );
  };

  return (
    // the button comes first, so a <label> around them names and opens the list
    <span className="pick">
      <button
        type="button"
        className="pick-btn"
        ref={button}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? close() : openList())}
        onKeyDown={e => {
          if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) return;
          e.preventDefault();
          openList();
        }}
      >
        <span>{current?.label ?? ''}</span>
      </button>
      <select
        id={id}
        name={name}
        required={required}
        value={current ? String(current.value) : ''}
        onChange={e => choose(e.target.selectedIndex)}
        onFocus={() => button.current.focus()}
        tabIndex={-1}
        aria-hidden="true"
      >
        {options.map((o, i) =>
          o.options ? (
            <optgroup key={i} label={o.group}>
              {o.options.map(x => <option key={x.value} value={x.value}>{x.label}</option>)}
            </optgroup>
          ) : (
            <option key={o.value} value={o.value}>{o.label}</option>
          )
        )}
      </select>
      <div
        className="pick-list"
        ref={list}
        role="listbox"
        tabIndex={-1}
        popover="manual"
        aria-activedescendant={open && active >= 0 ? `${uid}-${active}` : undefined}
        onKeyDown={onListKey}
      >
        {open && options.map((o, i) =>
          o.options ? (
            <Fragment key={`g${i}`}>
              <div className="pick-group">{o.group}</div>
              {o.options.map(item)}
            </Fragment>
          ) : (
            item(o)
          )
        )}
      </div>
    </span>
  );
}

// Under the button, or above it when there is less than `need` under it and more room above.
// The list is never taller than `tall`.
export function place(button, list, tall = 320, need = 200) {
  const r = button.getBoundingClientRect();
  const below = innerHeight - r.bottom - 12;
  const above = r.top - 12;
  const up = below < need && above > below;
  Object.assign(list.style, {
    left: `${Math.max(8, r.left)}px`,
    minWidth: `${r.width}px`,
    maxWidth: `${innerWidth - Math.max(8, r.left) - 8}px`,
    maxHeight: `${Math.min(tall, up ? above : below)}px`,
    top: up ? 'auto' : `${r.bottom + 4}px`,
    bottom: up ? `${innerHeight - r.top + 4}px` : 'auto',
  });
}
