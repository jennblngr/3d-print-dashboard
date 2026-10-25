import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from './i18n.js';
import { api } from './lib.js';
import { createStore, refresh, useStore } from './store.js';

// ---------- icons (Lucide, from the sprite the server builds: see ICONS in server.js) ----------

export const Icon = ({ name, size = 16, stroke = 1.6 }) => (
  <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <use href={`/icons.svg#${name}`} />
  </svg>
);
// a section's icon: in the tabs, and large in its empty state
export const SECTION_ICONS = { spools: 'disc-3', prints: 'box', people: 'users', wishes: 'heart' };
export const icons = {
  plus: <Icon name="plus" />,
  scan: <Icon name="scan-barcode" />,
  logout: <Icon name="log-out" size={18} />,
  themeLight: <Icon name="sun" size={18} />,
  themeDark: <Icon name="moon" size={18} />,
  themeAuto: <Icon name="sun-moon" size={18} />,
  trash: <Icon name="trash-2" />,
  refresh: <Icon name="refresh-cw" />,
  link: <Icon name="link" />,
  pay: <Icon name="euro" />,
  close: <Icon name="x" size={18} />,
  bell: <Icon name="bell" />,
  brokenLink: <Icon name="unlink" size={40} stroke={1.2} />,
  ...Object.fromEntries(Object.entries(SECTION_ICONS).map(([k, name]) => [k, <Icon name={name} size={20} />])),
};
export const Logo = () => <span className="logo" aria-hidden="true" />;

export const Empty = ({ kind, small = false }) => (
  <div className={`empty${small ? ' small' : ''}`}>
    {small ? <Icon name={SECTION_ICONS[kind]} size={22} stroke={1.4} /> : <Icon name={SECTION_ICONS[kind]} size={36} stroke={1.2} />}
    <p>{t('empty')}</p>
  </div>
);

// `unit` is written inside the field, on the right (€, g...).
export const Field = ({ label, unit, ...input }) => (
  <label>{label}{unit ? <span className="unit" data-unit={unit}><input {...input} /></span> : <input {...input} />}</label>
);

// ---------- toast ----------

const toastStore = createStore({ msg: '', n: 0 });
let toastEl = null;

export const toast = msg => toastStore.set(s => ({ msg, n: s.n + 1 }));

// The toast is a popover: showing it again lifts it above a dialog opened in the meantime.
function raiseToast() {
  if (!toastEl?.showPopover) return;
  if (toastEl.matches(':popover-open')) toastEl.hidePopover();
  toastEl.showPopover();
}

function Toast() {
  const { msg, n } = useStore(toastStore);
  const ref = useRef(null);
  useLayoutEffect(() => {
    toastEl = ref.current;
    if (!n) return;
    raiseToast();
    toastEl.offsetWidth; // lets the fade-in start from the hidden state
    toastEl.classList.add('show');
    const timer = setTimeout(() => toastEl.classList.remove('show'), 3000);
    return () => clearTimeout(timer);
  }, [n]);
  return <div id="toast" role="status" popover="manual" ref={ref}>{msg}</div>;
}

// Runs what a button does, showing what went wrong in the toast.
export const run = fn => async (...args) => {
  try {
    await fn(...args);
  } catch (err) {
    toast(err.message);
  }
};

// ---------- windows ----------

// Slides a window down, then closes it (see "windows" in style.css).
function slideClose(d) {
  if (!d?.open || d.classList.contains('closing')) return;
  d.classList.add('closing');
  const done = () => {
    // a window opened again in the meantime stays open
    if (!d.classList.contains('closing')) return;
    d.classList.remove('closing');
    d.close();
  };
  d.addEventListener('animationend', e => e.target === d && !e.pseudoElement && done(), { once: true });
  setTimeout(done, 600); // in case the animation never runs
}
// Opens a window at once, replacing the one on screen if any.
function showNow(d) {
  d.classList.remove('closing');
  if (d.open) d.close();
  d.showModal();
  if (toastEl?.classList.contains('show')) raiseToast();
}

let seq = 0;
const dialogStore = createStore(null); // { key, element }
let dialogEl = null;

// Shows `element` (a form built on DialogForm) in the window, in place of what it showed.
export const openDialog = element => dialogStore.set({ key: ++seq, element });
export const closeDialog = () => slideClose(dialogEl);

function DialogHost() {
  const spec = useStore(dialogStore);
  const ref = useRef(null);
  useLayoutEffect(() => {
    dialogEl = ref.current;
    if (spec) showNow(ref.current);
  }, [spec?.key]);
  return (
    <dialog
      ref={ref}
      // Escape key / back gesture: slide down like the Cancel button
      onCancel={e => {
        e.preventDefault();
        closeDialog();
      }}
      // once closed, what the window showed goes (a camera stops with it)
      onClose={() => !ref.current.open && dialogStore.set(null)}
    >
      {spec && <Fragment key={spec.key}>{spec.element}</Fragment>}
    </dialog>
  );
}

// onSubmit may return a function to run once the window is closed and data reloaded.
// `aside` is a button set apart on the left of Cancel and Save (deleting, typically).
export function DialogForm({ title, subtitle, onSubmit, submitLabel = t('save'), aside, children }) {
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    if (!onSubmit) return;
    try {
      const next = await onSubmit(new FormData(e.currentTarget));
      closeDialog();
      await refresh();
      if (typeof next === 'function') next();
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <form onSubmit={submit}>
      <h2>{title}{subtitle && <small>{subtitle}</small>}</h2>
      {children}
      <p className="err" hidden={!error}>{error}</p>
      <menu>
        {aside}
        <button type="button" onClick={closeDialog}>{t(onSubmit ? 'cancel' : 'close')}</button>
        {onSubmit && <button className="primary">{submitLabel}</button>}
      </menu>
    </form>
  );
}

const confirmStore = createStore(null); // { key, question, label, resolve }

// Asks before something that cannot be undone, in place of the browser's confirm().
// Resolves to true only through the red button: Cancel, Escape or the back gesture say no.
export function ask(question, label = t('delete')) {
  confirmStore.get()?.resolve(false);
  return new Promise(resolve => confirmStore.set({ key: ++seq, question, label, resolve }));
}

function ConfirmHost() {
  const spec = useStore(confirmStore);
  const ref = useRef(null);
  const yes = useRef(false);
  useLayoutEffect(() => {
    if (!spec) return;
    yes.current = false;
    showNow(ref.current);
  }, [spec?.key]);
  const reply = answer => {
    yes.current = answer;
    slideClose(ref.current);
  };
  return (
    <dialog
      className="confirm"
      ref={ref}
      onCancel={e => {
        e.preventDefault();
        slideClose(ref.current);
      }}
      onClose={() => !ref.current.open && spec?.resolve(yes.current)}
    >
      {spec && (
        <form onSubmit={e => e.preventDefault()}>
          <h2>{spec.question}</h2>
          <menu>
            <button type="button" onClick={() => reply(false)}>{t('cancel')}</button>
            <button type="button" className="danger solid" onClick={() => reply(true)}>{spec.label}</button>
          </menu>
        </form>
      )}
    </dialog>
  );
}

// Deletes after asking, closing the window it was asked from.
export async function remove(url, question = 'confirmDelete') {
  if (!(await ask(t(question)))) return;
  await api('DELETE', url);
  closeDialog();
  await refresh();
}

// The windows and the toast sit outside the page (.app), at the end of the document.
export const Overlays = () => createPortal(<><DialogHost /><ConfirmHost /><Toast /></>, document.body);
