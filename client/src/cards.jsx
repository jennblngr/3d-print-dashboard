import { t } from './i18n.js';
import { api, eur, fmtGrams, isLink, isMine, localDay, showDate, spoolName } from './lib.js';
import { refresh } from './store.js';
import { icons, remove, run } from './ui.jsx';
import { assignBambu, editPrint, recordWish, spoolDialog } from './dialogs.jsx';

export const Grid = ({ children }) => <div className="grid">{children}</div>;
const Dot = ({ hex }) => (hex ? <i className="dot" style={{ '--c': hex }} /> : null);

// ---------- prints ----------

// The colour of the filament a print line used, when it is known: sent with the line, or
// found on a spool still in stock that carries the same name.
const lineColor = (state, l) => l.color_hex || state.spools?.find(s => spoolName(s) === l.label)?.color_hex;

const printOwner = p => (isMine(p) ? `${t('me')} · ${t('notBilledTag')}` : p.person_name);
// The owner sees who shares a print; a guest only sees in how many parts it was split.
function printSharing(p) {
  if (p.share_count < 2) return '';
  if (!p.shared_with) return ` · ${t('sharedCount', { count: p.share_count })}`;
  return ` · ${t('sharedWith', { names: p.shared_with.map(name => name ?? t('me')).join(', ') })}`;
}

// A person's part of a print counts in what they owe only once the owner bills it.
const BILLING_CHIP = { pending: 'requested', billed: 'accepted', gifted: 'printed' };

function BillingButtons({ p }) {
  if (isMine(p)) return null;
  const set = (billing, label, cls = '') => (
    <button key={billing} className={cls} onClick={run(async () => {
      await api('PUT', `/api/prints/${p.id}/billing`, { billing });
      await refresh();
    })}>{t(label)}</button>
  );
  if (p.billing === 'pending') return <>{set('billed', 'billIt', 'primary')}{set('gifted', 'giftIt')}</>;
  return p.billing === 'billed' ? set('gifted', 'giftIt') : set('billed', 'billIt');
}

const Cover = ({ id, cls = 'thumb' }) => <img className={cls} src={`/api/bambu/prints/${id}/cover`} alt="" loading="lazy" />;

export function PrintCard({ state, p, admin }) {
  const del = run(() => remove(`/api/prints/${p.id}`, p.share_count > 1 ? 'confirmDeleteShared' : 'confirmDelete'));
  return (
    <article className="card col print">
      <div className="row">
        {admin && p.cover_id ? <Cover id={p.cover_id} /> : null}
        <div className="grow">
          <strong>{p.title}</strong>
          <small>{showDate(p.printed_at)}{admin ? ' · ' + printOwner(p) : ''}{printSharing(p)}</small>
        </div>
        <strong className="amount">{eur(p.total_cents)}</strong>
      </div>
      {!isMine(p) && <span className={`chip ${BILLING_CHIP[p.billing]}`}>{t('billing_' + p.billing)}</span>}
      <ul className="lines">
        {p.lines.map((l, i) => (
          <li key={i}><span><Dot hex={lineColor(state, l)} />{l.label} · {fmtGrams(l.grams)} g</span><span>{eur(l.cost_cents)}</span></li>
        ))}
        {p.adjust_cents ? <li className="adj"><span>{p.adjust_note || t('adjustment')}</span><span>{eur(p.adjust_cents)}</span></li> : null}
      </ul>
      {admin && (
        <div className="bar end">
          <BillingButtons p={p} />
          <button onClick={() => editPrint(p)}>{t('edit')}</button>
          <button className="danger" onClick={del}>{t('delete')}</button>
        </div>
      )}
    </article>
  );
}

