import { useEffect, useRef, useState } from 'react';
import { t } from './i18n.js';
import { api, copySources, eur, fmtGrams, isMine, localDay, nextSpool, showDate, spoolName, suggestSpool, toCents, today } from './lib.js';
import { getState, page, useStore } from './store.js';
import { closeDialog, DialogForm, Field, icons, openDialog, remove, run, toast } from './ui.jsx';
import { DateInput } from './DateInput.jsx';
import { Select } from './Select.jsx';
import { PrintCard, SpoolCard } from './cards.jsx';

// ---------- spools ----------

const VARIANTS = ['Silk', 'Matte', 'Glossy', 'Translucent', 'Marble', 'Wood', 'Carbon', 'Glow', 'Dual colour', 'Rainbow', 'High Speed'];
const MATERIALS = ['PLA', 'PLA+', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC'];

// `preset` prefills a new spool (scanned tag, or a product remembered from its barcode).
export const spoolDialog = (spool, preset = {}) => openDialog(<SpoolDialog spool={spool} preset={preset} />);

function SpoolDialog({ spool, preset }) {
  const state = getState();
  const s = { brand: '', material: 'PLA', color_name: '', color_hex: '#888888', weight_g: 1000, notes: '', sealed: 1, ...preset, ...spool };
  const price = s.price_cents != null ? (s.price_cents / 100).toFixed(2) : '';
  const scale = useRef(null);
  const emptyG = useRef(null);
  const remaining = useRef(null);
  // What the scale shows, spool included, gives the filament left once the empty spool is taken off.
  const weigh = () => {
    if (!scale.current.value) return;
    const left = parseFloat(scale.current.value) - (parseFloat(emptyG.current.value) || 0);
    if (Number.isFinite(left)) remaining.current.value = +Math.max(0, left).toFixed(2);
  };
  const save = async fd => {
    const data = Object.fromEntries(fd);
    data.price_cents = toCents(data.price);
    data.archived = fd.has('archived');
    data.sealed = fd.has('sealed');
    delete data.scale_g;
    await api(s.id ? 'PUT' : 'POST', s.id ? `/api/spools/${s.id}` : '/api/spools', data);
  };
  return (
    <DialogForm title={s.id ? t('editSpool') : t('newSpool')} onSubmit={save}>
      <Field name="brand" label={t('brand')} defaultValue={s.brand} required maxLength={80} />
      <div className="two">
        <Field name="material" label={t('material')} defaultValue={s.material} list="materials" maxLength={40} />
        <Field name="color_hex" label={t('color')} defaultValue={s.color_hex} type="color" />
      </div>
      <Field name="variant" label={t('variant')} defaultValue={s.variant ?? ''} list="variants" maxLength={40} placeholder={t('variantNormal')} />
      <datalist id="variants">{VARIANTS.map(v => <option key={v} value={v} />)}</datalist>
      <datalist id="materials">{MATERIALS.map(m => <option key={m} value={m} />)}</datalist>
      <Field name="color_name" label={t('colorName')} defaultValue={s.color_name} maxLength={60} />
      <div className="two">
        <Field name="price" label={t('price')} defaultValue={price} required inputMode="decimal" />
        <Field name="weight_g" label={t('weight')} defaultValue={s.weight_g} required type="number" min="1" step="any" />
      </div>
      <Field name="empty_g" label={t('emptySpool')} defaultValue={s.empty_g ?? (state.empty_spool_g || '')} ref={emptyG} onInput={weigh}
        type="number" inputMode="decimal" min="0" max="5000" step="any" />
      <Field name="scale_g" label={t('scaleWeight')} ref={scale} onInput={weigh} type="number" inputMode="decimal" min="0" step="any" />
      <p className="hint">{t('scaleHint')}</p>
      <Field name="remaining_g" label={t('remaining')} defaultValue={s.remaining_g ?? ''} ref={remaining} type="number" min={Math.min(0, s.remaining_g ?? 0)} step="any" />
      <Field name="barcode" label={t('barcode')} defaultValue={s.barcode ?? ''} maxLength={500} />
      <Field name="code" label={t('code')} defaultValue={s.code ?? ''} maxLength={500} />
      <label>{t('notes')}<textarea name="notes" maxLength={1000} rows={2} defaultValue={s.notes} /></label>
      <label className="check"><input type="checkbox" name="sealed" defaultChecked={!!s.sealed} />{t('sealed')}</label>
      {s.id && <>
        <label className="check"><input type="checkbox" name="archived" defaultChecked={!!s.archived} />{t('archived')}</label>
        <div className="delete-zone">
          <button type="button" className="danger" onClick={run(() => remove(`/api/spools/${s.id}`))}>{icons.trash}{t('delete')}</button>
        </div>
      </>}
    </DialogForm>
  );
}

// An RFID tag belongs to one spool: open it, or start a new spool carrying the tag.
// `details` is what the tag itself says about the spool.
export function handleTag(code, details = {}) {
  const found = getState().spools.find(s => s.code === code);
  toast(t(found ? 'spoolFound' : details.brand || details.material ? 'tagRead' : 'spoolNew'));
  spoolDialog(found, { ...details, code });
}

// A barcode names a product, which several spools can share: list the spools that carry it
// and offer a new one, prefilled from what was saved for that barcode last time.
function handleBarcode(barcode) {
  const state = getState();
  const product = state.products.find(p => p.barcode === barcode);
  const owned = state.spools.filter(s => s.barcode === barcode);
  const preset = { ...product, barcode };
  if (!owned.length) {
    toast(t(product ? 'productKnown' : 'spoolNew'));
    return spoolDialog(undefined, preset);
  }
  openDialog(
    <DialogForm title={t('sameProduct')}>
      <div className="stack">{owned.map(s => <SpoolCard key={s.id} s={s} />)}</div>
      <div className="bar">
        <button type="button" className="primary" onClick={() => spoolDialog(undefined, preset)}>{icons.plus}{t('newSame')}</button>
      </div>
    </DialogForm>
  );
}

export const scanDialog = () => openDialog(<ScanDialog />);

function ScanDialog() {
  const video = useRef(null);
  const [problem, setProblem] = useState(null); // why the camera cannot be used
  useEffect(() => {
    if (!('BarcodeDetector' in window) || !navigator.mediaDevices) return setProblem('noScanner');
    let stopped = false;
    let stream = null;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (stopped) return stream.getTracks().forEach(track => track.stop());
        video.current.srcObject = stream;
        await video.current.play();
        const detector = new BarcodeDetector();
        const tick = async () => {
          if (stopped) return;
          const [hit] = await detector.detect(video.current).catch(() => []);
          if (stopped) return;
          if (hit?.rawValue) {
            closeDialog();
            return handleBarcode(hit.rawValue.trim());
          }
          setTimeout(tick, 200);
        };
        tick();
      } catch {
        if (!stopped) setProblem('noCamera');
      }
    })();
    // the camera stops with the window
    return () => {
      stopped = true;
      stream?.getTracks().forEach(track => track.stop());
    };
  }, []);
  const submit = fd => {
    const code = fd.get('code').trim();
    return code ? () => handleBarcode(code) : null;
  };
  return (
    <DialogForm title={t('scanBarcode')} onSubmit={submit} submitLabel="OK">
      <div className="scanview" hidden={!!problem}>
        <video ref={video} playsInline muted />
        <span className="aim" aria-hidden="true" />
      </div>
      <p className="hint" hidden={!problem}>{problem && t(problem)}</p>
      <Field name="code" label={t('orType')} maxLength={500} />
    </DialogForm>
  );
}

