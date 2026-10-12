import { t, lang } from './i18n.js';

const $ = (sel, el = document) => el.querySelector(sel);
const app = $('#app');
const dlg = $('#dlg');
const toastEl = $('#toast');

// A path like /g/<token> is a guest's private page; anything else is the owner's area.
const guestToken = (location.pathname.match(/^\/g\/([\w-]+)$/) || [])[1];

const money = new Intl.NumberFormat(lang, { style: 'currency', currency: 'EUR' });
const eur = cents => money.format(cents / 100);
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const toCents = v => Math.round(parseFloat(String(v || '0').replace(',', '.')) * 100) || 0;
const today = () => new Date().toLocaleDateString('sv'); // YYYY-MM-DD in local time
const showDate = d => new Date(d + 'T00:00').toLocaleDateString(lang);
const spoolName = s => [s.brand, s.material, s.variant, s.color_name].filter(Boolean).join(' ');
const isLink = s => /^https?:\/\//i.test(s || '');

let state = null;
let tab = sessionStorage.getItem('tab') || 'spools';
let cleanup = null; // stops the camera or NFC reader owned by the open dialog
let lineRow = () => '';
let scanPreset = {}; // what the last scanned barcode prefills in a new spool

document.documentElement.lang = lang;

// ---------- plumbing ----------

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
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toastEl.classList.remove('show'), 3000);
}

function runCleanup() {
  cleanup?.();
  cleanup = null;
}
function closeDialog() {
  runCleanup();
  if (dlg.open) dlg.close();
}
dlg.addEventListener('close', runCleanup); // Escape key / back gesture
dlg.addEventListener('input', printTotal);

// onSubmit may return a function to run once the dialog is closed and data reloaded.
function openDialog(title, bodyHtml, onSubmit, submitLabel = t('save')) {
  closeDialog();
  dlg.innerHTML = `<form>
    <h2>${h(title)}</h2>
    ${bodyHtml}
    <p class="err" hidden></p>
    <menu>
      <button type="button" data-act="closeDlg">${t('cancel')}</button>
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
}

function field(name, label, value = '', attrs = '') {
  return `<label>${h(label)}<input name="${name}" value="${h(value)}" ${attrs}></label>`;
}
const empty = () => `<p class="empty">${t('empty')}</p>`;

// ---------- shared cards ----------

function printCard(p, admin) {
  const lines = p.lines.map(l => `<li><span>${h(l.label)} · ${+l.grams.toFixed(1)} g</span><span>${eur(l.cost_cents)}</span></li>`);
  if (p.adjust_cents) lines.push(`<li><span>${h(p.adjust_note || t('adjustment'))}</span><span>${eur(p.adjust_cents)}</span></li>`);
  return `<article class="card col">
    <div class="row">
      <div class="grow"><strong>${h(p.title)}</strong><small>${showDate(p.printed_at)}${admin ? ' · ' + h(p.person_name) : ''}</small></div>
      <strong>${eur(p.total_cents)}</strong>
    </div>
    <ul class="lines">${lines.join('')}</ul>
    ${admin ? `<div class="bar"><button class="danger" data-act="delPrint" data-id="${p.id}">${t('delete')}</button></div>` : ''}
  </article>`;
}

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
  return `<article class="card col">
    <div class="row">
      <div class="grow"><strong>${title}</strong>${admin ? `<small>${h(w.person_name)}</small>` : ''}</div>
      <span class="chip ${w.status}">${t(w.status)}</span>
    </div>
    ${w.note ? `<p class="note">${h(w.note)}</p>` : ''}
    ${buttons ? `<div class="bar">${buttons}</div>` : ''}
  </article>`;
}

const paymentRow = (p, admin) => `<li>
  <span>${showDate(p.paid_at)}${p.note ? ' · ' + h(p.note) : ''}</span>
  <span>${eur(p.amount_cents)}${admin ? ` <button class="link danger" data-act="delPay" data-id="${p.id}" aria-label="${t('delete')}">×</button>` : ''}</span>
</li>`;

// ---------- owner area ----------

function renderLogin() {
  app.innerHTML = `<main class="login"><form id="login">
    <h1>${t('appName')}</h1>
    <label>${t('password')}<input name="password" type="password" autocomplete="current-password" required autofocus></label>
    <p class="err" hidden></p>
    <button class="primary">${t('login')}</button>
  </form></main>`;
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
  app.innerHTML = `<main class="login"><p>${h(msg)}</p></main>`;
}

const views = {
  spools() {
    const cards = state.spools.map(spoolCard);
    return `<div class="bar">
      <button class="primary" data-act="scan">${t('scanBarcode')}</button>
      ${'NDEFReader' in window ? `<button data-act="nfc">${t('scanNfc')}</button>` : ''}
      <button data-act="spool">${t('add')}</button>
    </div>${cards.join('') || empty()}`;
  },
  prints() {
    return `<div class="bar"><button class="primary" data-act="print">${t('newPrint')}</button></div>
      ${state.prints.map(p => printCard(p, true)).join('') || empty()}`;
  },
  people() {
    const cards = state.people.map(p => {
      const b = p.balance_cents;
      const label = b > 0 ? t('owes', { amount: eur(b) }) : b < 0 ? t('credit', { amount: eur(-b) }) : t('settled');
      const pays = state.payments.filter(x => x.person_id === p.id);
      return `<article class="card col">
        <div class="row"><strong class="grow">${h(p.name)}</strong><span class="chip ${b > 0 ? 'declined' : 'printed'}">${label}</span></div>
        <div class="bar">
          <button data-act="invite" data-id="${p.id}">${t('inviteLink')}</button>
          <button data-act="pay" data-id="${p.id}">${t('addPayment')}</button>
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
    return `<div class="bar"><button class="primary" data-act="person">${t('add')}</button></div>${cards.join('') || empty()}`;
  },
  wishes() {
    const order = ['requested', 'accepted', 'printed', 'declined'];
    const sorted = [...state.wishes].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
    return sorted.map(w => wishCard(w, true)).join('') || empty();
  },
};

