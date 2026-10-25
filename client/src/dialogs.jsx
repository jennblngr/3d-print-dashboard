import { useEffect, useRef, useState } from 'react';
import { t } from './i18n.js';
import { api, copySources, eur, fmtGrams, groupPrints, isMine, localDay, showDate, spoolName, suggestSpool, toCents, today } from './lib.js';
import { getState, page, useStore } from './store.js';
import { closeDialog, DialogForm, Field, icons, openDialog, remove, run, toast } from './ui.jsx';
import { DateInput } from './DateInput.jsx';
import { Select } from './Select.jsx';
import { PrintGroupCard } from './cards.jsx';

// ---------- spools ----------

const VARIANTS = ['Silk', 'Matte', 'Glossy', 'Translucent', 'Marble', 'Wood', 'Carbon', 'Glow', 'Dual colour', 'Rainbow', 'High Speed'];
const MATERIALS = ['PLA', 'PLA+', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC'];

// `preset` prefills a new spool (scanned tag, or a product remembered from its barcode).
export const spoolDialog = (spool, preset = {}) => openDialog(<SpoolDialog spool={spool} preset={preset} />);

function SpoolDialog({ spool, preset }) {
  const s = { brand: '', material: 'PLA', color_name: '', color_hex: '#888888', weight_g: 1000, notes: '', ...preset, ...spool };
  // what the head of the window shows, as it is being typed
  const [v, setV] = useState(() => ({
    brand: s.brand, material: s.material, variant: s.variant ?? '', color_name: s.color_name, color_hex: s.color_hex,
    price: s.price_cents != null ? (s.price_cents / 100).toFixed(2) : '', weight_g: String(s.weight_g),
  }));
  const bind = name => ({ name, value: v[name], onChange: ev => setV(now => ({ ...now, [name]: ev.target.value })) });
  const priceCents = toCents(v.price);
  const weight = parseFloat(v.weight_g);
  const save = async fd => {
    const data = Object.fromEntries(fd);
    data.price_cents = toCents(data.price);
    data.archived = fd.has('archived');
    await api(s.id ? 'PUT' : 'POST', s.id ? `/api/spools/${s.id}` : '/api/spools', data);
  };
  const del = s.id && <button type="button" className="danger" onClick={run(() => remove(`/api/spools/${s.id}`))}>{t('delete')}</button>;
  return (
    <DialogForm title={s.id ? t('editSpool') : t('newSpool')} onSubmit={save} aside={del}>
      <div className="card spool-head" style={{ '--c': v.color_hex }}>
        <span className="swatch" aria-hidden="true" />
        <span className="grow">
          <strong>{spoolName(v) || t('newSpool')}</strong>
          {weight > 0 && <small>{t('spoolOf', { grams: fmtGrams(weight) })}</small>}
        </span>
        {priceCents > 0 && weight > 0 && <span className="per-kg"><strong className="amount">{eur((priceCents / weight) * 1000)}</strong><small>/kg</small></span>}
      </div>
      <Field label={t('brand')} {...bind('brand')} required maxLength={80} />
      <div className="two">
        <Field label={t('material')} {...bind('material')} list="materials" maxLength={40} />
        <Field label={t('variant')} {...bind('variant')} list="variants" maxLength={40} placeholder={t('variantNormal')} />
      </div>
      <datalist id="variants">{VARIANTS.map(x => <option key={x} value={x} />)}</datalist>
      <datalist id="materials">{MATERIALS.map(x => <option key={x} value={x} />)}</datalist>
      <div>
        <p className="label">{t('color')}</p>
        <div className="color-row">
          <input type="color" aria-label={t('color')} {...bind('color_hex')} />
          <input aria-label={t('colorName')} placeholder={t('colorName')} {...bind('color_name')} maxLength={60} />
        </div>
      </div>
      <div className="two">
        <Field label={t('price')} unit="€" {...bind('price')} required inputMode="decimal" />
        <Field label={t('weight')} unit="g" {...bind('weight_g')} required type="number" min="1" step="any" />
      </div>
      <details open={!s.id && !!(s.barcode || s.code)}>
        <summary>{t('spoolMore')}</summary>
        <Field name="barcode" label={t('barcode')} defaultValue={s.barcode ?? ''} maxLength={500} />
        <Field name="code" label={t('code')} defaultValue={s.code ?? ''} maxLength={500} />
        <label>{t('notes')}<textarea name="notes" maxLength={1000} rows={2} defaultValue={s.notes} /></label>
      </details>
      {s.id && <label className="check"><input type="checkbox" name="archived" defaultChecked={!!s.archived} />{t('archived')}</label>}
    </DialogForm>
  );
}

// A spool stands for a product (its price and weight), not for one physical spool: a scan
// opens the spool already saved for that product rather than adding the same one again.
// One still in use comes first, then the one saved last.
const findSpool = test => {
  const hits = getState().spools.filter(test);
  return hits.find(s => !s.archived) || hits.sort((a, b) => b.id - a.id)[0];
};

// An RFID tag: the spool carrying it, else one of the same product as the tag describes it
// (a new spool of a known product has a new tag), else a new spool carrying the tag.
// `details` is what the tag itself says about the spool.
export function handleTag(code, details = {}) {
  const same = ['brand', 'material', 'variant', 'color_hex'];
  const found = findSpool(s => s.code === code)
    || (details.brand && details.material ? findSpool(s => same.every(k => (s[k] || '').toLowerCase() === (details[k] || '').toLowerCase())) : undefined);
  toast(t(found ? 'spoolFound' : details.brand || details.material ? 'tagRead' : 'spoolNew'));
  spoolDialog(found, { ...details, code });
}

// A barcode names a product: open its spool, or start one prefilled from what was saved for
// that barcode last time.
function handleBarcode(barcode) {
  const found = findSpool(s => s.barcode === barcode);
  if (found) {
    toast(t('spoolFound'));
    return spoolDialog(found);
  }
  const product = getState().products.find(p => p.barcode === barcode);
  toast(t(product ? 'productKnown' : 'spoolNew'));
  spoolDialog(undefined, { ...product, barcode });
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
    const options = [
      ...spools.map(s => ({ value: String(s.id), label: spoolName(s) })),
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
  // billed or gifted, per person: a new part is billed unless the owner gifts it; an edited
  // part still to decide stays so until a choice is made
  const [billing, setBilling] = useState(() => ({ ...e?.billing }));
  const billingOf = id => billing[id] ?? 'billed';

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
  const adjustPart = Math.round(adjustCents / parts);
  let part = adjustPart;
  for (const l of lines) {
    const grams = parseFloat(l.grams) || 0;
    const kept = editedLines.find(x => (x.spool_id == null ? keptValue(x.label) === l.value : String(x.spool_id) === l.value));
    const spool = state.spools.find(s => s.id === +l.value);
    const perGram = kept?.grams ? kept.cost_cents / kept.grams : spool && spool.price_cents / spool.weight_g;
    if (perGram == null) continue;
    cents += Math.round(grams * perGram);
    part += Math.round((grams / parts) * perGram);
  }

  async function save(fd) {
    const personIds = [...people.filter(x => picked.has(String(x.id))).map(x => x.id), ...(picked.has('') ? [null] : [])];
    if (!personIds.length) throw new Error(t('pickPerson'));
    const billingIds = personIds.filter(id => id !== null);
    const [method, url] = e?.id ? ['PUT', `/api/prints/${e.id}`]
      : ['POST', pre.bambu_id ? `/api/bambu/prints/${pre.bambu_id}/bill` : '/api/prints'];
    await api(method, url, {
      person_ids: personIds,
      title: fd.get('title'),
      printed_at: fd.get('printed_at'),
      adjust_cents: toCents(fd.get('adjust')),
      adjust_note: fd.get('adjust_note'),
      wish_id: pre.wish_id,
      billing: Object.fromEntries(billingIds.map(id => [id, billingOf(id)])),
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
  // each person's part, in the order of the list, the owner's own last; it carries no adjustment
  const shares = [
    ...people.filter(x => picked.has(String(x.id))).map(x => ({ id: x.id, name: x.name, cents: part, state: billingOf(x.id) })),
    ...(picked.has('') ? [{ id: null, name: t('me'), cents: part - adjustPart, state: 'me' }] : []),
  ];
  const due = shares.reduce((sum, x) => sum + (x.state === 'billed' ? x.cents : 0), 0);
  return (
    <DialogForm title={t(e?.id ? 'editPrint' : 'newPrint')} onSubmit={save}>
      {sources.length > 0 && (
        <label>{t('copyFrom')}<Select options={sourceOptions} value={copy ?? ''} onChange={v => onCopy(+v || null)} /></label>
      )}
      <fieldset className="people">
        <legend>{t('forWhom')}</legend>
        {people.map(x => (
          <label key={x.id} className="check">
            <input type="checkbox" name="person" value={x.id} checked={picked.has(String(x.id))} onChange={() => toggle(String(x.id))} />{x.name}
          </label>
        ))}
        <label className="check"><input type="checkbox" name="person" value="" checked={picked.has('')} onChange={() => toggle('')} />{t('me')}</label>
        {failed && <p className="hint">{t('failedOwnerOnly')}</p>}
        {billed && shares.length > 0 && (
          <div className="shared">
            <div className="split" aria-hidden="true">{shares.map(x => <i key={x.id ?? 'me'} className={SHARE_CLASS[x.state]} />)}</div>
            <ul className="legend">
              {shares.map(x => (
                <li key={x.id ?? 'me'} className={SHARE_CLASS[x.state]}>
                  <span className="sw" aria-hidden="true" />
                  <span className="who">{x.name}</span>
                  {x.id === null
                    ? <small className="tag">{t('notBilledTag')}</small>
                    : <Segmented label={x.name} value={x.state} onChange={v => setBilling(now => ({ ...now, [x.id]: v }))}
                        options={[{ value: 'billed', label: t('billIt') }, { value: 'gifted', label: t('giftIt') }]} />}
                  <span className="amt">{eur(x.cents)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </fieldset>
      <div className="pair">
        <Field name="title" label={t('title')} defaultValue={p.title || ''} required maxLength={120} />
        <label>{t('date')}<DateInput name="printed_at" defaultValue={p.printed_at || today()} /></label>
      </div>
      <div>
        <p className="label">{t('filament')}</p>
        <div id="lines">
          {lines.map(l => (
            <LineRow key={l.key} line={l} options={options} hex={state.spools.find(s => String(s.id) === l.value)?.color_hex}
              onChange={change => setLine(l.key, change)}
              onRemove={lines.length > 1 ? () => setLines(now => now.filter(x => x.key !== l.key)) : null} />
          ))}
        </div>
        {spools.length > 0 && <div className="bar"><button type="button" className="ghost" onClick={() => setLines(now => [...now, newLine()])}>{t('addFilament')}</button></div>}
        {p.failed && <p className="hint">{t('failedHint')}</p>}
        {p.suggested && <p className="hint">{t('spoolSuggested')}</p>}
      </div>
      {billed && (
        <details id="billing" open={!!e?.adjust_cents}>
          <summary>{t('adjustment')}</summary>
          <Field name="adjust" label={t('adjust')} value={adjust} onChange={ev => setAdjust(ev.target.value)} inputMode="decimal" />
          <Field name="adjust_note" label={t('adjustNote')} defaultValue={e?.adjust_note || ''} maxLength={200} />
        </details>
      )}
      <div className="total" id="total">
        <p><span>{t('total')}</span><span>{eur(cents)}</span></p>
        {billed && <p className="due"><span>{t('toBill')}</span><span>{eur(due)}</span></p>}
      </div>
    </DialogForm>
  );
}

// How a part shows in the split bar and its legend (same as the print cards).
const SHARE_CLASS = { pending: 'pending', billed: 'billed', gifted: 'gift', me: 'me' };

// Two or three choices side by side, one of them on: a row of radio buttons drawn as one control.
function Segmented({ label, value, options, onChange }) {
  return (
    <span className="seg" role="radiogroup" aria-label={label}>
      {options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </span>
  );
}

// A filament used: the spool's colour, the spool, its grams, and a way out when there are several.
function LineRow({ line, options, hex, onChange, onRemove }) {
  return (
    <div className={`line${onRemove ? ' removable' : ''}`}>
      <i className="dot" style={{ '--c': hex || 'transparent' }} aria-hidden="true" />
      <Select name="spool" aria-label={t('filament')} options={options} value={line.value} onChange={value => onChange({ value })} />
      <span className="unit" data-unit="g">
        <input name="grams" type="number" inputMode="decimal" min="0.01" step="0.01" aria-label={t('grams')}
          value={line.grams} onChange={ev => onChange({ grams: ev.target.value })} required />
      </span>
      {onRemove && <button type="button" className="icon" onClick={onRemove} aria-label={t('delete')}>{icons.close}</button>}
    </div>
  );
}

// The owner's own prints: billed to nobody, their filament cost added up.
export const myPrintsDialog = () => openDialog(<MyPrints />);

function MyPrints() {
  const state = useStore(page).data;
  const groups = groupPrints(state.prints);
  const mine = state.prints.filter(isMine);
  const total = mine.reduce((sum, x) => sum + x.total_cents, 0);
  return (
    <DialogForm title={t('myPrints')}>
      <div className="total"><p><span>{t('filamentCost')}</span><span>{eur(total)}</span></p></div>
      {mine.length
        ? mine.map(x => <PrintGroupCard key={x.id} state={state} parts={groups.find(g => g.includes(x))} focus={x} />)
        : <p className="hint">{t('empty')}</p>}
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

// ---------- people, payments ----------

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