// ---------- prints ----------

// A filament line's value: a spool id, or for a print being edited whose spool was deleted
// since, the label it was recorded with.
const keptValue = label => `l:${label}`;

export const newPrint = () => openDialog(<PrintDialog />);
export const editPrint = p => openDialog(<PrintDialog edit={{ ...p.edit, id: p.id }} />);
export const recordWish = w => openDialog(<PrintDialog pre={{ person_id: w.person_id, title: w.title, wish_id: w.id }} />);
export function assignBambu(b) {
  // a failed print is billed to nobody: it can only be the owner's own
  const failed = !!b.failed;
  const spool = suggestSpool(getState(), b);
  openDialog(<PrintDialog pre={{
    title: b.title, grams: b.suggested_g, printed_at: localDay(b.ended_at), spool_id: spool.id, suggested: spool.matched,
    bambu_id: b.id, failed, person_id: failed ? null : undefined,
  }} />);
}

// `edit` is the print being edited (its `edit` form, with `id`): the same form, prefilled.
// In the new print form, a past print can be picked to start from: its form fills a new print,
// dated today, at the spools' current prices, leaving out filament from a spool deleted since.
function PrintDialog({ pre = {}, edit = null }) {
  const [copy, setCopy] = useState(null);
  return <PrintForm key={copy} pre={pre} edit={edit} copy={copy} onCopy={setCopy} />;
}

