import { useEffect, useState } from 'react';
import { t } from './i18n.js';
import { api, eur, guestToken } from './lib.js';
import { getState, page, refresh, setLive, useStore } from './store.js';
import { Empty, icons, Logo, Overlays } from './ui.jsx';
import { PaymentRow, PrintCard, WishCard } from './cards.jsx';
import { wishDialog } from './dialogs.jsx';
import { Admin } from './Admin.jsx';

export function App() {
  const { status, data, message } = useStore(page);
  useEffect(() => {
    refresh();
  }, []);
  useLiveStatus(status === 'ready' && !guestToken);

  // Pages without the tabs (sign-in, messages, a guest's page) are "bare".
  let content = null;
  if (status === 'login') content = <Login />;
  else if (status === 'message') content = <Message text={message} />;
  else if (status === 'ready') content = guestToken ? <Guest state={data} /> : <Admin state={data} />;
  return (
    <>
      <div className={status === 'ready' && !guestToken ? 'app' : 'app guest'}>{content}</div>
      <Overlays />
    </>
  );
}

// While the owner has the app in front of them, the live status follows the printer, and a
// print that just ended shows up without reloading.
function useLiveStatus(on) {
  useEffect(() => {
    if (!on) return;
    async function poll() {
      const state = getState();
      if (!state?.bambu?.connected || document.visibilityState !== 'visible') return;
      let data;
      try {
        data = await api('GET', '/api/bambu/live');
      } catch {
        return;
      }
      if (data.pending !== getState().bambu_prints.filter(b => b.state === 'pending').length) return refresh();
      if (JSON.stringify(data.live) !== JSON.stringify(getState().bambu_live)) setLive(data.live);
    }
    const timer = setInterval(poll, 20_000);
    document.addEventListener('visibilitychange', poll);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [on]);
}

function Login() {
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    try {
      await api('POST', '/api/login', { password: e.currentTarget.password.value });
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <main className="login">
      <form onSubmit={submit}>
        <Logo />
        <h1>{t('appName')}</h1>
        <label>{t('password')}<input name="password" type="password" autoComplete="current-password" required autoFocus /></label>
        <p className="err" hidden={!error}>{error}</p>
        <button className="primary">{t('login')}</button>
      </form>
    </main>
  );
}

const Message = ({ text }) => (
  <main className="login"><div className="empty">{icons.brokenLink}<p>{text}</p></div></main>
);

// A guest's own page: what they owe, their prints and payments, their wishes.
function Guest({ state }) {
  const b = state.balance_cents;
  return (
    <div className="shell">
      <div className="page">
        <header><h1>{t('hello', { name: state.person.name })}</h1></header>
        <main>
          <section className={`balance ${b > 0 ? 'due' : ''}`}>
            <small>{b > 0 ? t('youOwe') : b < 0 ? t('yourCredit') : t('allSettled')}</small>
            <strong>{eur(Math.abs(b))}</strong>
          </section>
          <div className="cols">
            <div>
              <h2>{t('wishes')}</h2>
              <div className="bar"><button className="primary" onClick={wishDialog}>{icons.plus}{t('newWish')}</button></div>
              {state.wishes.length ? state.wishes.map(w => <WishCard key={w.id} w={w} admin={false} />) : <Empty kind="wishes" small />}
            </div>
            <div>
              <h2>{t('prints')}</h2>
              {state.prints.length ? state.prints.map(p => <PrintCard key={p.id} state={state} p={p} admin={false} />) : <Empty kind="prints" small />}
              {state.payments.length > 0 && <>
                <h2>{t('payments')}</h2>
                <article className="card col"><ul className="lines">{state.payments.map(p => <PaymentRow key={p.id} p={p} admin={false} />)}</ul></article>
              </>}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
