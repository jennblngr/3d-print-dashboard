import { useEffect, useRef, useState } from 'react';
import { t, lang } from './i18n.js';
import { decodeTigerTag, colorFamily } from './tigertag.js';
import { api, currentTheme, eur, groupPrints, isMine, setTheme, THEME_KEYS, toDecide } from './lib.js';
import { getState, refresh, useStore } from './store.js';
import { ask, Empty, icons, Logo, remove, run, toast } from './ui.jsx';
import { push, pushOff, pushOn, pushTest, pushUnsubscribe } from './push.js';
import { BambuCard, BambuRow, Grid, LiveBlock, PaymentRow, PrintGroupCard, SpoolCard, WishCard } from './cards.jsx';
import {
  adminWishDialog, assignBambu, bambuConnectDialog, handleTag, myPrintsDialog, newPrint, paymentDialog, personDialog,
  scanDialog, spoolDialog,
} from './dialogs.jsx';

const TABS = ['spools', 'prints', 'people', 'wishes'];

// The owner's area. All four panels are drawn: a phone shows the open one, a computer shows
// the others folded.
export function Admin({ state }) {
  const [tab, setTab] = useState(() => (TABS.includes(sessionStorage.getItem('tab')) ? sessionStorage.getItem('tab') : 'spools'));
  const tabNow = useRef(tab);
  // set when the owner switches tabs, so that only a switch animates (see "animations" in style.css)
  const [switching, setSwitching] = useState(false);
  const [theme, setThemeNow] = useState(currentTheme);

  function goTab(id) {
    tabNow.current = id;
    setTab(id);
    sessionStorage.setItem('tab', id);
    setSwitching(true);
    scrollTo(0, 0);
  }

  // What the app is opened for, after "#":
  // - "bambu=<id>": a notification about a print that just ended, to assign it;
  // - "tigertag=<chip>": the Android companion app read a TigerTag chip (a browser cannot), and
  //   passes its memory. The fragment never leaves the phone: browsers do not send it.
  function takeHash() {
    const bambu = /^#bambu(?:=(\d+))?$/.exec(location.hash);
    if (bambu) {
      history.replaceState(null, '', location.pathname);
      if (tabNow.current !== 'prints') goTab('prints');
      if (!bambu[1]) return;
      const b = getState().bambu_prints.find(x => x.id === +bambu[1]);
      return b?.state === 'pending' ? assignBambu(b) : toast(t('alreadyAssigned'));
    }
    const match = /^#tigertag=(.+)$/.exec(location.hash);
    if (!match) return;
    history.replaceState(null, '', location.pathname);
    try {
      const { code, ...details } = decodeTigerTag(decodeURIComponent(match[1]));
      details.color_name = t('color_' + colorFamily(details.color_hex));
      if (tabNow.current !== 'spools') goTab('spools');
      handleTag(code, details);
    } catch (e) {
      toast(t(e.reason === 'blank' ? 'tagBlank' : 'tagInvalid'));
    }
  }

  // a page redrawn after a save does not move
  useEffect(() => setSwitching(false), [state]);
  useEffect(() => {
    takeHash();
  }, [state]);
  useEffect(() => {
    const onHash = () => takeHash();
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  const counts = {
    prints: state.bambu_prints.filter(b => b.state === 'pending').length + groupPrints(state.prints).filter(g => g.some(toDecide)).length,
    wishes: state.wishes.filter(w => w.status === 'requested').length,
  };
  const badge = k => (counts[k] ? <b className="badge">{counts[k]}</b> : null);
  // auto, then light, then dark, then back to auto
  const nextTheme = () => {
    const next = { '': 'light', light: 'dark', dark: '' }[currentTheme()];
    setTheme(next);
    setThemeNow(next);
  };
  const logout = run(async () => {
    // a device signed out of no longer gets the owner's notifications
    await pushUnsubscribe();
    await api('POST', '/api/logout');
    await refresh();
  });
  const backup = state.last_backup ? t('lastBackup', { date: new Date(state.last_backup).toLocaleString(lang) }) : t('noBackup');
  const views = { spools: SpoolsView, prints: PrintsView, people: PeopleView, wishes: WishesView };

  return (
    <div className="shell">
      <nav className="slide" style={{ '--i': TABS.indexOf(tab) }} aria-label={t('sections')}>
        {TABS.map(k => (
          <button key={k} className={k === tab ? 'on' : undefined} aria-current={k === tab ? 'page' : undefined} onClick={() => goTab(k)}>
            <span className="ico">{icons[k]}{badge(k)}</span><span>{t(k)}</span>
          </button>
        ))}
      </nav>
      <div className="page">
        <div className="topbar">
          <p className="appname"><Logo />{t('appName')}</p>
          <p className="sync">{backup}</p>
          <button className="link icon" onClick={nextTheme} aria-label={t('themeNow', { name: t(THEME_KEYS[theme]) })}>{icons[THEME_KEYS[theme]]}</button>
          <button className="link icon" onClick={logout} aria-label={t('logout')} title={t('logout')}>{icons.logout}</button>
        </div>
        <main className={`dash${switching ? ' switching' : ''}`}>
          {TABS.map(k => {
            const { head = null, body } = views[k](state);
            return (
              <section key={k} className={`panel ${k === tab ? 'open' : 'closed'}`} aria-label={t(k)}>
                <button type="button" className="strip" aria-expanded="false" onClick={() => goTab(k)}>{icons[k]}{badge(k)}<span className="vlabel">{t(k)}</span></button>
                <div className="panel-head"><h2>{t(k)}</h2>{badge(k)}{head}</div>
                <div className="panel-body">{body}</div>
              </section>
            );
          })}
        </main>
        <footer>{backup}</footer>
      </div>
    </div>
  );
}

// Each tab is a panel: the buttons next to its title (`head`) and its content (`body`).

function SpoolsView(state) {
  return {
    head: <>
      <button className="primary" onClick={scanDialog}>{icons.scan}{t('scanBarcode')}</button>
      <button onClick={() => spoolDialog()}>{icons.plus}{t('add')}</button>
    </>,
    body: state.spools.length ? <Grid>{state.spools.map(s => <SpoolCard key={s.id} s={s} />)}</Grid> : <Empty kind="spools" />,
  };
}

function PrintsView(state) {
  const pending = state.bambu_prints.filter(b => b.state === 'pending');
  const handled = state.bambu_prints.filter(b => b.state !== 'pending');
  // a shared print waits to be decided as long as one of its parts does
  const groups = groupPrints(state.prints);
  const undecided = groups.filter(g => g.some(toDecide));
  const decided = groups.filter(g => !g.some(toDecide));
  const cards = groups => <Grid>{groups.map(g => <PrintGroupCard key={g[0].id} state={state} parts={g} />)}</Grid>;
  return {
    head: <button className="primary" onClick={newPrint}>{icons.plus}{t('newPrint')}</button>,
    body: (
      <div className="cols">
        <div>
          <div id="live"><LiveBlock busy={state.bambu_live} /></div>
          {pending.length > 0 && <><h3>{t('toAssign')}</h3><Grid>{pending.map(b => <BambuCard key={b.id} b={b} />)}</Grid></>}
          {undecided.length > 0 && <><h3>{t('toDecide')}</h3>{cards(undecided)}</>}
          {(pending.length > 0 || undecided.length > 0) && <h3>{t('prints')}</h3>}
          {decided.length ? cards(decided) : <Empty kind="prints" />}
          {handled.length > 0 && (
            <details>
              <summary>{t('notBilled', { count: handled.length })}</summary>
              <article className="card col"><ul className="lines">{handled.map(b => <BambuRow key={b.id} state={state} b={b} />)}</ul></article>
            </details>
          )}
        </div>
        <aside><BambuPanel state={state} /></aside>
      </div>
    ),
  };
}

function BambuPanel({ state }) {
  const b = state.bambu;
  const broken = b.connected && b.error && b.error !== 'unreachable';
  const status = !b.connected ? t('bambuOff')
    : broken ? t('bambuExpired')
    : b.error ? t('bambuUnreachable')
    : b.last_sync ? t('bambuOn', { date: new Date(b.last_sync).toLocaleString(lang) })
    : t('bambuNever');
  const sync = run(async () => {
    await api('POST', '/api/bambu/sync');
    await refresh();
    toast(t('bambuChecked'));
  });
  const disconnect = run(async () => {
    if (!(await ask(t('confirmBambuDisconnect'), t('bambuDisconnect')))) return;
    await api('DELETE', '/api/bambu');
    await refresh();
  });
  return (
    <>
      <h3>{t('bambuTitle')}</h3>
      <article className="card col bambu">
        <p className="note"><span className={`status ${b.connected && !b.error ? '' : 'off'}`} aria-hidden="true" /><span>{status}</span></p>
        {b.connected && !broken && (
          <p className="note"><span className={`status ${b.live === 'on' ? '' : 'off'}`} aria-hidden="true" /><span>{t('live_' + (b.live || 'off'))}</span></p>
        )}
        <div className="bar">
          {!b.connected || broken
            ? <button className="primary" onClick={bambuConnectDialog}>{t('bambuConnect')}</button>
            : <button onClick={sync}>{icons.refresh}{t('bambuSync')}</button>}
          {b.connected && <button className="danger" onClick={disconnect}>{t('bambuDisconnect')}</button>}
        </div>
      </article>
      {b.connected && <><h3>{t('notifications')}</h3><article className="card col bambu"><PushBlock /></article></>}
    </>
  );
}

function PushBlock() {
  const state = useStore(push);
  if (state === 'on') {
    return <>
      <p className="note"><span className="status" aria-hidden="true" /><span>{t('pushOn')}</span></p>
      <div className="bar">
        <button onClick={run(pushTest)}>{icons.bell}{t('pushTest')}</button>
        <button className="danger" onClick={run(pushOff)}>{t('pushDisable')}</button>
      </div>
    </>;
  }
  if (state === 'off') {
    return <>
      <p className="hint">{t('pushHint')}</p>
      <div className="bar"><button className="primary" onClick={run(pushOn)}>{icons.bell}{t('pushEnable')}</button></div>
    </>;
  }
  return <p className="hint">{t(state === 'denied' ? 'pushDenied' : 'pushUnsupported')}</p>;
}

function PeopleView(state) {
  const mine = state.prints.filter(isMine);
  return {
    head: <button className="primary" onClick={() => personDialog()}>{icons.plus}{t('add')}</button>,
    body: <>
      <button type="button" className="card me" onClick={myPrintsDialog}>
        <span className="grow"><strong>{t('me')}</strong><small>{t('printCount', { count: mine.length })} · {t('notBilledTag')}</small></span>
        <strong className="amount">{eur(mine.reduce((sum, p) => sum + p.total_cents, 0))}</strong>
      </button>
      {state.people.length ? <Grid>{state.people.map(p => <PersonCard key={p.id} state={state} p={p} />)}</Grid> : <Empty kind="people" />}
    </>,
  };
}

function PersonCard({ state, p }) {
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
  const invite = run(async () => {
    const url = `${location.origin}/g/${p.token}`;
    if (navigator.share) {
      try {
        return await navigator.share({ title: t('appName'), url });
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    await navigator.clipboard.writeText(url);
    toast(t('linkCopied'));
  });
  const newLink = run(async () => {
    if (!(await ask(t('confirmNewLink'), t('newLink')))) return;
    await api('POST', `/api/people/${p.id}/token`);
    await refresh();
  });
  return (
    <article className="card col person">
      <div className="row">
        <span className="grow"><strong>{p.name}</strong>{notes && <small>{notes}</small>}</span>
        <span className={`chip ${b > 0 ? 'declined' : 'printed'}`}>{label}</span>
      </div>
      <div className="bar">
        <button onClick={invite}>{icons.link}{t('inviteLink')}</button>
        <button onClick={() => paymentDialog(p)}>{icons.pay}{t('addPayment')}</button>
      </div>
      <details>
        <summary>{t('more')}</summary>
        {pays.length > 0 && <ul className="lines">{pays.map(x => <PaymentRow key={x.id} p={x} admin />)}</ul>}
        <div className="bar">
          <button onClick={() => personDialog(p)}>{t('rename')}</button>
          <button onClick={newLink}>{t('newLink')}</button>
          <button className="danger" onClick={run(() => remove(`/api/people/${p.id}`, 'confirmDeletePerson'))}>{t('deletePerson')}</button>
        </div>
      </details>
    </article>
  );
}

function WishesView(state) {
  const order = ['requested', 'accepted', 'printed', 'declined'];
  const sorted = [...state.wishes].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  return {
    head: state.people.length ? <button className="primary" onClick={adminWishDialog}>{icons.plus}{t('add')}</button> : null,
    body: sorted.length ? <Grid>{sorted.map(w => <WishCard key={w.id} w={w} admin />)}</Grid> : <Empty kind="wishes" />,
  };
}