let lineKey = 0;

function PrintForm({ pre, edit, copy, onCopy }) {
  // what the form is built from, as it was when it opened
  const [f] = useState(() => {
    const state = getState();
    let e = edit;
    if (copy) {
      e = { ...state.prints.find(p => p.id === copy).edit, id: null, printed_at: today() };
      e.lines = e.lines.filter(l => l.spool_id != null);
      // a failed print stays the owner's own; a new print started from it is a real one
      e.failed = false;
    }
    const used = new Set(e?.lines.map(l => l.spool_id));
    // an archived spool the print used stays selectable
    const spools = state.spools.filter(s => !s.archived || used.has(s.id));
    const gone = e?.lines.filter(l => l.spool_id == null) || [];
    const option = s => ({ value: String(s.id), label: `${spoolName(s)} (${Math.round(s.remaining_g)} g)` });
    // sealed spools come last, in a group of their own: picking one opens it
    const sealed = spools.filter(s => s.sealed);
    const options = [
      ...spools.filter(s => !s.sealed).map(option),
      ...(sealed.length ? [{ group: t('sealedGroup'), options: sealed.map(option) }] : []),
      ...gone.map(l => ({ value: keptValue(l.label), label: `${l.label} (${t('deletedSpool')})` })),
    ];
    const values = options.flatMap(o => o.options || [o]).map(o => o.value);
    const failed = e ? e.failed : pre.failed;
    return {
      state,
      e,
      p: e ? { title: e.title, printed_at: e.printed_at } : pre,
      failed,
      spools,
      options,
      values,
      // starting from a past print is only offered for a print entered by hand
      sources: e?.id || pre.bambu_id || pre.wish_id ? [] : copySources(state),
      people: failed ? [] : state.people,
      // filament the edited print already used keeps the price per gram it was billed at
      editedLines: (!copy && edit?.lines) || [],
    };
  });
  const { state, e, p, failed, spools, options, values, sources, people, editedLines } = f;
  // like the browser's own list: a spool it does not offer shows as the first one
  const spoolValue = v => (v != null && values.includes(String(v)) ? String(v) : values[0]);
  const newLine = (value = p.spool_id, grams = '') => ({ key: ++lineKey, value: spoolValue(value), grams: String(grams) });

  // an empty value is the owner's own part
  const [picked, setPicked] = useState(() => new Set([
    ...people.filter(x => (e ? e.person_ids.includes(x.id) : x.id === p.person_id)).map(x => String(x.id)),
    ...((e ? e.person_ids.includes(null) : p.person_id === null) || failed ? [''] : []),
  ]));
  const [lines, setLines] = useState(() =>
    e?.lines.length ? e.lines.map(l => newLine(l.spool_id ?? keptValue(l.label), l.grams))
      : spools.length ? [newLine(p.spool_id, p.grams || '')] : []
  );
  const [adjust, setAdjust] = useState(e?.adjust_cents ? (e.adjust_cents / 100).toFixed(2) : '');

  const toggle = value => setPicked(now => {
    const next = new Set(now);
    next.has(value) ? next.delete(value) : next.add(value);
    return next;
  });
  const setLine = (key, change) => setLines(now => now.map(l => (l.key === key ? { ...l, ...change } : l)));

  // same sums as the server: each person's part is rounded on its own
  const parts = Math.max(1, picked.size);
  // the owner's own part is billed to nobody: with nobody else, there is no adjustment to apply
  const billed = !picked.size || [...picked].some(v => v);
  const adjustCents = billed ? toCents(adjust) : 0;
  let cents = adjustCents;
  let part = Math.round(adjustCents / parts);
  for (const l of lines) {
    const grams = parseFloat(l.grams) || 0;
    const kept = editedLines.find(x => (x.spool_id == null ? keptValue(x.label) === l.value : String(x.spool_id) === l.value));
    const spool = state.spools.find(s => s.id === +l.value);
    const perGram = kept?.grams ? kept.cost_cents / kept.grams : spool && spool.price_cents / spool.weight_g;
    if (perGram == null) continue;
    cents += Math.round(grams * perGram);
    part += Math.round((grams / parts) * perGram);
  }

  // A line that takes more than its spool has left: the print finished that spool and went on
  // with another one, so the rest can be moved to a second line.
  const taken = new Map(); // grams the lines above already took from each spool
  const runsOut = lines.map(l => {
    const spool = state.spools.find(s => s.id === +l.value);
    const grams = parseFloat(l.grams) || 0;
    if (!spool || !grams) return null;
    // the print being edited gives its filament back before taking it again
    const before = editedLines.find(x => x.spool_id === spool.id)?.grams || 0;
    const left = Math.max(0, +(spool.remaining_g + before - (taken.get(spool.id) || 0)).toFixed(2));
    taken.set(spool.id, (taken.get(spool.id) || 0) + grams);
    const extra = +(grams - left).toFixed(2);
    return extra > 0 ? { left, extra } : null;
  });

  // the line keeps what its spool had left, a new line on the next spool takes the rest
  function splitLine(l, { left, extra }) {
    const next = nextSpool(state, state.spools.find(s => s.id === +l.value));
    if (!next) return toast(t('needSpool'));
    if (left <= 0) return setLine(l.key, { value: String(next.id) });
    setLines(now => now.flatMap(x => (x.key === l.key ? [{ ...x, grams: String(left) }, newLine(next.id, extra)] : [x])));
  }

  async function save(fd) {
    const personIds = [...people.filter(x => picked.has(String(x.id))).map(x => x.id), ...(picked.has('') ? [null] : [])];
    if (!personIds.length) throw new Error(t('pickPerson'));
    const [method, url] = e?.id ? ['PUT', `/api/prints/${e.id}`]
      : ['POST', pre.bambu_id ? `/api/bambu/prints/${pre.bambu_id}/bill` : '/api/prints'];
    await api(method, url, {
      person_ids: personIds,
      title: fd.get('title'),
      printed_at: fd.get('printed_at'),
      adjust_cents: toCents(fd.get('adjust')),
      adjust_note: fd.get('adjust_note'),
      wish_id: pre.wish_id,
      lines: lines.map(l => {
        const grams = parseFloat(l.grams);
        return l.value.startsWith('l:') ? { spool_id: null, label: l.value.slice(2), grams } : { spool_id: +l.value, grams };
      }),
    });
  }

  const sourceOptions = [
    { value: '', label: t('copyNone') },
    ...sources.map(x => ({ value: String(x.id), label: `${x.title} · ${showDate(x.printed_at)} · ${x.who}` })),
  ];
  return (
    <DialogForm title={t(e?.id ? 'editPrint' : 'newPrint')} onSubmit={save}>
      {sources.length > 0 && (
        <label>{t('copyFrom')}<Select options={sourceOptions} value={copy ?? ''} onChange={v => onCopy(+v || null)} /></label>
      )}
      <fieldset>
        <legend>{t('forWhom')}</legend>
        {people.map(x => (
          <label key={x.id} className="check">
            <input type="checkbox" name="person" value={x.id} checked={picked.has(String(x.id))} onChange={() => toggle(String(x.id))} />{x.name}
          </label>
        ))}
        <label className="check"><input type="checkbox" name="person" value="" checked={picked.has('')} onChange={() => toggle('')} />{t('me')}</label>
        {failed && <p className="hint">{t('failedOwnerOnly')}</p>}
      </fieldset>
      <Field name="title" label={t('title')} defaultValue={p.title || ''} required maxLength={120} />
      <label>{t('date')}<DateInput name="printed_at" defaultValue={p.printed_at || today()} /></label>
      <fieldset>
        <legend>{t('filament')}</legend>
        <div id="lines">
          {lines.map((l, i) => (
            <LineRow key={l.key} line={l} options={options} runsOut={runsOut[i]}
              onChange={change => setLine(l.key, change)}
              onRemove={() => setLines(now => now.filter(x => x.key !== l.key))}
              onSplit={() => splitLine(l, runsOut[i])} />
          ))}
        </div>
        {spools.length > 0 && <button type="button" className="ghost" onClick={() => setLines(now => [...now, newLine()])}>{t('addFilament')}</button>}
        {p.failed && <p className="hint">{t('failedHint')}</p>}
        {p.suggested && <p className="hint">{t('spoolSuggested')}</p>}
      </fieldset>
      <div id="billing" hidden={!billed}>
        <Field name="adjust" label={t('adjust')} value={adjust} onChange={ev => setAdjust(ev.target.value)} inputMode="decimal" />
        <Field name="adjust_note" label={t('adjustNote')} defaultValue={e?.adjust_note || ''} maxLength={200} />
      </div>
      <p className="total" id="total"><span>{t('total')}</span><span>{eur(cents)}</span></p>
      <p className="hint" id="split" hidden={parts < 2}>{t('splitHint', { count: parts, amount: eur(part) })}</p>
    </DialogForm>
  );
}

