// SPDX-License-Identifier: GPL-3.0-or-later
import {
  OWN_ACTION_KEY,
  SessionBridge,
  authenticationState,
  canonicalCuniAliasURL,
  normalizedPath,
  ownActionClick,
  recordOwnAction,
  type BridgeStorage,
} from './session';
import { startOtpFix } from './otp';

export interface Features {
  session: boolean;
  otp: boolean;
}

export function writableStorage(storage: BridgeStorage): boolean {
  const key = 'sis-login-fix:storage-probe:v1';
  try {
    const previous = storage.getItem(key);
    storage.setItem(key, 'probe');
    const writable = storage.getItem(key) === 'probe';
    if (previous === null) storage.removeItem(key);
    else storage.setItem(key, previous);
    return writable;
  } catch {
    return false;
  }
}

const ALIAS_MOVE_KEY = 'sis-login-fix:alias-move:v1';
const ALIAS_MOVE_WINDOW = 10 * 1000;
const ALIAS_MOVE_LIMIT = 3;

export function aliasMoveAllowed(storage: BridgeStorage, now: number): boolean {
  try {
    const item = JSON.parse(storage.getItem(ALIAS_MOVE_KEY) || 'null') as { at?: unknown; count?: unknown } | null;
    const recent = item && typeof item.at === 'number' && Number.isSafeInteger(item.count)
      && now - item.at >= 0 && now - item.at <= ALIAS_MOVE_WINDOW
      ? { at: item.at, count: item.count as number }
      : null;
    if (recent && recent.count >= ALIAS_MOVE_LIMIT) return false;
    storage.setItem(ALIAS_MOVE_KEY, JSON.stringify({ at: recent?.at ?? now, count: (recent?.count ?? 0) + 1 }));
  } catch {}
  return true;
}

function clickedAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  const node = target as { closest?: (selector: string) => unknown; parentElement?: Element | null } | null;
  if (typeof node?.closest === 'function') return node.closest('a[href]') as HTMLAnchorElement | null;
  return (node?.parentElement?.closest?.('a[href]') ?? null) as HTMLAnchorElement | null;
}

export function startLoginFix(
  version: string,
  features: Features = { session: true, otp: true },
): () => void {
  if (window.top !== window) return () => {};
  let url: URL;
  try {
    url = new URL(location.href);
  } catch {
    return () => {};
  }
  const path = normalizedPath(url.pathname);
  if (url.origin === 'https://cas.cuni.cz' && path.startsWith('/cas/')) {
    return features.otp ? startOtpFix(version) : () => {};
  }
  if (!features.session) return () => {};
  if ((url.origin !== 'https://is.cuni.cz' && url.origin !== 'https://www.is.cuni.cz')
      || (!path.startsWith('/studium/') && !path.startsWith('/webapps/'))) {
    return () => {};
  }

  let stop = () => {};
  try {
    const canonical = canonicalCuniAliasURL(location.href);
    if (canonical) {
      let tabStorage: BridgeStorage | null = null;
      try { tabStorage = window.sessionStorage; } catch {}
      if (!tabStorage || aliasMoveAllowed(tabStorage, Date.now())) location.replace(canonical.href);
      return stop;
    }
    if (url.origin !== 'https://is.cuni.cz') return stop;

    let persistent: BridgeStorage;
    let perTab: BridgeStorage;
    try {
      persistent = window.localStorage;
      perTab = window.sessionStorage;
    } catch {
      return stop;
    }
    if (!writableStorage(persistent) || !writableStorage(perTab)) return stop;

    const isSis = path.startsWith('/studium/');
    const bridge = new SessionBridge(persistent, perTab, href => location.replace(href), Date.now);

    if (isSis) bridge.permitOwnAction(location.href);
    if (bridge.redirect(location.href)) return stop;

    const controller = new AbortController();
    if (isSis) {
      // Record user-initiated SIS action links so they can replay once if the session just expired.
      const remember = (event: Event): void => {
        try {
          const anchor = clickedAnchor(event.target);
          const button = (event as MouseEvent).button;
          if (!anchor || (typeof button === 'number' && button > 1)) return;
          const rawHref = typeof anchor.href === 'string' && anchor.href ? anchor.href : anchor.getAttribute?.('href');
          if (!rawHref) return;
          const click = ownActionClick(new URL(rawHref, location.href).href, location.href);
          if (!click || authenticationState(document, location.href) !== 'authenticated') return;
          const now = Date.now();
          let previous: unknown = null;
          try { previous = JSON.parse(persistent.getItem(OWN_ACTION_KEY) || 'null'); } catch {}
          persistent.setItem(OWN_ACTION_KEY, JSON.stringify(recordOwnAction(previous, click, now)));
        } catch {}
      };
      for (const type of ['click', 'auxclick']) {
        document.addEventListener(type, remember, { capture: true, signal: controller.signal });
      }
    }

    const reconcile = (restored = false): void => {
      try {
        document.documentElement.dataset.sisLoginFixVersion = version;
        if (!bridge.reconcile(document, location.href, true, restored ? 'restored' : 'document')) {
          bridge.watchForSession(document, location.href, window);
        }
      } catch {}
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => reconcile(), {
        once: true,
        signal: controller.signal,
      });
    } else {
      reconcile();
    }
    window.addEventListener('pageshow', event => {
      if (event.persisted) reconcile(true);
    }, { signal: controller.signal });
    window.addEventListener('pagehide', () => {
      bridge.stopWatching?.();
    }, { signal: controller.signal });
    stop = () => {
      controller.abort();
      bridge.stopWatching?.();
    };
  } catch {}
  return stop;
}