function renderAdmin() {
  if (!views[tab]) tab = 'spools';
  const pending = state.wishes.filter(w => w.status === 'requested').length;
  app.innerHTML = `<header><h1>${t('appName')}</h1><button class="link" data-act="logout">${t('logout')}</button></header>
    <nav>${Object.keys(views).map(k =>
      `<button data-act="tab" data-id="${k}" class="${k === tab ? 'on' : ''}">${t(k)}${k === 'wishes' && pending ? ` <b class="badge">${pending}</b>` : ''}</button>`
    ).join('')}</nav>
    <main>${views[tab]()}</main>
    <footer>${state.last_backup ? t('lastBackup', { date: new Date(state.last_backup).toLocaleString(lang) }) : t('noBackup')}</footer>`;
}

function spoolCard(s) {
  const pct = Math.max(0, Math.min(100, (s.remaining_g / s.weight_g) * 100));
  return `<button type="button" class="card ${s.archived ? 'faded' : ''}" data-act="spool" data-id="${s.id}">
    <span class="swatch" style="background:${h(s.color_hex)}"></span>
    <span class="grow">
      <strong>${h(spoolName(s))}</strong>
      <span class="meter"><i style="width:${pct}%"></i></span>
      <small>${Math.round(s.remaining_g)} / ${Math.round(s.weight_g)} g · ${eur((s.price_cents / s.weight_g) * 1000)}/kg</small>
    </span>
  </button>`;
}