function LineRow({ line, options, runsOut, onChange, onRemove, onSplit }) {
  return (
    <>
      <div className="line">
        <Select name="spool" aria-label={t('filament')} options={options} value={line.value} onChange={value => onChange({ value })} />
        <input name="grams" type="number" inputMode="decimal" min="0.01" step="0.01" placeholder="g" aria-label={t('grams')}
          value={line.grams} onChange={ev => onChange({ grams: ev.target.value })} required />
        <button type="button" className="icon" onClick={onRemove} aria-label={t('delete')}>{icons.close}</button>
      </div>
      {runsOut && (
        <p className="hint">
          {t('spoolRunsOut', { left: fmtGrams(runsOut.left), extra: fmtGrams(runsOut.extra) })}
          {' '}<button type="button" className="ghost" onClick={onSplit}>{t('putRestElsewhere')}</button>
        </p>
      )}
    </>
  );
}

// The owner's own prints: billed to nobody, their filament cost added up.
export const myPrintsDialog = () => openDialog(<MyPrints />);

function MyPrints() {
  const state = useStore(page).data;
  const mine = state.prints.filter(isMine);
  const total = mine.reduce((sum, x) => sum + x.total_cents, 0);
  return (
    <DialogForm title={t('me')} subtitle={t('myPrints')}>
      <p className="total"><span>{t('filamentCost')}</span><span>{eur(total)}</span></p>
      {mine.length ? mine.map(x => <PrintCard key={x.id} state={state} p={x} admin />) : <p className="hint">{t('empty')}</p>}
    </DialogForm>
  );
}

