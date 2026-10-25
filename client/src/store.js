import { useSyncExternalStore } from 'react';
import { t } from './i18n.js';
import { api, guestToken } from './lib.js';

// A tiny store for values the whole interface reads, outside React so that actions and
// dialogs can update them from anywhere. `useStore(store)` re-renders on every change.
export function createStore(value) {
  const listeners = new Set();
  return {
    get: () => value,
    set(next) {
      value = typeof next === 'function' ? next(value) : next;
      listeners.forEach(fn => fn());
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
export const useStore = store => useSyncExternalStore(store.subscribe, store.get);

// What the page shows: 'loading', 'login', 'message' (a broken link, the server unreachable) or
// 'ready', with `data` from the server: the owner's whole state, or a guest's own page.
export const page = createStore({ status: 'loading', data: null, message: '' });
export const getState = () => page.get().data;

export async function refresh() {
  try {
    page.set({ status: 'ready', data: await api('GET', guestToken ? '/api/my' : '/api/state'), message: '' });
  } catch (e) {
    if (e.status !== 401) return page.set({ status: 'message', data: null, message: e.message });
    page.set(guestToken ? { status: 'message', data: null, message: t('badLink') } : { status: 'login', data: null, message: '' });
  }
}

export const setLive = live => page.set(p => ({ ...p, data: { ...p.data, bambu_live: live } }));