// A shared print in one card: its filament summed over every part, then one row per person
// with their share and the choice to bill or gift it. A print that is not shared keeps its card.
export function PrintGroupCard({ state, parts }) {
  if (parts.length === 1) return <PrintCard state={state} p={parts[0]} admin />;
  const [first] = parts;
  const lines = new Map();
  for (const l of parts.flatMap(p => p.lines)) {
    const key = `${l.label}|${l.color_hex}`;
    const kept = lines.get(key) || { ...l, grams: 0, cost_cents: 0 };
    kept.grams += l.grams;
    kept.cost_cents += l.cost_cents;
    lines.set(key, kept);
  }
  const adjust = parts.reduce((sum, p) => sum + p.adjust_cents, 0);
  const del = run(() => remove(`/api/prints/${first.id}`, 'confirmDeleteShared'));
  return (
    <article className="card col print">
      <div className="row">
        {first.cover_id ? <Cover id={first.cover_id} /> : null}
        <div className="grow">
          <strong>{first.title}</strong>
          <small>{showDate(first.printed_at)} · {t('sharedCount', { count: parts.length })}</small>
        </div>
        <strong className="amount">{eur(parts.reduce((sum, p) => sum + p.total_cents, 0))}</strong>
      </div>
      <ul className="lines">
        {[...lines.values()].map((l, i) => (
          <li key={i}><span><Dot hex={lineColor(state, l)} />{l.label} · {fmtGrams(l.grams)} g</span><span>{eur(l.cost_cents)}</span></li>
        ))}
        {adjust ? <li className="adj"><span>{first.adjust_note || t('adjustment')}</span><span>{eur(adjust)}</span></li> : null}
      </ul>
      <ul className="lines parts">
        {parts.map(p => (
          <li key={p.id}>
            <span>{printOwner(p)}{!isMine(p) && <span className={`chip ${BILLING_CHIP[p.billing]}`}>{t('billing_' + p.billing)}</span>}</span>
            <span>{eur(p.total_cents)}</span>
            {!isMine(p) && <div className="bar"><BillingButtons p={p} /></div>}
          </li>
        ))}
      </ul>
      <div className="bar end">
        <button onClick={() => editPrint(first)}>{t('edit')}</button>
        <button className="danger" onClick={del}>{t('delete')}</button>
      </div>
    </article>
  );
}

// ---------- wishes ----------

export function WishCard({ w, admin }) {
  const title = isLink(w.url) ? <a href={w.url} target="_blank" rel="noopener noreferrer">{w.title}</a> : w.title;
  const set = (status, label, cls = '') => (
    <button key={status} className={cls} onClick={run(async () => {
      if (status === 'printed') return recordWish(w);
      await api('PUT', `/api/wishes/${w.id}`, { status });
      await refresh();
    })}>{t(label)}</button>
  );
  const buttons = [];
  if (admin) {
    if (w.status === 'requested') buttons.push(set('accepted', 'accept'), set('declined', 'decline'));
    if (w.status === 'requested' || w.status === 'accepted') buttons.push(set('printed', 'markPrinted', 'primary'));
    buttons.push(<button key="del" className="danger" onClick={run(() => remove(`/api/wishes/${w.id}`))}>{t('delete')}</button>);
  } else if (w.status === 'requested') {
    buttons.push(<button key="del" className="danger" onClick={run(() => remove(`/api/my/wishes/${w.id}`))}>{t('delete')}</button>);
  }
  const deciding = admin && (w.status === 'requested' || w.status === 'accepted');
  return (
    <article className="card col wish">
      <div className="row">
        <div className="grow"><strong>{title}</strong>{admin && <small>{w.person_name}</small>}</div>
        <span className={`chip ${w.status}`}>{t(w.status)}</span>
      </div>
      {w.note && <p className="note">{w.note}</p>}
      {buttons.length > 0 && <div className={`bar ${deciding ? 'choices' : 'end'}`}>{buttons}</div>}
    </article>
  );
}

// ---------- payments ----------

export const PaymentRow = ({ p, admin }) => (
  <li>
    <span>{showDate(p.paid_at)}{p.note ? ' · ' + p.note : ''}</span>
    <span>
      {eur(p.amount_cents)}
      {admin && <> <button className="link danger icon" onClick={run(() => remove(`/api/payments/${p.id}`))} aria-label={t('delete')}>{icons.close}</button></>}
    </span>
  </li>
);

// ---------- spools ----------