// ---------- Bambu Lab ----------

// Two steps: Bambu Lab emails a one-time code, which is then typed here. No Bambu password involved.
export const bambuConnectDialog = () => openDialog(
  <DialogForm title={t('bambuTitle')} submitLabel={t('bambuSendCode')} onSubmit={async fd => {
    const email = fd.get('email').trim();
    await api('POST', '/api/bambu/code', { email });
    return () => openDialog(<BambuCode email={email} />);
  }}>
    <p className="hint">{t('bambuEmailHint')}</p>
    <Field name="email" label={t('bambuEmail')} type="email" required maxLength={200} autoComplete="email" />
  </DialogForm>
);

const BambuCode = ({ email }) => (
  <DialogForm title={t('bambuTitle')} submitLabel={t('bambuConnect')} onSubmit={async fd => {
    await api('POST', '/api/bambu/login', { email, code: fd.get('code').trim() });
    return () => toast(t('bambuConnected'));
  }}>
    <Field name="code" label={t('bambuCode')} required inputMode="numeric" autoComplete="one-time-code" maxLength={12} />
  </DialogForm>
);

// ---------- people, payments, settings ----------

export const settingsDialog = () => openDialog(
  <DialogForm title={t('settings')} onSubmit={fd => api('PUT', '/api/settings', { empty_spool_g: fd.get('empty_spool_g') || 0 }).then(() => null)}>
    <Field name="empty_spool_g" label={t('emptySpool')} defaultValue={getState().empty_spool_g || ''}
      type="number" inputMode="decimal" min="0" max="5000" step="any" />
    <p className="hint">{t('emptySpoolHint')}</p>
  </DialogForm>
);

