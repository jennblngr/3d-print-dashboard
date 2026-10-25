import { t, lang } from './i18n.js';
import { decodeTigerTag, colorFamily } from './tigertag.js';
import { watchSelects } from './select.js';

const $ = (sel, el = document) => el.querySelector(sel);
const app = $('#app');
const dlg = $('#dlg');
const confirmDlg = $('#confirm');
const toastEl = $('#toast');

// A path like /g/<token> is a guest's private page; anything else is the owner's area.
const guestToken = (location.pathname.match(/^\/g\/([\w-]+)$/) || [])[1];

const money = new Intl.NumberFormat(lang, { style: 'currency', currency: 'EUR' });
const eur = cents => money.format(cents / 100);
const fmtGrams = (g, digits = 2) => g.toLocaleString(lang, { maximumFractionDigits: digits });
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const toCents = v => Math.round(parseFloat(String(v || '0').replace(',', '.')) * 100) || 0;
const today = () => new Date().toLocaleDateString('sv'); // YYYY-MM-DD in local time
const showDate = d => new Date(d + 'T00:00').toLocaleDateString(lang);
const localDay = iso => new Date(iso).toLocaleDateString('sv');
const spoolName = s => [s.brand, s.material, s.variant, s.color_name].filter(Boolean).join(' ');
const isLink = s => /^https?:\/\//i.test(s || '');
const activeSpools = () => state.spools.filter(s => !s.archived);
const spoolOption = (s, selected) =>
  `<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${h(spoolName(s))} (${Math.round(s.remaining_g)} g)</option>`;
// Sealed spools come last, in a group of their own: picking one opens it.
const spoolOptions = (spools, selected) => {
  const sealed = spools.filter(s => s.sealed);
  return spools.filter(s => !s.sealed).map(s => spoolOption(s, selected)).join('') +
    (sealed.length ? `<optgroup label="${t('sealedGroup')}">${sealed.map(s => spoolOption(s, selected)).join('')}</optgroup>` : '');
};

let state = null;
let tab = sessionStorage.getItem('tab') || 'spools';
let cleanup = null; // stops the camera owned by the open dialog
let lineRow = () => '';
let editedLines = []; // the filament of the print being edited, with the cost it was billed at
let scanPreset = {}; // what the last scanned barcode prefills in a new spool

document.documentElement.lang = lang;

// ---------- plumbing ----------

// The theme is a choice of this device only (see theme.js); empty follows the device setting.
const THEME_KEYS = { '': 'themeAuto', light: 'themeLight', dark: 'themeDark' }; // i18n and icon keys
const currentTheme = () => document.documentElement.dataset.theme || '';
function setTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  try {
    if (theme) localStorage.setItem('theme', theme);
    else localStorage.removeItem('theme');
  } catch {}
}

