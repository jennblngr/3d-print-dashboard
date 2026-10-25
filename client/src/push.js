// Notifications, on this device only.
import { t } from './i18n.js';
import { api } from './lib.js';
import { createStore } from './store.js';
import { toast } from './ui.jsx';

const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
// 'on', 'off', 'denied' (blocked in the browser settings) or 'unsupported'
export const push = createStore(pushSupported ? 'off' : 'unsupported');

async function pushSubscription() {
  if (!pushSupported) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) || null;
}

export async function checkPush() {
  if (!pushSupported) return;
  push.set(Notification.permission === 'denied' ? 'denied' : (await pushSubscription().catch(() => null)) ? 'on' : 'off');
}

const keyBytes = key => Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

// Forgets this device on the server and in the browser.
export async function pushUnsubscribe() {
  const sub = await pushSubscription().catch(() => null);
  if (!sub) return;
  await api('DELETE', '/api/push/subscriptions', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

export async function pushOn() {
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
}

export async function pushOff() {
  await pushUnsubscribe();
  await checkPush();
  toast(t('pushDisabled'));
}

export async function pushTest() {
  await api('POST', '/api/push/test');
  toast(t('pushSent'));
}