export const personDialog = () => openDialog(
  <DialogForm title={t('newPerson')} onSubmit={fd => api('POST', '/api/people', { name: fd.get('name') }).then(() => null)}>
    <Field name="name" label={t('name')} required maxLength={60} />
  </DialogForm>
);

export function paymentDialog(person) {
  const due = person.balance_cents > 0 ? (person.balance_cents / 100).toFixed(2) : '';
  openDialog(
    <DialogForm title={t('addPayment')} subtitle={person.name} onSubmit={async fd => {
      await api('POST', '/api/payments', { person_id: person.id, amount_cents: toCents(fd.get('amount')), paid_at: fd.get('paid_at'), note: fd.get('note') });
    }}>
      <Field name="amount" label={t('amount')} defaultValue={due} required inputMode="decimal" />
      <label>{t('date')}<DateInput name="paid_at" defaultValue={today()} /></label>
      <Field name="note" label={t('note')} maxLength={200} />
    </DialogForm>
  );
}

// ---------- wishes ----------

const WishFields = ({ title }) => (
  <>
    <Field name="title" label={title} required maxLength={120} />
    <Field name="url" label={t('wishUrl')} type="url" maxLength={500} placeholder="https://" />
    <label>{t('wishNote')}<textarea name="note" maxLength={500} rows={3} /></label>
  </>
);

// The owner writes down a wish for one of the people.
export const adminWishDialog = () => openDialog(
  <DialogForm title={t('newWishFor')} onSubmit={async fd => {
    await api('POST', '/api/wishes', Object.fromEntries(fd));
  }}>
    <label>{t('wishFor')}<Select name="person_id" required options={getState().people.map(x => ({ value: String(x.id), label: x.name }))} /></label>
    <WishFields title={t('wishModel')} />
  </DialogForm>
);

// A guest asks for a print.
export const wishDialog = () => openDialog(
  <DialogForm title={t('newWish')} submitLabel={t('send')} onSubmit={async fd => {
    await api('POST', '/api/my/wishes', Object.fromEntries(fd));
  }}>
    <WishFields title={t('wishTitle')} />
  </DialogForm>
);