async function api(method, url, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (guestToken) headers['X-Invite'] = guestToken;
  const res = await fetch(url, { method, headers, body: body && JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}

async function refresh() {
  try {
    state = await api('GET', guestToken ? '/api/my' : '/api/state');
  } catch (e) {
    if (e.status !== 401) return renderMessage(e.message);
    return guestToken ? renderMessage(t('badLink')) : renderLogin();
  }
  guestToken ? renderGuest() : renderAdmin();
  if (!guestToken) takeHash();
}

// The toast is a popover: showing it again lifts it above a dialog opened in the meantime.
function raiseToast() {
  if (!toastEl.showPopover) return;
  if (toastEl.matches(':popover-open')) toastEl.hidePopover();
  toastEl.showPopover();
}

function toast(msg) {
  toastEl.textContent = msg;
  raiseToast();
  toastEl.offsetWidth; // lets the fade-in start from the hidden state
  toastEl.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toastEl.classList.remove('show'), 3000);
}

function runCleanup() {
  cleanup?.();
  cleanup = null;
}
// Slides a window down, then closes it (see "windows" in style.css).
function slideClose(d) {
  if (!d.open || d.classList.contains('closing')) return;
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
// Closes at once, for a window replaced by another.
function closeNow(d) {
  d.classList.remove('closing');
  if (d.open) d.close();
}
function closeDialog() {
  runCleanup();
  slideClose(dlg);
}
dlg.addEventListener('close', runCleanup);
// Escape key / back gesture: slide down like the Cancel button
dlg.addEventListener('cancel', e => {
  e.preventDefault();
  closeDialog();
});
confirmDlg.addEventListener('cancel', e => {
  e.preventDefault();
  slideClose(confirmDlg);
});
dlg.addEventListener('input', printTotal);
// What the scale shows, spool included, gives the filament left once the empty spool is taken off.
dlg.addEventListener('input', e => {
  const form = e.target.form;
  if (!['scale_g', 'empty_g'].includes(e.target.name) || !form.scale_g.value) return;
  const left = parseFloat(form.scale_g.value) - (parseFloat(form.empty_g.value) || 0);
  if (Number.isFinite(left)) form.remaining_g.value = +Math.max(0, left).toFixed(2);
});

// onSubmit may return a function to run once the dialog is closed and data reloaded.
function openDialog(title, bodyHtml, onSubmit, { submitLabel = t('save'), subtitle = '' } = {}) {
  runCleanup();
  closeNow(dlg);
  dlg.innerHTML = `<form>
    <h2>${h(title)}${subtitle ? `<small>${h(subtitle)}</small>` : ''}</h2>
    ${bodyHtml}
    <p class="err" hidden></p>
    <menu>
      <button type="button" data-act="closeDlg">${t(onSubmit ? 'cancel' : 'close')}</button>
      ${onSubmit ? `<button class="primary">${h(submitLabel)}</button>` : ''}
    </menu>
  </form>`;
  const form = dlg.firstElementChild;
  form.onsubmit = async e => {
    e.preventDefault();
    if (!onSubmit) return;
    try {
      const next = await onSubmit(new FormData(form), form);
      closeDialog();
      await refresh();
      if (typeof next === 'function') next();
    } catch (err) {
      const box = $('.err', form);
      box.textContent = err.message;
      box.hidden = false;
    }
  };
  dlg.showModal();
  if (toastEl.classList.contains('show')) raiseToast();
}

// Asks before something that cannot be undone, in place of the browser's confirm().
// Resolves to true only through the red button: Cancel, Escape or the back gesture say no.
function ask(question, confirmLabel = t('delete')) {
  confirmDlg.innerHTML = `<form>
    <h2>${h(question)}</h2>
    <menu>
      <button type="button" value="">${t('cancel')}</button>
      <button type="button" value="yes" class="danger solid">${h(confirmLabel)}</button>
    </menu>
  </form>`;
  confirmDlg.onclick = e => {
    const button = e.target.closest('button');
    if (!button) return;
    confirmDlg.returnValue = button.value;
    slideClose(confirmDlg);
  };
  closeNow(confirmDlg);
  confirmDlg.returnValue = '';
  confirmDlg.showModal();
  return new Promise(resolve => confirmDlg.addEventListener('close', () => resolve(confirmDlg.returnValue === 'yes'), { once: true }));
}

function field(name, label, value = '', attrs = '') {
  return `<label>${h(label)}<input name="${name}" value="${h(value)}" ${attrs}></label>`;
}

// ---------- icons (Lucide, from the sprite the server builds: see ICONS in server.js) ----------

const icon = (name, size = 16, stroke = 1.6) =>
  `<svg width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="/icons.svg#${name}"/></svg>`;
// a section's icon: in the tabs, and large in its empty state
const SECTION_ICONS = { spools: 'disc-3', prints: 'box', people: 'users', wishes: 'heart' };
const icons = {
  plus: icon('plus'),
  scan: icon('scan-barcode'),
  settings: icon('settings', 18),
  logout: icon('log-out', 18),
  themeLight: icon('sun', 18),
  themeDark: icon('moon', 18),
  themeAuto: icon('sun-moon', 18),
  trash: icon('trash-2'),
  refresh: icon('refresh-cw'),
  link: icon('link'),
  pay: icon('euro'),
  close: icon('x', 18),
  bell: icon('bell'),
  brokenLink: icon('unlink', 40, 1.2),
  ...Object.fromEntries(Object.entries(SECTION_ICONS).map(([k, name]) => [k, icon(name, 20)])),
};
const logo = '<span class="logo" aria-hidden="true"></span>';

const empty = (kind, small = false) =>
  `<div class="empty${small ? ' small' : ''}">${small ? icon(SECTION_ICONS[kind], 22, 1.4) : icon(SECTION_ICONS[kind], 36, 1.2)}<p>${t('empty')}</p></div>`;

// Pages without the tabs (sign-in, messages, a guest's page) are "bare".
function setPage(html, bare = false) {
  app.className = bare ? 'app guest' : 'app';
  app.innerHTML = html;
}

// ---------- shared cards ----------

// The colour of the filament a print line used, when it is known: sent with the line, or
// found on a spool still in stock that carries the same name.
function lineDot(l) {
  const hex = l.color_hex || state.spools?.find(s => spoolName(s) === l.label)?.color_hex;
  return hex ? `<i class="dot" style="--c:${h(hex)}"></i>` : '';
}

// A print without a person is one the owner made for themselves: it is billed to nobody.
const isMine = p => p.person_id == null;
const toDecide = p => !isMine(p) && p.billing === 'pending';
const printOwner = p => (isMine(p) ? `${t('me')} · ${t('notBilledTag')}` : h(p.person_name));
// The owner sees who shares a print; a guest only sees in how many parts it was split.
function printSharing(p) {
  if (p.share_count < 2) return '';
  if (!p.shared_with) return ` · ${t('sharedCount', { count: p.share_count })}`;
  return ` · ${t('sharedWith', { names: p.shared_with.map(name => h(name ?? t('me'))).join(', ') })}`;
}

// A person's part of a print counts in what they owe only once the owner bills it.
const BILLING_CHIP = { pending: 'requested', billed: 'accepted', gifted: 'printed' };
const billingChip = p => (isMine(p) ? '' : `<span class="chip ${BILLING_CHIP[p.billing]}">${t('billing_' + p.billing)}</span>`);
function billingButtons(p) {
  if (isMine(p)) return '';
  const set = (billing, label, cls = '') => `<button class="${cls}" data-act="setBilling" data-id="${p.id}" data-billing="${billing}">${t(label)}</button>`;
  if (p.billing === 'pending') return set('billed', 'billIt', 'primary') + set('gifted', 'giftIt');
  return p.billing === 'billed' ? set('gifted', 'giftIt') : set('billed', 'billIt');
}

function printCard(p, admin) {
  const lines = p.lines.map(l => `<li><span>${lineDot(l)}${h(l.label)} · ${fmtGrams(l.grams)} g</span><span>${eur(l.cost_cents)}</span></li>`);
  if (p.adjust_cents) lines.push(`<li class="adj"><span>${h(p.adjust_note || t('adjustment'))}</span><span>${eur(p.adjust_cents)}</span></li>`);
  return `<article class="card col print">
    <div class="row">
      <div class="grow"><strong>${h(p.title)}</strong><small>${showDate(p.printed_at)}${admin ? ' · ' + printOwner(p) : ''}${printSharing(p)}</small></div>
      <strong class="amount">${eur(p.total_cents)}</strong>
    </div>
    ${billingChip(p)}
    <ul class="lines">${lines.join('')}</ul>
    ${admin ? `<div class="bar end">
      ${billingButtons(p)}
      <button data-act="editPrint" data-id="${p.id}">${t('edit')}</button>
      <button class="danger" data-act="delPrint" data-id="${p.id}">${t('delete')}</button>
    </div>` : ''}
  </article>`;
}

const wishFields = title => field('title', title, '', 'required maxlength="120"') + field('url', t('wishUrl'), '', 'type="url" maxlength="500" placeholder="https://"') +
  `<label>${t('wishNote')}<textarea name="note" maxlength="500" rows="3"></textarea></label>`;

function wishCard(w, admin) {
  const title = isLink(w.url) ? `<a href="${h(w.url)}" target="_blank" rel="noopener noreferrer">${h(w.title)}</a>` : h(w.title);
  let buttons = '';
  if (admin) {
    const set = (status, label, cls = '') => `<button class="${cls}" data-act="wishStatus" data-id="${w.id}" data-status="${status}">${t(label)}</button>`;
    if (w.status === 'requested') buttons += set('accepted', 'accept') + set('declined', 'decline');
    if (w.status === 'requested' || w.status === 'accepted') buttons += set('printed', 'markPrinted', 'primary');
    buttons += `<button class="danger" data-act="delWish" data-id="${w.id}">${t('delete')}</button>`;
  } else if (w.status === 'requested') {
    buttons = `<button class="danger" data-act="delMyWish" data-id="${w.id}">${t('delete')}</button>`;
  }
  const deciding = admin && (w.status === 'requested' || w.status === 'accepted');
  return `<article class="card col wish">
    <div class="row">
      <div class="grow"><strong>${title}</strong>${admin ? `<small>${h(w.person_name)}</small>` : ''}</div>
      <span class="chip ${w.status}">${t(w.status)}</span>
    </div>
    ${w.note ? `<p class="note">${h(w.note)}</p>` : ''}
    ${buttons ? `<div class="bar ${deciding ? 'choices' : 'end'}">${buttons}</div>` : ''}
  </article>`;
}

const paymentRow = (p, admin) => `<li>
  <span>${showDate(p.paid_at)}${p.note ? ' · ' + h(p.note) : ''}</span>
  <span>${eur(p.amount_cents)}${admin ? ` <button class="link danger icon" data-act="delPay" data-id="${p.id}" aria-label="${t('delete')}">${icons.close}</button>` : ''}</span>
</li>`;

// ---------- owner area ----------

function renderLogin() {
  setPage(`<main class="login"><form id="login">
    ${logo}
    <h1>${t('appName')}</h1>
    <label>${t('password')}<input name="password" type="password" autocomplete="current-password" required autofocus></label>
    <p class="err" hidden></p>
    <button class="primary">${t('login')}</button>
  </form></main>`, true);
  $('#login').onsubmit = async e => {
    e.preventDefault();
    try {
      await api('POST', '/api/login', { password: e.target.password.value });
      refresh();
    } catch (err) {
      const box = $('.err', e.target);
      box.textContent = err.message;
      box.hidden = false;
    }
  };
}

function renderMessage(msg) {
  setPage(`<main class="login"><div class="empty">${icons.brokenLink}<p>${h(msg)}</p></div></main>`, true);
}

const grid = cards => `<div class="grid">${cards.join('')}</div>`;

// Each tab is a panel: the buttons next to its title (`head`) and its content (`body`).
const views = {
  spools() {
    return {
      head: `<button class="primary" data-act="scan">${icons.scan}${t('scanBarcode')}</button>
        <button data-act="spool">${icons.plus}${t('add')}</button>`,
      body: state.spools.length ? grid(state.spools.map(spoolCard)) : empty('spools'),
    };
  },
  prints() {
    const pending = state.bambu_prints.filter(b => b.state === 'pending');
    const handled = state.bambu_prints.filter(b => b.state !== 'pending');
    const undecided = state.prints.filter(toDecide);
    const decided = state.prints.filter(p => !toDecide(p));
    return {
      head: `<button class="primary" data-act="print">${icons.plus}${t('newPrint')}</button>`,
      body: `<div class="cols"><div>
        <div id="live">${liveBlock()}</div>
        ${pending.length ? `<h3>${t('toAssign')}</h3>${grid(pending.map(bambuCard))}` : ''}
        ${undecided.length ? `<h3>${t('toDecide')}</h3>${grid(undecided.map(p => printCard(p, true)))}` : ''}
        ${pending.length || undecided.length ? `<h3>${t('prints')}</h3>` : ''}
        ${decided.length ? grid(decided.map(p => printCard(p, true))) : empty('prints')}
        ${handled.length ? `<details><summary>${t('notBilled', { count: handled.length })}</summary>
          <article class="card col"><ul class="lines">${handled.map(bambuRow).join('')}</ul></article></details>` : ''}
      </div><aside>${bambuPanel()}</aside></div>`,
    };
  },
  people() {
    const cards = state.people.map(p => {
      const b = p.balance_cents;
      const label = b > 0 ? t('owes', { amount: eur(b) }) : b < 0 ? t('credit', { amount: eur(-b) }) : t('settled');
      const pays = state.payments.filter(x => x.person_id === p.id);
      // what their prints cost in all, billed, gifted or still to decide
      const theirs = state.prints.filter(x => x.person_id === p.id);
      const undecided = theirs.filter(toDecide).length;
      const notes = [
        theirs.length ? t('printsTotal', { amount: eur(theirs.reduce((sum, x) => sum + x.total_cents, 0)) }) : '',
        undecided ? t('toDecideCount', { count: undecided }) : '',
      ].filter(Boolean).join(' · ');
      return `<article class="card col person">
        <div class="row">
          <span class="grow"><strong>${h(p.name)}</strong>${notes ? `<small>${notes}</small>` : ''}</span><span class="chip ${b > 0 ? 'declined' : 'printed'}">${label}</span>
        </div>
        <div class="bar">
          <button data-act="invite" data-id="${p.id}">${icons.link}${t('inviteLink')}</button>
          <button data-act="pay" data-id="${p.id}">${icons.pay}${t('addPayment')}</button>
        </div>
        <details>
          <summary>${t('more')}</summary>
          ${pays.length ? `<ul class="lines">${pays.map(x => paymentRow(x, true)).join('')}</ul>` : ''}
          <div class="bar">
            <button data-act="newToken" data-id="${p.id}">${t('newLink')}</button>
            <button class="danger" data-act="delPerson" data-id="${p.id}">${t('deletePerson')}</button>
          </div>
        </details>
      </article>`;
    });
    const mine = state.prints.filter(isMine);
    const me = `<button type="button" class="card me" data-act="me">
      <span class="grow"><strong>${t('me')}</strong><small>${t('printCount', { count: mine.length })} · ${t('notBilledTag')}</small></span>
      <strong class="amount">${eur(mine.reduce((sum, p) => sum + p.total_cents, 0))}</strong>
    </button>`;
    return {
      head: `<button class="primary" data-act="person">${icons.plus}${t('add')}</button>`,
      body: me + (cards.length ? grid(cards) : empty('people')),
    };
  },
  wishes() {
    const order = ['requested', 'accepted', 'printed', 'declined'];
    const sorted = [...state.wishes].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
    return {
      head: state.people.length ? `<button class="primary" data-act="adminWish">${icons.plus}${t('add')}</button>` : '',
      body: sorted.length ? grid(sorted.map(w => wishCard(w, true))) : empty('wishes'),
    };
  },
};

// All four panels are drawn: a phone shows the open one, a computer shows the others folded.
function renderAdmin() {
  if (!views[tab]) tab = 'spools';
  const counts = {
    prints: state.bambu_prints.filter(b => b.state === 'pending').length + state.prints.filter(toDecide).length,
    wishes: state.wishes.filter(w => w.status === 'requested').length,
  };
  const badge = k => (counts[k] ? `<b class="badge">${counts[k]}</b>` : '');
  const themeLabel = t('themeNow', { name: t(THEME_KEYS[currentTheme()]) });
  const backup = state.last_backup ? t('lastBackup', { date: new Date(state.last_backup).toLocaleString(lang) }) : t('noBackup');
  const panel = k => {
    const { head = '', body } = views[k]();
    return `<section class="panel ${k === tab ? 'open' : 'closed'}" data-id="${k}" aria-label="${t(k)}">
      <button type="button" class="strip" data-act="tab" data-id="${k}" aria-expanded="false">${icons[k]}${badge(k)}<span class="vlabel">${t(k)}</span></button>
      <div class="panel-head"><h2>${t(k)}</h2>${badge(k)}${head}</div>
      <div class="panel-body">${body}</div>
    </section>`;
  };
  setPage(`<div class="shell">
    <nav class="slide" style="--i: ${Object.keys(views).indexOf(tab)}" aria-label="${t('sections')}">${Object.keys(views).map(k =>
      `<button data-act="tab" data-id="${k}" ${k === tab ? 'class="on" aria-current="page"' : ''}>
        <span class="ico">${icons[k]}${badge(k)}</span><span>${t(k)}</span>
      </button>`
    ).join('')}</nav>
    <div class="page">
      <div class="topbar">
        <p class="appname">${logo}${t('appName')}</p>
        <p class="sync">${backup}</p>
        <button class="link icon" data-act="theme" aria-label="${themeLabel}">${icons[THEME_KEYS[currentTheme()]]}</button>
        <button class="link icon" data-act="settings" aria-label="${t('settings')}" title="${t('settings')}">${icons.settings}</button>
        <button class="link icon" data-act="logout" aria-label="${t('logout')}" title="${t('logout')}">${icons.logout}</button>
      </div>
      <main class="dash">${Object.keys(views).map(panel).join('')}</main>
      <footer>${backup}</footer>
    </div>
  </div>`);
}

// Opens a tab's panel in place rather than redrawing the page, so the switch can animate
// (see "animations" in style.css).
function showTab() {
  $('nav', app).style.setProperty('--i', Object.keys(views).indexOf(tab));
  for (const button of app.querySelectorAll('nav button')) {
    const on = button.dataset.id === tab;
    button.classList.toggle('on', on);
    if (on) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  for (const panel of app.querySelectorAll('.panel')) {
    panel.classList.toggle('open', panel.dataset.id === tab);
    panel.classList.toggle('closed', panel.dataset.id !== tab);
  }
  $('.dash', app).classList.add('switching');
}

// A print read from the Bambu Lab account, waiting for the owner to say what it was for.
function bambuCard(b) {
  const planned = b.failed ? ` · ${t('plannedGrams', { grams: fmtGrams(b.planned_g, 1) })}` : '';
  const dot = b.color_hex ? `<i class="dot" style="--c:${h(b.color_hex)}"></i>` : '';
  return `<article class="card col todo ${b.failed ? 'failed' : ''}">
    <div class="row">
      ${b.has_cover ? `<img class="thumb" src="/api/bambu/prints/${b.id}/cover" alt="" loading="lazy">` : ''}
      <div class="grow"><strong>${h(b.title)}</strong>
        <small>${showDate(localDay(b.ended_at))}${b.material ? ` · ${dot}${h(b.material)}` : ''} · ${fmtGrams(b.suggested_g, 1)} g${planned}</small></div>
      ${b.failed ? `<span class="chip declined">${t('failedPrint')}</span>` : ''}
    </div>
    <div class="bar choices">
      <button class="primary" data-act="bambuBill" data-id="${b.id}">${t('bill')}</button>
      <button class="ghost" data-act="bambuIgnore" data-id="${b.id}">${t('ignore')}</button>
    </div>
  </article>`;
}

function bambuRow(b) {
  const spool = state.spools.find(s => s.id === b.spool_id);
  const what = b.state === 'ignored' ? t('ignored') : `${fmtGrams(b.grams)} g${spool ? ' · ' + h(spoolName(spool)) : ''}`;
  return `<li>
    <span>${showDate(localDay(b.ended_at))} · ${h(b.title)} · ${what}</span>
    <span><button class="link" data-act="bambuReset" data-id="${b.id}">${t('putBack')}</button></span>
  </li>`;
}

function bambuPanel() {
  const b = state.bambu;
  const broken = b.connected && b.error && b.error !== 'unreachable';
  const status = !b.connected ? t('bambuOff')
    : broken ? t('bambuExpired')
    : b.error ? t('bambuUnreachable')
    : b.last_sync ? t('bambuOn', { date: new Date(b.last_sync).toLocaleString(lang) })
    : t('bambuNever');
  const liveNote = b.connected && !broken
    ? `<p class="note"><span class="status ${b.live === 'on' ? '' : 'off'}" aria-hidden="true"></span><span>${t('live_' + (b.live || 'off'))}</span></p>` : '';
  return `<h3>${t('bambuTitle')}</h3>
    <article class="card col bambu">
      <p class="note"><span class="status ${b.connected && !b.error ? '' : 'off'}" aria-hidden="true"></span><span>${status}</span></p>
      ${liveNote}
      <div class="bar">
        ${!b.connected || broken ? `<button class="primary" data-act="bambuConnect">${t('bambuConnect')}</button>` : `<button data-act="bambuSync">${icons.refresh}${t('bambuSync')}</button>`}
        ${b.connected ? `<button class="danger" data-act="bambuDisconnect">${t('bambuDisconnect')}</button>` : ''}
      </div>
    </article>
    ${b.connected ? `<h3>${t('notifications')}</h3><article class="card col bambu" id="push">${pushBlock()}</article>` : ''}`;
}

// ---------- live printer status ----------

// "1 h 05" or "12 min"
const duration = min => (min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}` : `${min} min`);

function liveBlock() {
  const busy = state.bambu_live || [];
  if (!busy.length) return '';
  return `<h3>${t('printingNow')}</h3>${grid(busy.map(p => {
    const details = [
      p.remaining_min != null && p.state !== 'PREPARE' ? t('timeLeft', { time: duration(p.remaining_min) }) : '',
      p.layers ? t('layerOf', { layer: p.layer ?? 0, layers: p.layers }) : '',
      p.error ? t('printerError', { code: `${p.error.slice(0, 4)}-${p.error.slice(4)}` }) : '',
    ].filter(Boolean).join(' · ');
    const chip = p.state === 'PAUSE' ? `<span class="chip declined">${t('livePaused')}</span>`
      : p.state === 'RUNNING' ? `<span class="chip requested">${t('liveRunning')}</span>`
      : `<span class="chip">${t('livePreparing')}</span>`;
    const pct = Math.max(0, Math.min(100, p.percent ?? 0));
    return `<article class="card col live">
      <div class="row">
        <div class="grow"><strong>${h(p.title || p.name)}</strong><small>${h(p.name)}${details ? ' · ' + details : ''}</small></div>
        ${chip}
      </div>
      <span class="meter"><i style="width:${pct}%"></i></span>
      <small><b class="qty">${pct} %</b></small>
    </article>`;
  }))}`;
}

// While the owner has the app in front of them, the live status follows the printer, and a
// print that just ended shows up without reloading.
async function pollLive() {
  if (guestToken || !state?.bambu?.connected || document.visibilityState !== 'visible') return;
  let data;
  try {
    data = await api('GET', '/api/bambu/live');
  } catch {
    return;
  }
  if (data.pending !== state.bambu_prints.filter(b => b.state === 'pending').length) return refresh();
  if (JSON.stringify(data.live) === JSON.stringify(state.bambu_live)) return;
  state.bambu_live = data.live;
  const el = $('#live', app);
  if (el) el.innerHTML = liveBlock();
}
setInterval(pollLive, 20_000);
document.addEventListener('visibilitychange', pollLive);

// ---------- notifications (this device only) ----------

const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
// 'on', 'off', 'denied' (blocked in the browser settings) or 'unsupported'
let pushState = pushSupported ? 'off' : 'unsupported';

async function pushSubscription() {
  if (!pushSupported) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) || null;
}
async function checkPush() {
  if (!pushSupported) return;
  pushState = Notification.permission === 'denied' ? 'denied' : (await pushSubscription().catch(() => null)) ? 'on' : 'off';
  const el = $('#push', app);
  if (el) el.innerHTML = pushBlock();
}

function pushBlock() {
  if (pushState === 'on') {
    return `<p class="note"><span class="status" aria-hidden="true"></span><span>${t('pushOn')}</span></p>
      <div class="bar"><button data-act="pushTest">${icons.bell}${t('pushTest')}</button><button class="danger" data-act="pushOff">${t('pushDisable')}</button></div>`;
  }
  if (pushState === 'off') {
    return `<p class="hint">${t('pushHint')}</p>
      <div class="bar"><button class="primary" data-act="pushOn">${icons.bell}${t('pushEnable')}</button></div>`;
  }
  return `<p class="hint">${t(pushState === 'denied' ? 'pushDenied' : 'pushUnsupported')}</p>`;
}

const keyBytes = key => Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
// Forgets this device on the server and in the browser.
async function pushUnsubscribe() {
  const sub = await pushSubscription().catch(() => null);
  if (!sub) return;
  await api('DELETE', '/api/push/subscriptions', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

// ---------- spool suggested for a Bambu print ----------

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
// how far apart two colours look ("redmean" distance: 0 the same, about 765 black to white)
function colorDistance(a, b) {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  const r = (r1 + r2) / 2;
  return Math.sqrt((2 + r / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - r) / 256) * (b1 - b2) ** 2);
}
// The spool a Bambu print most likely used: the same material and the closest colour, an
// opened spool with filament left before a sealed or empty one. Without a close enough colour,
// the spool used last. `matched` says whether the choice comes from what Bambu reported.
function suggestSpool(b) {
  const norm = v => (v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const pool = activeSpools().filter(s => !b.material || norm(s.material) === norm(b.material));
  if (b.color_hex && pool.length) {
    const score = s => colorDistance(s.color_hex, b.color_hex) + (s.sealed ? 30 : 0) + (s.remaining_g <= 0 ? 200 : 0);
    const best = pool.reduce((x, y) => (score(y) < score(x) ? y : x));
    if (colorDistance(best.color_hex, b.color_hex) <= 120) return { id: best.id, matched: true };
  }
  if (!b.color_hex && pool.length === 1) return { id: pool[0].id, matched: true };
  return { id: state.last_spool_id, matched: false };
}

function spoolCard(s) {
  const pct = Math.max(0, Math.min(100, (s.remaining_g / s.weight_g) * 100));
  const name = [s.material, s.variant, s.color_name].filter(Boolean).join(' ');
  const low = !s.archived && pct < 25;
  return `<button type="button" class="card spool ${s.archived ? 'faded' : low ? 'low' : ''}" style="--c:${h(s.color_hex)}" data-act="spool" data-id="${s.id}">
    <span class="swatch" aria-hidden="true"></span>
    <span class="grow">
      <small class="maker">${h(s.brand)}</small>
      <strong>${h(name)}</strong>
      <span class="meter"><i style="width:${pct}%"></i></span>
      <small><b class="qty">${Math.round(s.remaining_g)}</b> / ${Math.round(s.weight_g)} g · ${eur((s.price_cents / s.weight_g) * 1000)}/kg</small>
    </span>
    ${s.archived ? `<span class="chip">${t('finished')}</span>` : s.remaining_g < 0 ? `<span class="chip declined">${t('checkWeight')}</span>` : s.sealed ? `<span class="chip">${t('sealedChip')}</span>` : ''}
  </button>`;
}

// `preset` prefills a new spool (scanned tag, or a product remembered from its barcode).
function spoolDialog(spool, preset = {}) {
  const s = { brand: '', material: 'PLA', color_name: '', color_hex: '#888888', weight_g: 1000, notes: '', sealed: 1, ...preset, ...spool };
  const price = s.price_cents != null ? (s.price_cents / 100).toFixed(2) : '';
  const body = `
    ${field('brand', t('brand'), s.brand, 'required maxlength="80"')}
    <div class="two">
      ${field('material', t('material'), s.material, 'list="materials" maxlength="40"')}
      ${field('color_hex', t('color'), s.color_hex, 'type="color"')}
    </div>
    ${field('variant', t('variant'), s.variant ?? '', `list="variants" maxlength="40" placeholder="${t('variantNormal')}"`)}
    <datalist id="variants">${['Silk', 'Matte', 'Glossy', 'Translucent', 'Marble', 'Wood', 'Carbon', 'Glow', 'Dual colour', 'Rainbow', 'High Speed'].map(v => `<option value="${v}">`).join('')}</datalist>
    <datalist id="materials">${['PLA', 'PLA+', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC'].map(m => `<option value="${m}">`).join('')}</datalist>
    ${field('color_name', t('colorName'), s.color_name, 'maxlength="60"')}
    <div class="two">
      ${field('price', t('price'), price, 'required inputmode="decimal"')}
      ${field('weight_g', t('weight'), s.weight_g, 'required type="number" min="1" step="any"')}
    </div>
    ${field('empty_g', t('emptySpool'), s.empty_g ?? (state.empty_spool_g || ''), 'type="number" inputmode="decimal" min="0" max="5000" step="any"')}
    ${field('scale_g', t('scaleWeight'), '', 'type="number" inputmode="decimal" min="0" step="any"')}
    <p class="hint">${t('scaleHint')}</p>
    ${field('remaining_g', t('remaining'), s.remaining_g ?? '', `type="number" min="${Math.min(0, s.remaining_g ?? 0)}" step="any"`)}
    ${field('barcode', t('barcode'), s.barcode ?? '', 'maxlength="500"')}
    ${field('code', t('code'), s.code ?? '', 'maxlength="500"')}
    <label>${t('notes')}<textarea name="notes" maxlength="1000" rows="2">${h(s.notes)}</textarea></label>
    <label class="check"><input type="checkbox" name="sealed" ${s.sealed ? 'checked' : ''}>${t('sealed')}</label>
    ${s.id ? `<label class="check"><input type="checkbox" name="archived" ${s.archived ? 'checked' : ''}>${t('archived')}</label>
      <div class="delete-zone"><button type="button" class="danger" data-act="delSpool" data-id="${s.id}">${icons.trash}${t('delete')}</button></div>` : ''}`;
  openDialog(s.id ? t('editSpool') : t('newSpool'), body, async fd => {
    const data = Object.fromEntries(fd);
    data.price_cents = toCents(data.price);
    data.archived = fd.has('archived');
    data.sealed = fd.has('sealed');
    delete data.scale_g;
    await api(s.id ? 'PUT' : 'POST', s.id ? `/api/spools/${s.id}` : '/api/spools', data);
  });
}

// An RFID tag belongs to one spool: open it, or start a new spool carrying the tag.
// `details` is what the tag itself says about the spool.
function handleTag(code, details = {}) {
  const found = state.spools.find(s => s.code === code);
  toast(t(found ? 'spoolFound' : details.brand || details.material ? 'tagRead' : 'spoolNew'));
  spoolDialog(found, { ...details, code });
}

// What the app is opened for, after "#":
// - "bambu=<id>": a notification about a print that just ended, to assign it;
// - "tigertag=<chip>": the Android companion app read a TigerTag chip (a browser cannot), and
//   passes its memory. The fragment never leaves the phone: browsers do not send it.
function takeHash() {
  const bambu = /^#bambu(?:=(\d+))?$/.exec(location.hash);
  if (bambu) {
    history.replaceState(null, '', location.pathname);
    if (tab !== 'prints') actions.tab('prints');
    if (!bambu[1]) return;
    const b = state.bambu_prints.find(x => x.id === +bambu[1]);
    return b?.state === 'pending' ? actions.bambuBill(b.id) : toast(t('alreadyAssigned'));
  }
  const match = /^#tigertag=(.+)$/.exec(location.hash);
  if (!match) return;
  history.replaceState(null, '', location.pathname);
  try {
    const { code, ...details } = decodeTigerTag(decodeURIComponent(match[1]));
    details.color_name = t('color_' + colorFamily(details.color_hex));
    if (tab !== 'spools') actions.tab('spools');
    handleTag(code, details);
  } catch (e) {
    toast(t(e.reason === 'blank' ? 'tagBlank' : 'tagInvalid'));
  }
}
window.addEventListener('hashchange', () => {
  if (state && !guestToken) takeHash();
});

// A barcode names a product, which several spools can share: list the spools that carry it
// and offer a new one, prefilled from what was saved for that barcode last time.
function handleBarcode(barcode) {
  const product = state.products.find(p => p.barcode === barcode);
  const owned = state.spools.filter(s => s.barcode === barcode);
  scanPreset = { ...product, barcode };
  if (!owned.length) {
    toast(t(product ? 'productKnown' : 'spoolNew'));
    return spoolDialog(undefined, scanPreset);
  }
  openDialog(t('sameProduct'), `<div class="stack">${owned.map(spoolCard).join('')}</div>
    <div class="bar"><button type="button" class="primary" data-act="spoolFromScan">${icons.plus}${t('newSame')}</button></div>`);
}

async function scanDialog() {
  const body = `<div class="scanview"><video playsinline muted></video><span class="aim" aria-hidden="true"></span></div>
    <p class="hint" hidden></p>${field('code', t('orType'), '', 'maxlength="500"')}`;
  openDialog(t('scanBarcode'), body, fd => {
    const code = fd.get('code').trim();
    return code ? () => handleBarcode(code) : null;
  }, { submitLabel: 'OK' });
  const video = $('video', dlg);
  const hint = $('.hint', dlg);
  const fallback = key => {
    $('.scanview', dlg).hidden = true;
    hint.textContent = t(key);
    hint.hidden = false;
  };
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices) return fallback('noScanner');
  let stopped = false;
  let stream = null;
  cleanup = () => {
    stopped = true;
    stream?.getTracks().forEach(track => track.stop());
  };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    if (stopped) return stream.getTracks().forEach(track => track.stop());
    video.srcObject = stream;
    await video.play();
    const detector = new BarcodeDetector();
    const tick = async () => {
      if (stopped) return;
      const [hit] = await detector.detect(video).catch(() => []);
      if (stopped) return;
      if (hit?.rawValue) {
        closeDialog();
        return handleBarcode(hit.rawValue.trim());
      }
      setTimeout(tick, 200);
    };
    tick();
  } catch {
    if (!stopped) fallback('noCamera');
  }
}

// A filament line's value: a spool id, or for a print being edited whose spool was deleted
// since, the label it was recorded with.
const keptValue = label => `l:${label}`;

// `edit` is the print being edited (its `edit` form, with `id`): the same form, prefilled.
// `copy` is the id of a print picked in the new print form to start from: its form fills a
// new print, dated today, at the spools' current prices, leaving out filament from a spool
// deleted since.
function printDialog(pre = {}, edit = null, copy = null) {
  if (copy) edit = { ...state.prints.find(p => p.id === copy).edit, id: null, printed_at: today() };
  if (copy) edit.lines = edit.lines.filter(l => l.spool_id != null);
  // a failed print stays the owner's own; a new print started from it is a real one
  if (copy) edit.failed = false;
  const failed = edit ? edit.failed : pre.failed;
  // starting from a past print is only offered for a print entered by hand
  const sources = edit?.id || pre.bambu_id || pre.wish_id ? [] : copySources();
  const used = new Set(edit?.lines.map(l => l.spool_id));
  // an archived spool the print used stays selectable
  const spools = state.spools.filter(s => !s.archived || used.has(s.id));
  const gone = edit?.lines.filter(l => l.spool_id == null) || [];
  const options = selected =>
    spoolOptions(spools, selected) + gone.map(l => `<option value="${h(keptValue(l.label))}" ${selected === keptValue(l.label) ? 'selected' : ''}>${h(l.label)} (${t('deletedSpool')})</option>`).join('');
  lineRow = (selected = pre.spool_id, grams = '') => `<div class="line">
    <select name="spool" aria-label="${t('filament')}">${options(selected)}</select>
    <input name="grams" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="g" aria-label="${t('grams')}" value="${h(grams)}" required>
    <button type="button" class="icon" data-act="rmLine" aria-label="${t('delete')}">${icons.close}</button>
  </div>`;
  const rows = edit?.lines.length
    ? edit.lines.map(l => lineRow(l.spool_id ?? keptValue(l.label), l.grams)).join('')
    : spools.length ? lineRow() : '';
  const checked = id => (edit ? edit.person_ids.includes(id) : id === pre.person_id);
  if (edit) pre = { title: edit.title, printed_at: edit.printed_at };
  const people = failed ? [] : state.people;
  const body = `
    ${sources.length ? `<label>${t('copyFrom')}<select id="copyFrom">
      <option value="">${t('copyNone')}</option>
      ${sources.map(p => `<option value="${p.id}" ${p.id === copy ? 'selected' : ''}>${h(p.title)} · ${showDate(p.printed_at)} · ${h(p.who)}</option>`).join('')}
    </select></label>` : ''}
    <fieldset><legend>${t('forWhom')}</legend>
      ${people.map(p =>
        `<label class="check"><input type="checkbox" name="person" value="${p.id}" ${checked(p.id) ? 'checked' : ''}>${h(p.name)}</label>`).join('')}
      <label class="check"><input type="checkbox" name="person" value="" ${checked(null) || failed ? 'checked' : ''}>${t('me')}</label>
      ${failed ? `<p class="hint">${t('failedOwnerOnly')}</p>` : ''}
    </fieldset>
    ${field('title', t('title'), pre.title || '', 'required maxlength="120"')}
    ${field('printed_at', t('date'), pre.printed_at || today(), 'type="date" required')}
    <fieldset><legend>${t('filament')}</legend>
      <div id="lines">${rows}</div>
      ${spools.length ? `<button type="button" class="ghost" data-act="addLine">${t('addFilament')}</button>` : ''}
      ${pre.failed ? `<p class="hint">${t('failedHint')}</p>` : ''}
      ${pre.suggested ? `<p class="hint">${t('spoolSuggested')}</p>` : ''}
    </fieldset>
    <div id="billing">
      ${field('adjust', t('adjust'), edit?.adjust_cents ? (edit.adjust_cents / 100).toFixed(2) : '', 'inputmode="decimal"')}
      ${field('adjust_note', t('adjustNote'), edit?.adjust_note || '', 'maxlength="200"')}
    </div>
    <p class="total" id="total"></p>
    <p class="hint" id="split" hidden></p>`;
  openDialog(t(edit?.id ? 'editPrint' : 'newPrint'), body, async (fd, form) => {
    // an empty value is the owner's own part
    const people = fd.getAll('person').map(v => (v ? +v : null));
    if (!people.length) throw new Error(t('pickPerson'));
    const line = row => {
      const value = $('select', row).value;
      const grams = parseFloat($('input', row).value);
      return value.startsWith('l:') ? { spool_id: null, label: value.slice(2), grams } : { spool_id: +value, grams };
    };
    const [method, url] = edit?.id ? ['PUT', `/api/prints/${edit.id}`]
      : ['POST', pre.bambu_id ? `/api/bambu/prints/${pre.bambu_id}/bill` : '/api/prints'];
    await api(method, url, {
      person_ids: people,
      title: fd.get('title'),
      printed_at: fd.get('printed_at'),
      adjust_cents: toCents(fd.get('adjust')),
      adjust_note: fd.get('adjust_note'),
      wish_id: pre.wish_id,
      lines: [...form.querySelectorAll('.line')].map(line),
    });
  });
  const firstGrams = $('#lines input', dlg);
  if (pre.grams && firstGrams) firstGrams.value = pre.grams;
  editedLines = (!copy && edit?.lines) || [];
  const from = $('#copyFrom', dlg);
  if (from) from.onchange = () => printDialog({}, null, +from.value || null);
  printTotal();
}

// The past prints a new one can start from, newest first, a shared print listed once.
function copySources() {
  const seen = new Set();
  return state.prints.filter(p => {
    const key = JSON.stringify(p.edit);
    return !seen.has(key) && seen.add(key);
  }).map(p => ({
    id: p.id,
    title: p.title,
    printed_at: p.printed_at,
    who: p.edit.person_ids.map(id => (id === null ? t('me') : state.people.find(x => x.id === id)?.name)).join(', '),
  })).sort((a, b) => b.printed_at.localeCompare(a.printed_at) || b.id - a.id);
}

// Two steps: Bambu Lab emails a one-time code, which is then typed here. No Bambu password involved.
function bambuConnectDialog() {
  const emailField = field('email', t('bambuEmail'), '', 'type="email" required maxlength="200" autocomplete="email"');
  openDialog(t('bambuTitle'), `<p class="hint">${t('bambuEmailHint')}</p>${emailField}`, async fd => {
    const email = fd.get('email').trim();
    await api('POST', '/api/bambu/code', { email });
    const codeField = field('code', t('bambuCode'), '', 'required inputmode="numeric" autocomplete="one-time-code" maxlength="12"');
    return () => openDialog(t('bambuTitle'), codeField, async fd2 => {
      await api('POST', '/api/bambu/login', { email, code: fd2.get('code').trim() });
      return () => toast(t('bambuConnected'));
    }, { submitLabel: t('bambuConnect') });
  }, { submitLabel: t('bambuSendCode') });
}

function printTotal() {
  const out = $('#total', dlg);
  if (!out) return;
  const picked = [...dlg.querySelectorAll('[name=person]:checked')];
  const parts = Math.max(1, picked.length);
  // the owner's own part is billed to nobody: with nobody else, there is no adjustment to apply
  const billed = !picked.length || picked.some(box => box.value);
  $('#billing', dlg).hidden = !billed;
  const adjust = billed ? toCents($('[name=adjust]', dlg).value) : 0;
  // same sums as the server: each person's part is rounded on its own
  let cents = adjust;
  let part = Math.round(adjust / parts);
  for (const row of dlg.querySelectorAll('.line')) {
    const value = $('select', row).value;
    const grams = parseFloat($('input', row).value) || 0;
    // filament the edited print already used keeps the price per gram it was billed at
    const kept = editedLines.find(l => (l.spool_id == null ? keptValue(l.label) === value : String(l.spool_id) === value));
    const spool = state.spools.find(s => s.id === +value);
    const perGram = kept?.grams ? kept.cost_cents / kept.grams : spool && spool.price_cents / spool.weight_g;
    if (perGram == null) continue;
    cents += Math.round(grams * perGram);
    part += Math.round((grams / parts) * perGram);
  }
  out.innerHTML = `<span>${t('total')}</span><span>${eur(cents)}</span>`;
  const split = $('#split', dlg);
  split.hidden = parts < 2;
  split.textContent = t('splitHint', { count: parts, amount: eur(part) });
  lineHints();
}

// Warns under a line that takes more than its spool has left: the print finished that spool
// and went on with another one, so the rest can be moved to a second line.
function lineHints() {
  const lines = $('#lines', dlg);
  lines.querySelectorAll('[data-runs-out]').forEach(el => el.remove());
  const used = new Map(); // grams the lines above already took from each spool
  for (const row of lines.querySelectorAll('.line')) {
    const spool = state.spools.find(s => s.id === +$('select', row).value);
    const grams = parseFloat($('input', row).value) || 0;
    if (!spool || !grams) continue;
    // the print being edited gives its filament back before taking it again
    const before = editedLines.find(l => l.spool_id === spool.id)?.grams || 0;
    const left = Math.max(0, +(spool.remaining_g + before - (used.get(spool.id) || 0)).toFixed(2));
    used.set(spool.id, (used.get(spool.id) || 0) + grams);
    const extra = +(grams - left).toFixed(2);
    if (extra <= 0) continue;
    row.insertAdjacentHTML('afterend', `<p class="hint" data-runs-out>${t('spoolRunsOut', { left: fmtGrams(left), extra: fmtGrams(extra) })}
      <button type="button" class="ghost" data-act="splitLine" data-left="${left}" data-extra="${extra}">${t('putRestElsewhere')}</button></p>`);
  }
}

// The spool most likely to take over from one that ran out: the same product, then the same
// filament; one already opened before a sealed one.
function nextSpool(spool) {
  const others = activeSpools().filter(s => s.id !== spool.id);
  const tests = [
    s => spool.barcode && s.barcode === spool.barcode,
    s => ['brand', 'material', 'variant', 'color_name'].every(k => s[k] === spool[k]),
    s => s.material === spool.material && s.color_name === spool.color_name,
  ];
  for (const test of tests) {
    const hits = others.filter(test);
    if (hits.length) return hits.find(s => !s.sealed && s.remaining_g > 0) || hits.find(s => s.sealed) || hits[0];
  }
  return others[0] || null;
}

// ---------- guest area ----------

function renderGuest() {
  const b = state.balance_cents;
  setPage(`<div class="shell"><div class="page">
    <header><h1>${t('hello', { name: h(state.person.name) })}</h1></header>
    <main>
      <section class="balance ${b > 0 ? 'due' : ''}">
        <small>${b > 0 ? t('youOwe') : b < 0 ? t('yourCredit') : t('allSettled')}</small>
        <strong>${eur(Math.abs(b))}</strong>
      </section>
      <div class="cols">
        <div>
          <h2>${t('wishes')}</h2>
          <div class="bar"><button class="primary" data-act="wish">${icons.plus}${t('newWish')}</button></div>
          ${state.wishes.map(w => wishCard(w, false)).join('') || empty('wishes', true)}
        </div>
        <div>
          <h2>${t('prints')}</h2>
          ${state.prints.map(p => printCard(p, false)).join('') || empty('prints', true)}
          ${state.payments.length ? `<h2>${t('payments')}</h2><article class="card col"><ul class="lines">${state.payments.map(p => paymentRow(p, false)).join('')}</ul></article>` : ''}
        </div>
      </div>
    </main>
  </div></div>`, true);
}

// ---------- actions ----------

const remove = async (url, question = 'confirmDelete') => {
  if (!(await ask(t(question)))) return;
  await api('DELETE', url);
  closeDialog();
  await refresh();
};

const actions = {
  closeDlg: closeDialog,
  tab(id) {
    tab = id;
    sessionStorage.setItem('tab', id);
    showTab();
    scrollTo(0, 0);
  },
  settings() {
    openDialog(t('settings'), `${field('empty_spool_g', t('emptySpool'), state.empty_spool_g || '', 'type="number" inputmode="decimal" min="0" max="5000" step="any"')}
      <p class="hint">${t('emptySpoolHint')}</p>`, fd => api('PUT', '/api/settings', { empty_spool_g: fd.get('empty_spool_g') || 0 }).then(() => null));
  },
  // auto, then light, then dark, then back to auto
  theme() {
    const next = { '': 'light', light: 'dark', dark: '' }[currentTheme()];
    setTheme(next);
    renderAdmin();
  },
  async logout() {
    // a device signed out of no longer gets the owner's notifications
    await pushUnsubscribe();
    await api('POST', '/api/logout');
    refresh();
  },
  spool: id => spoolDialog(state.spools.find(s => s.id === id)),
  spoolFromScan: () => spoolDialog(undefined, scanPreset),
  delSpool: id => remove(`/api/spools/${id}`),
  scan: scanDialog,
  print: () => printDialog(),
  editPrint(id) {
    const p = state.prints.find(x => x.id === id);
    printDialog({}, { ...p.edit, id });
  },
  async setBilling(id, el) {
    await api('PUT', `/api/prints/${id}/billing`, { billing: el.dataset.billing });
    await refresh();
  },
  delPrint: id => remove(`/api/prints/${id}`, state.prints.find(p => p.id === id)?.share_count > 1 ? 'confirmDeleteShared' : 'confirmDelete'),
  bambuBill(id) {
    const b = state.bambu_prints.find(x => x.id === id);
    // a failed print is billed to nobody: it can only be the owner's own
    const failed = !!b.failed;
    const spool = suggestSpool(b);
    printDialog({ title: b.title, grams: b.suggested_g, printed_at: localDay(b.ended_at), spool_id: spool.id, suggested: spool.matched, bambu_id: b.id, failed, person_id: failed ? null : undefined });
  },
  async bambuIgnore(id) {
    await api('POST', `/api/bambu/prints/${id}/ignore`);
    await refresh();
  },
  async bambuReset(id) {
    await api('POST', `/api/bambu/prints/${id}/reset`);
    await refresh();
  },
  bambuConnect: bambuConnectDialog,
  async bambuSync() {
    await api('POST', '/api/bambu/sync');
    await refresh();
    toast(t('bambuChecked'));
  },
  async pushOn() {
    if ((await Notification.requestPermission()) !== 'granted') return checkPush();
    const reg = await navigator.serviceWorker.ready;
    const { key } = await api('GET', '/api/push/key');
    let sub;
    try {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
    } catch {
      throw new Error(t('pushFailed'));
    }
    try {
      await api('POST', '/api/push/subscriptions', sub.toJSON());
    } catch (e) {
      await sub.unsubscribe().catch(() => {});
      throw e;
    }
    await checkPush();
    toast(t('pushEnabled'));
  },
  async pushOff() {
    await pushUnsubscribe();
    await checkPush();
    toast(t('pushDisabled'));
  },
  async pushTest() {
    await api('POST', '/api/push/test');
    toast(t('pushSent'));
  },
  async bambuDisconnect() {
    if (!(await ask(t('confirmBambuDisconnect'), t('bambuDisconnect')))) return;
    await api('DELETE', '/api/bambu');
    await refresh();
  },
  addLine() {
    $('#lines', dlg).insertAdjacentHTML('beforeend', lineRow());
  },
  // the line keeps what its spool had left, a new line on the next spool takes the rest
  splitLine(_, el) {
    const row = el.parentElement.previousElementSibling;
    const next = nextSpool(state.spools.find(s => s.id === +$('select', row).value));
    if (!next) return toast(t('needSpool'));
    const left = +el.dataset.left;
    if (left > 0) {
      $('input', row).value = left;
      row.insertAdjacentHTML('afterend', lineRow(next.id, +el.dataset.extra));
    } else {
      $('select', row).value = next.id;
    }
    printTotal();
  },
  rmLine(_, el) {
    el.closest('.line').remove();
    printTotal();
  },
  person() {
    openDialog(t('newPerson'), field('name', t('name'), '', 'required maxlength="60"'), fd => api('POST', '/api/people', { name: fd.get('name') }).then(() => null));
  },
  async invite(id) {
    const person = state.people.find(p => p.id === id);
    const url = `${location.origin}/g/${person.token}`;
    if (navigator.share) {
      try {
        return await navigator.share({ title: t('appName'), url });
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    await navigator.clipboard.writeText(url);
    toast(t('linkCopied'));
  },
  pay(id) {
    const person = state.people.find(p => p.id === id);
    const due = person.balance_cents > 0 ? (person.balance_cents / 100).toFixed(2) : '';
    const body = field('amount', t('amount'), due, 'required inputmode="decimal"') + field('paid_at', t('date'), today(), 'type="date" required') + field('note', t('note'), '', 'maxlength="200"');
    openDialog(t('addPayment'), body, async fd => {
      await api('POST', '/api/payments', { person_id: id, amount_cents: toCents(fd.get('amount')), paid_at: fd.get('paid_at'), note: fd.get('note') });
    }, { subtitle: person.name });
  },
  delPay: id => remove(`/api/payments/${id}`),
  async newToken(id) {
    if (!(await ask(t('confirmNewLink'), t('newLink')))) return;
    await api('POST', `/api/people/${id}/token`);
    await refresh();
  },
  me() {
    const mine = state.prints.filter(isMine);
    const total = mine.reduce((sum, p) => sum + p.total_cents, 0);
    openDialog(t('me'), `<p class="total"><span>${t('filamentCost')}</span><span>${eur(total)}</span></p>
      ${mine.map(p => printCard(p, true)).join('') || `<p class="hint">${t('empty')}</p>`}`, null, { subtitle: t('myPrints') });
  },
  async delPerson(id) {
    if (!(await ask(t('confirmDeletePerson')))) return;
    await api('DELETE', `/api/people/${id}`);
    await refresh();
  },
  async wishStatus(id, el) {
    const wish = state.wishes.find(w => w.id === id);
    if (el.dataset.status === 'printed') return printDialog({ person_id: wish.person_id, title: wish.title, wish_id: wish.id });
    await api('PUT', `/api/wishes/${id}`, { status: el.dataset.status });
    await refresh();
  },
  delWish: id => remove(`/api/wishes/${id}`),
  adminWish() {
    const people = state.people.map(p => `<option value="${p.id}">${h(p.name)}</option>`).join('');
    const body = `<label>${t('wishFor')}<select name="person_id" required>${people}</select></label>` + wishFields(t('wishModel'));
    openDialog(t('newWishFor'), body, async fd => {
      await api('POST', '/api/wishes', Object.fromEntries(fd));
    });
  },
  wish() {
    openDialog(t('newWish'), wishFields(t('wishTitle')), async fd => {
      await api('POST', '/api/my/wishes', Object.fromEntries(fd));
    }, { submitLabel: t('send') });
  },
  delMyWish: id => remove(`/api/my/wishes/${id}`),
};

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  const fn = el && actions[el.dataset.act];
  if (!fn) return;
  const id = el.dataset.id;
  try {
    await fn(/^\d+$/.test(id) ? +id : id, el);
  } catch (err) {
    toast(err.message);
  }
});

watchSelects(dlg);
watchSelects(app);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(() => !guestToken && checkPush()).catch(() => {});
  // a notification tapped while the app is open, when the window could not be sent there
  navigator.serviceWorker.addEventListener('message', e => {
    if (typeof e.data?.url === 'string') location.hash = new URL(e.data.url, location.origin).hash;
  });
}
refresh();