// `preset` prefills a new spool (scanned tag, or a product remembered from its barcode).
function spoolDialog(spool, preset = {}) {
  const s = { brand: '', material: 'PLA', color_name: '', color_hex: '#888888', weight_g: 1000, notes: '', ...preset, ...spool };
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
    ${field('remaining_g', t('remaining'), s.remaining_g ?? '', 'type="number" min="0" step="any"')}
    ${field('barcode', t('barcode'), s.barcode ?? '', 'maxlength="500"')}
    ${field('code', t('code'), s.code ?? '', 'maxlength="500"')}
    <label>${t('notes')}<textarea name="notes" maxlength="1000" rows="2">${h(s.notes)}</textarea></label>
    ${s.id ? `<label class="check"><input type="checkbox" name="archived" ${s.archived ? 'checked' : ''}>${t('archived')}</label>
      <button type="button" class="danger" data-act="delSpool" data-id="${s.id}">${t('delete')}</button>` : ''}`;
  openDialog(s.id ? t('editSpool') : t('newSpool'), body, async fd => {
    const data = Object.fromEntries(fd);
    data.price_cents = toCents(data.price);
    data.archived = fd.has('archived');
    await api(s.id ? 'PUT' : 'POST', s.id ? `/api/spools/${s.id}` : '/api/spools', data);
  });
}

// An RFID tag belongs to one spool: open it, or start a new spool carrying the tag.
function handleTag(code) {
  const found = state.spools.find(s => s.code === code);
  toast(t(found ? 'spoolFound' : 'spoolNew'));
  spoolDialog(found, { code });
}

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
  openDialog(t('sameProduct'), `${owned.map(spoolCard).join('')}
    <div class="bar"><button type="button" class="primary" data-act="spoolFromScan">${t('newSame')}</button></div>`);
}

async function scanDialog() {
  const body = `<video playsinline muted></video><p class="hint"></p>${field('code', t('orType'), '', 'maxlength="500"')}`;
  openDialog(t('scanBarcode'), body, fd => {
    const code = fd.get('code').trim();
    return code ? () => handleBarcode(code) : null;
  }, 'OK');
  const video = $('video', dlg);
  const hint = $('.hint', dlg);
  const fallback = key => {
    video.hidden = true;
    hint.textContent = t(key);
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

async function nfcDialog() {
  openDialog(t('scanNfc'), `<p class="hint">${t('nfcHint')}</p>`);
  const hint = $('.hint', dlg);
  const ctrl = new AbortController();
  cleanup = () => ctrl.abort();
  try {
    const reader = new NDEFReader();
    reader.onreading = e => {
      if (!e.serialNumber) return (hint.textContent = t('nfcUnreadable'));
      closeDialog();
      handleTag('nfc:' + e.serialNumber);
    };
    reader.onreadingerror = () => (hint.textContent = t('nfcUnreadable'));
    await reader.scan({ signal: ctrl.signal });
  } catch {
    if (!ctrl.signal.aborted) hint.textContent = t('nfcDenied');
  }
}

function printDialog(pre = {}) {
  if (!state.people.length) return toast(t('needPerson'));
  const spools = state.spools.filter(s => !s.archived);
  const options = spools.map(s => `<option value="${s.id}">${h(spoolName(s))} (${Math.round(s.remaining_g)} g)</option>`).join('');
  lineRow = () => `<div class="line">
    <select name="spool" aria-label="${t('filament')}">${options}</select>
    <input name="grams" type="number" inputmode="decimal" min="0.1" step="0.1" placeholder="g" aria-label="${t('grams')}" required>
    <button type="button" data-act="rmLine" aria-label="${t('delete')}">×</button>
  </div>`;
  const body = `
    <label>${t('person')}<select name="person_id">${state.people.map(p =>
      `<option value="${p.id}" ${p.id === pre.person_id ? 'selected' : ''}>${h(p.name)}</option>`).join('')}</select></label>
    ${field('title', t('title'), pre.title || '', 'required maxlength="120"')}
    ${field('printed_at', t('date'), today(), 'type="date" required')}
    <fieldset><legend>${t('filament')}</legend>
      <div id="lines">${spools.length ? lineRow() : ''}</div>
      ${spools.length ? `<button type="button" data-act="addLine">${t('addFilament')}</button>` : ''}
    </fieldset>
    ${field('adjust', t('adjust'), '', 'inputmode="decimal"')}
    ${field('adjust_note', t('adjustNote'), '', 'maxlength="200"')}
    <p class="total" id="total"></p>`;
  openDialog(t('newPrint'), body, async (fd, form) => {
    await api('POST', '/api/prints', {
      person_id: +fd.get('person_id'),
      title: fd.get('title'),
      printed_at: fd.get('printed_at'),
      adjust_cents: toCents(fd.get('adjust')),
      adjust_note: fd.get('adjust_note'),
      wish_id: pre.wish_id,
      lines: [...form.querySelectorAll('.line')].map(row => ({ spool_id: +$('select', row).value, grams: parseFloat($('input', row).value) })),
    });
  });
  printTotal();
}

function printTotal() {
  const out = $('#total', dlg);
  if (!out) return;
  let cents = toCents($('[name=adjust]', dlg).value);
  for (const row of dlg.querySelectorAll('.line')) {
    const spool = state.spools.find(s => s.id === +$('select', row).value);
    if (spool) cents += Math.round(((parseFloat($('input', row).value) || 0) * spool.price_cents) / spool.weight_g);
  }
  out.textContent = `${t('total')} ${eur(cents)}`;
}

// ---------- guest area ----------

function renderGuest() {
  const b = state.balance_cents;
  app.innerHTML = `<header><h1>${t('hello', { name: h(state.person.name) })}</h1></header>
    <main>
      <section class="balance ${b > 0 ? 'due' : ''}">
        <small>${b > 0 ? t('youOwe') : b < 0 ? t('yourCredit') : t('allSettled')}</small>
        <strong>${eur(Math.abs(b))}</strong>
      </section>
      <h2>${t('wishes')}</h2>
      <div class="bar"><button class="primary" data-act="wish">${t('newWish')}</button></div>
      ${state.wishes.map(w => wishCard(w, false)).join('') || empty()}
      <h2>${t('prints')}</h2>
      ${state.prints.map(p => printCard(p, false)).join('') || empty()}
      ${state.payments.length ? `<h2>${t('payments')}</h2><article class="card col"><ul class="lines">${state.payments.map(p => paymentRow(p, false)).join('')}</ul></article>` : ''}
    </main>`;
}

// ---------- actions ----------

const remove = async url => {
  if (!confirm(t('confirmDelete'))) return;
  await api('DELETE', url);
  closeDialog();
  await refresh();
};

const actions = {
  closeDlg: closeDialog,
  tab(id) {
    tab = id;
    sessionStorage.setItem('tab', id);
    renderAdmin();
  },
  async logout() {
    await api('POST', '/api/logout');
    refresh();
  },
  spool: id => spoolDialog(state.spools.find(s => s.id === id)),
  spoolFromScan: () => spoolDialog(undefined, scanPreset),
  delSpool: id => remove(`/api/spools/${id}`),
  scan: scanDialog,
  nfc: nfcDialog,
  print: () => printDialog(),
  delPrint: id => remove(`/api/prints/${id}`),
  addLine() {
    $('#lines', dlg).insertAdjacentHTML('beforeend', lineRow());
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
    openDialog(`${t('addPayment')} · ${person.name}`, body, async fd => {
      await api('POST', '/api/payments', { person_id: id, amount_cents: toCents(fd.get('amount')), paid_at: fd.get('paid_at'), note: fd.get('note') });
    });
  },
  delPay: id => remove(`/api/payments/${id}`),
  async newToken(id) {
    if (!confirm(t('confirmNewLink'))) return;
    await api('POST', `/api/people/${id}/token`);
    await refresh();
  },
  async delPerson(id) {
    if (!confirm(t('confirmDeletePerson'))) return;
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
  wish() {
    const body = field('title', t('wishTitle'), '', 'required maxlength="120"') + field('url', t('wishUrl'), '', 'type="url" maxlength="500" placeholder="https://"') +
      `<label>${t('wishNote')}<textarea name="note" maxlength="500" rows="3"></textarea></label>`;
    openDialog(t('newWish'), body, async fd => {
      await api('POST', '/api/my/wishes', Object.fromEntries(fd));
    }, t('send'));
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

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
refresh();