export function SpoolCard({ s }) {
  const pct = Math.max(0, Math.min(100, (s.remaining_g / s.weight_g) * 100));
  const name = [s.material, s.variant, s.color_name].filter(Boolean).join(' ');
  const low = !s.archived && pct < 25;
  const chip = s.archived ? <span className="chip">{t('finished')}</span>
    : s.remaining_g < 0 ? <span className="chip declined">{t('checkWeight')}</span>
    : s.sealed ? <span className="chip">{t('sealedChip')}</span>
    : null;
  return (
    <button type="button" className={`card spool ${s.archived ? 'faded' : low ? 'low' : ''}`} style={{ '--c': s.color_hex }} onClick={() => spoolDialog(s)}>
      <span className="swatch" aria-hidden="true" />
      <span className="grow">
        <small className="maker">{s.brand}</small>
        <strong>{name}</strong>
        <span className="meter"><i style={{ width: `${pct}%` }} /></span>
        <small><b className="qty">{Math.round(s.remaining_g)}</b> / {Math.round(s.weight_g)} g · {eur((s.price_cents / s.weight_g) * 1000)}/kg</small>
      </span>
      {chip}
    </button>
  );
}

// ---------- Bambu Lab ----------

// A print read from the Bambu Lab account, waiting for the owner to say what it was for.
export function BambuCard({ b }) {
  const planned = b.failed ? ` · ${t('plannedGrams', { grams: fmtGrams(b.planned_g, 1) })}` : '';
  const ignore = run(async () => {
    await api('POST', `/api/bambu/prints/${b.id}/ignore`);
    await refresh();
  });
  return (
    <article className={`card col todo ${b.failed ? 'failed' : ''}`}>
      <div className="row">
        {b.has_cover ? <Cover id={b.id} /> : null}
        <div className="grow">
          <strong>{b.title}</strong>
          <small>{showDate(localDay(b.ended_at))}{b.material ? <> · <Dot hex={b.color_hex} />{b.material}</> : null} · {fmtGrams(b.suggested_g, 1)} g{planned}</small>
        </div>
        {b.failed ? <span className="chip declined">{t('failedPrint')}</span> : null}
      </div>
      <div className="bar choices">
        <button className="primary" onClick={() => assignBambu(b)}>{t('bill')}</button>
        <button className="ghost" onClick={ignore}>{t('ignore')}</button>
      </div>
    </article>
  );
}

export function BambuRow({ state, b }) {
  const spool = state.spools.find(s => s.id === b.spool_id);
  const what = b.state === 'ignored' ? t('ignored') : `${fmtGrams(b.grams)} g${spool ? ' · ' + spoolName(spool) : ''}`;
  const putBack = run(async () => {
    await api('POST', `/api/bambu/prints/${b.id}/reset`);
    await refresh();
  });
  return (
    <li>
      <span>{b.has_cover ? <Cover id={b.id} cls="thumb sm" /> : null}{showDate(localDay(b.ended_at))} · {b.title} · {what}</span>
      <span><button className="link" onClick={putBack}>{t('putBack')}</button></span>
    </li>
  );
}

// "1 h 05" or "12 min"
const duration = min => (min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}` : `${min} min`);

// What the printer is doing right now.
export function LiveBlock({ busy }) {
  if (!busy?.length) return null;
  return (
    <>
      <h3>{t('printingNow')}</h3>
      <Grid>
        {busy.map((p, i) => {
          const details = [
            p.remaining_min != null && p.state !== 'PREPARE' ? t('timeLeft', { time: duration(p.remaining_min) }) : '',
            p.layers ? t('layerOf', { layer: p.layer ?? 0, layers: p.layers }) : '',
            p.error ? t('printerError', { code: `${p.error.slice(0, 4)}-${p.error.slice(4)}` }) : '',
          ].filter(Boolean).join(' · ');
          const chip = p.state === 'PAUSE' ? <span className="chip declined">{t('livePaused')}</span>
            : p.state === 'RUNNING' ? <span className="chip requested">{t('liveRunning')}</span>
            : <span className="chip">{t('livePreparing')}</span>;
          const pct = Math.max(0, Math.min(100, p.percent ?? 0));
          return (
            <article key={i} className="card col live">
              <div className="row">
                <div className="grow"><strong>{p.title || p.name}</strong><small>{p.name}{details ? ' · ' + details : ''}</small></div>
                {chip}
              </div>
              <span className="meter"><i style={{ width: `${pct}%` }} /></span>
              <small><b className="qty">{pct} %</b></small>
            </article>
          );
        })}
      </Grid>
    </>
  );
}
