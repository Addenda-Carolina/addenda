// SPDX-License-Identifier: GPL-3.0-or-later

interface BridgeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
type BridgeStorageSlot = BridgeStorage | null | undefined;
type BridgeAuthentication = 'authenticated' | 'logged-out' | 'unknown';
interface BridgeAttributeNode {
  getAttribute(name: string): string | null;
}
type BridgeDocument = {
  querySelector?: (selector: string) => unknown;
  querySelectorAll?: (selector: string) => ArrayLike<BridgeAttributeNode>;
  baseURI?: string;
} | null | undefined;
type BridgeEvidence = 'document' | 'restored';
interface BridgeSession {
  id: string;
  tid?: unknown;
}
interface BridgeSessionRecord extends BridgeSession {
  at: number;
}
interface BridgeRejectedRecord {
  id: string;
  at: number;
}
interface BridgeAttemptRecord extends BridgeRejectedRecord {
  replacedId?: string;
  destination?: string;
  count?: number;
}
interface BridgeDocumentFailure {
  app: 'sis' | 'webapps';
  address: string;
  id: string;
}
interface BridgeWebappsParts {
  id: string;
  rest: string;
}
interface BridgeStorageChange {
  key: string | null;
  storageArea: BridgeStorageSlot;
}
interface BridgeEventHost {
  location?: { href: string };
  addEventListener(type: 'storage', listener: (event: BridgeStorageChange) => void): void;
  removeEventListener(type: 'storage', listener: (event: BridgeStorageChange) => void): void;
}

// Keep sis-suite:* key names from 0.x so upgrading does not drop stored sessions.
const SESSION_BRIDGE_KEY = 'sis-suite:active-session:v1';
const SESSION_BRIDGE_REJECTED_KEY = 'sis-suite:rejected-sessions:v1';
const SESSION_BRIDGE_ATTEMPT_KEY = 'sis-suite:session-bridge-attempt:v1';
const SESSION_BRIDGE_MAX_AGE = 12 * 60 * 60 * 1000;
const SESSION_BRIDGE_REJECTED_MAX_AGE = 24 * 60 * 60 * 1000;
const SESSION_BRIDGE_ATTEMPT_MAX_AGE = 5 * 60 * 1000;
const SESSION_BRIDGE_REJECTED_LIMIT = 8;
const SESSION_BRIDGE_ATTEMPT_LIMIT = 8;
const WEBAPPS_SESSION_BRIDGE_KEY = 'sis-suite:webapps-active-session:v1';
const WEBAPPS_SESSION_BRIDGE_REJECTED_KEY = 'sis-suite:webapps-rejected-sessions:v1';
const WEBAPPS_SESSION_BRIDGE_ATTEMPT_KEY = 'sis-suite:webapps-session-bridge-attempt:v1';

function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value);
}

function sameSessionId(left: string | null | undefined, right: string | null | undefined): boolean {
  return validSessionId(left) && validSessionId(right) && left.toLowerCase() === right.toLowerCase();
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function normalizedPath(pathname: string): string {
  const collapsed = pathname
    .split('/')
    .map(decodePathSegment)
    .join('/')
    .replace(/\/{2,}/g, '/');
  try {
    return new URL(collapsed.startsWith('/') ? collapsed : '/' + collapsed, 'https://is.cuni.cz').pathname;
  } catch {
    return collapsed;
  }
}

function normalizedParamName(key: string): string {
  return key.trim().replace(/\[[\s\S]*$/, '').trim().toLowerCase();
}

function isModuleMenuKeyURL(url: URL, path: string): boolean {
  if (!/^\/studium\/(?:eng\/)?[^/]+\/index\.php$/i.test(path)) return false;
  let menuKeys = 0;
  let otherParam = false;
  url.searchParams.forEach((value, key) => {
    const trimmed = key.trim();
    if (trimmed === 'id' || trimmed === 'tid') return;
    if (trimmed === 'KEY' && /^\d+z\d+$/i.test(value.trim())) {
      menuKeys += 1;
      return;
    }
    otherParam = true;
  });
  return menuKeys === 1 && !otherParam;
}

function hasSsoParameter(url: URL): boolean {
  let found = false;
  url.searchParams.forEach((_value, key) => {
    if (key === 'sso' || key === 'sso_nia' || key.startsWith('sso?')) found = true;
  });
  return found;
}

function sisURL(value: unknown): URL | null {
  try {
    return new URL(String(value));
  } catch {
    return null;
  }
}

// State-changing SIS endpoints (do_*.php scripts, enrollment/deletion params, non-menu KEYs).
const SIS_ACTION_COMMAND = /^(?:zapsat|odepsat|prihlasit|odhlasit|smazat|zrusit|ulozit|odeslat)(?:_|$)/i;

function sisActionURL(url: URL): boolean {
  const path = normalizedPath(url.pathname);
  if (/\/do_[^/]*\.php(?:\/|$)/i.test(path)) return true;
  let action = false;
  url.searchParams.forEach((value, key) => {
    const name = normalizedParamName(key);
    if (
      name === 'delete'
      || name === 'action'
      || name === 'do' && SIS_ACTION_COMMAND.test(value.trim())
      || name === 'key' && !isModuleMenuKeyURL(url, path)
    ) {
      action = true;
    }
  });
  return action;
}

function canonicalCuniAliasURL(value: unknown): URL | null {
  const url = sisURL(value);
  if (!url || url.origin !== 'https://www.is.cuni.cz' || url.username || url.password) return null;
  const path = normalizedPath(url.pathname);
  if (!path.startsWith('/studium/') && !path.startsWith('/webapps/')) return null;
  if (sisActionURL(url)) return null;
  url.hostname = 'is.cuni.cz';
  return url;
}

function sisAuthenticationRoute(url: URL): boolean {
  if (/^\/studium\/(?:eng\/)?(?:login|logoff|verif|cookies)\.php(?:\/|$)/i.test(normalizedPath(url.pathname))) return true;
  if (hasSsoParameter(url)) return true;
  return ['ticket', 'accode', 'tstmp', 'SAMLart', 'SAMLResponse'].some(
    key => url.searchParams.has(key),
  );
}

type Admit = (value: unknown) => URL | null;

function sisDestinationURL(value: unknown): URL | null {
  const url = sisURL(value);
  if (!url || url.origin !== 'https://is.cuni.cz' || url.username || url.password) return null;
  const path = normalizedPath(url.pathname);
  if (!/^\/studium\/(?:eng\/)?/.test(path) || sisAuthenticationRoute(url)) return null;
  if (url.searchParams.getAll('id').length > 1 || url.searchParams.getAll('tid').length > 1) return null;
  // Root index.php only takes id/tid for the home view. Leave other query params alone.
  if (/^\/studium\/(?:eng\/)?(?:index\.php(?:\/.*)?)?$/i.test(path)) {
    let unknownAction = false;
    url.searchParams.forEach((_value, key) => {
      if (key !== 'id' && key !== 'tid') unknownAction = true;
    });
    if (unknownAction) return null;
  }
  return url;
}

function bridgeableSisURL(value: unknown): URL | null {
  const url = sisDestinationURL(value);
  return url && !sisActionURL(url) ? url : null;
}

// Clicked action links are eligible for one replay only if they carried the current page's session ID.
const OWN_ACTION_KEY = 'sis-login-fix:own-action:v1';
const OWN_ACTION_MAX_AGE = 5 * 60 * 1000;
const OWN_ACTION_LIMIT = 8;
interface OwnAction {
  destination: string;
  id: string;
}
interface StoredOwnAction extends OwnAction {
  at: number;
  pending?: StoredOwnAction[];
}

function ownActionClick(href: unknown, pageAddress: string): OwnAction | null {
  const url = sisDestinationURL(href);
  if (!url || !sisActionURL(url)) return null;
  const id = url.searchParams.get('id');
  if (!sameSessionId(id, sisURL(pageAddress)?.searchParams.get('id'))) return null;
  const destination = recoveryDestination(url.href, sisDestinationURL);
  return destination && validSessionId(id) ? { destination, id } : null;
}

function validOwnActionEntry(entry: unknown, now: number): entry is { destination: string; id: string; at: number } {
  if (!entry || typeof entry !== 'object') return false;
  const { destination, id, at } = entry as { destination?: unknown; id?: unknown; at?: unknown };
  return typeof destination === 'string' && validSessionId(id)
    && typeof at === 'number' && Number.isFinite(at)
    && now - at >= 0 && now - at <= OWN_ACTION_MAX_AGE;
}

function unpackOwnActions(record: unknown, now: number): Array<{ destination: string; id: string; at: number }> {
  if (Array.isArray(record)) return record.filter(item => validOwnActionEntry(item, now));
  if (!validOwnActionEntry(record, now)) return [];
  const rawPending = (record as StoredOwnAction).pending;
  const pending = Array.isArray(rawPending) ? rawPending.filter(item => validOwnActionEntry(item, now)) : [];
  return [{ destination: record.destination, id: record.id, at: record.at }, ...pending];
}

function packOwnActions(items: Array<{ destination: string; id: string; at: number }>): StoredOwnAction | null {
  if (!items.length) return null;
  const [head, ...rest] = items.slice(0, OWN_ACTION_LIMIT);
  return rest.length ? { ...head, pending: rest } : head;
}

function recordOwnAction(previous: unknown, click: OwnAction, now: number): StoredOwnAction {
  const kept = unpackOwnActions(previous, now).filter(
    item => !(item.destination === click.destination && sameSessionId(item.id, click.id)),
  );
  return packOwnActions([{ ...click, at: now }, ...kept])!;
}

function consumeOwnAction(previous: unknown, address: string, now: number): StoredOwnAction | null {
  const url = sisDestinationURL(address);
  const id = url?.searchParams.get('id');
  const destination = url && sisActionURL(url) ? recoveryDestination(url.href, sisDestinationURL) : null;
  const kept = unpackOwnActions(previous, now).filter(
    item => !(destination !== null && item.destination === destination && sameSessionId(item.id, id)),
  );
  return packOwnActions(kept);
}

function ownActionMatches(record: unknown, address: string, now: number): boolean {
  const url = sisDestinationURL(address);
  const id = url?.searchParams.get('id');
  if (!url || !sisActionURL(url) || !validSessionId(id)) return false;
  const destination = recoveryDestination(url.href, sisDestinationURL);
  if (!destination) return false;
  return unpackOwnActions(record, now).some(
    item => item.destination === destination && sameSessionId(item.id, id),
  );
}

function nativeUrls(doc: BridgeDocument, address: string, selector: string, attribute: string): URL[] {
  const result: URL[] = [];
  const nodes = doc?.querySelectorAll?.(selector);
  if (!nodes) return result;
  for (let n = 0; n < nodes.length; n += 1) {
    try {
      const raw = nodes[n].getAttribute(attribute);
      if (raw === null) continue;
      const url = new URL(raw, doc?.baseURI || address);
      if (url.origin === 'https://is.cuni.cz' && !url.username && !url.password) result.push(url);
    } catch {}
  }
  return result;
}

function nativeLinks(doc: BridgeDocument, address: string): URL[] {
  return nativeUrls(doc, address, 'a[href]', 'href');
}

function isLoginTarget(url: URL): boolean {
  const path = normalizedPath(url.pathname);
  return /^\/studium\/(?:eng\/)?login\.php$/i.test(path) && url.searchParams.has('ret')
    || /^\/studium\/(?:eng\/)?(?:[^/]+\/)?(?:index\.php)?$/i.test(path) && hasSsoParameter(url);
}

function authenticationState(doc: BridgeDocument, address = 'https://is.cuni.cz/studium/'): BridgeAuthentication {
  const links = nativeLinks(doc, address);
  const buttons = nativeUrls(doc, address, 'button[data-href]', 'data-href');
  const logout = links.filter(url => /^\/studium\/(?:eng\/)?logoff\.php$/i.test(normalizedPath(url.pathname)));
  const forms = doc?.querySelectorAll?.('form[action]');
  let login = !!doc?.querySelector?.('input[name="login"]');
  if (forms) {
    for (let n = 0; n < forms.length; n += 1) {
      try {
        const raw = forms[n].getAttribute('action');
        if (raw === null) continue;
        const url = new URL(raw, doc?.baseURI || address);
        if (url.origin === 'https://is.cuni.cz' && !url.username && !url.password
          && /^\/studium\/(?:eng\/)?(?:[^/]+\/)?verif\.php$/i.test(normalizedPath(url.pathname))) {
          login = true;
        }
      } catch {}
    }
  }
  login ||= links.some(isLoginTarget) || buttons.some(isLoginTarget);
  const pageId = sisURL(address)?.searchParams.get('id');
  const contradictoryId = logout.some(url => url.searchParams.getAll('id').length > 1
    || validSessionId(pageId) && url.searchParams.has('id') && !sameSessionId(url.searchParams.get('id'), pageId));
  if (logout.length && (login || contradictoryId)) return 'unknown';
  return logout.length ? 'authenticated' : login ? 'logged-out' : 'unknown';
}

// Slice raw url.search rather than re-serializing URLSearchParams so non-UTF-8 percent-escapes survive.
function nonSessionQuery(url: URL): string[] {
  return url.search ? url.search.slice(1).split('&').filter(component => {
    const fields = new URLSearchParams(component);
    return !fields.has('id') && !fields.has('tid');
  }) : [];
}

// SIS issues a new menu KEY with every login, so a KEY must not be paired with a different ID.
function withoutMenuKey(url: URL, query: string[]): string[] {
  if (!isModuleMenuKeyURL(url, normalizedPath(url.pathname))) return query;
  return query.filter(component => {
    let key = false;
    new URLSearchParams(component).forEach((_value, name) => {
      if (name.trim() === 'KEY') key = true;
    });
    return !key;
  });
}

function graftSession(
  value: unknown,
  session: BridgeSession | null | undefined,
  replaceExisting = false,
  admit: Admit = bridgeableSisURL,
): URL | null {
  const url = admit(value);
  if (!url || !validSessionId(session?.id)) return null;

  const existing = url.searchParams.get('id') || '';
  if (existing && !replaceExisting) return null;
  if (sameSessionId(existing, session.id) && String(url.searchParams.get('tid') ?? '') === String(session.tid ?? '')) {
    return null;
  }

  const original = sameSessionId(existing, session.id) ? nonSessionQuery(url) : withoutMenuKey(url, nonSessionQuery(url));
  const fields = new URLSearchParams();
  fields.append('id', session.id);
  fields.append('tid', typeof session.tid === 'string' ? session.tid : '');
  url.search = fields.toString() + (original.length ? '&' + original.join('&') : '');
  return url;
}

function webappsSessionParts(value: unknown): BridgeWebappsParts | null {
  const url = value instanceof URL ? value : sisURL(value);
  if (!url || url.origin !== 'https://is.cuni.cz') return null;
  const match = normalizedPath(url.pathname).match(/^\/webapps\/UKSESSION([a-f0-9]{32})(\/.*)?$/i);
  if (!match) return null;
  return { id: match[1], rest: match[2] || '/' };
}

function bridgeableWebappsURL(value: unknown): URL | null {
  const url = sisURL(value);
  if (!url || url.origin !== 'https://is.cuni.cz' || url.username || url.password) return null;
  const path = normalizedPath(url.pathname);
  if (!path.startsWith('/webapps/') || sisAuthenticationRoute(url) || sisActionURL(url)) return null;
  const parts = webappsSessionParts(url);
  if (/^\/webapps\/UKSESSION/i.test(path) && !parts) return null;
  const rest = parts ? parts.rest : path.slice('/webapps'.length) || '/';
  if (/^\/logout\/?$/i.test(rest)) return null;
  return url;
}

function webappsAuthenticationState(doc: BridgeDocument, address = 'https://is.cuni.cz/webapps/'): BridgeAuthentication {
  const links = nativeLinks(doc, address);
  const logout = links.filter(url => {
    const parts = webappsSessionParts(url);
    return parts && /^\/logout\/?$/i.test(parts.rest);
  });
  const login = links.some(url => url.pathname === '/webapps/' && url.searchParams.has('sso'));
  const pageId = webappsSessionParts(address)?.id;
  const contradictoryId = pageId && logout.some(url => webappsSessionParts(url)?.id.toLowerCase() !== pageId.toLowerCase());
  if (logout.length && (login || contradictoryId)) return 'unknown';
  return logout.length ? 'authenticated' : login ? 'logged-out' : 'unknown';
}

function recoveryDestination(address: string, admit: Admit = bridgeableSisURL): string | null {
  const sis = admit(address);
  if (sis) {
    const query = withoutMenuKey(sis, nonSessionQuery(sis));
    return sis.origin + sis.pathname + (query.length ? '?' + query.join('&') : '');
  }
  const web = bridgeableWebappsURL(address);
  if (!web) return null;
  const parts = webappsSessionParts(web);
  return web.origin + (parts ? '/webapps' + parts.rest : web.pathname) + web.search;
}

function graftWebappsSession(value: unknown, session: BridgeSession | null | undefined, replaceExisting = false): URL | null {
  const url = bridgeableWebappsURL(value);
  if (!url || !validSessionId(session?.id)) return null;

  const parts = webappsSessionParts(url);
  const existing = parts?.id || '';
  if (existing && !replaceExisting) return null;
  if (existing && existing.toLowerCase() === session.id.toLowerCase()) return null;

  const rest = parts ? parts.rest : url.pathname.slice('/webapps'.length) || '/';
  url.pathname = `/webapps/UKSESSION${session.id}${rest.startsWith('/') ? rest : `/${rest}`}`;
  return url;
}

class SessionBridge {
  private documentFailure: BridgeDocumentFailure | null = null;
  private ownAction: string | null = null;
  private readonly admitSis: Admit = value =>
    bridgeableSisURL(value) ?? (this.ownAction !== null && String(value) === this.ownAction ? sisDestinationURL(value) : null);
  readonly storage: BridgeStorageSlot;
  readonly tabStorage: BridgeStorageSlot;
  readonly replace: (href: string) => void;
  readonly now: () => number;
  stopWatching: (() => void) | null | undefined;

  constructor(
    storage: BridgeStorageSlot,
    tabStorage: BridgeStorageSlot,
    replace: (href: string) => void = href => location.replace(href),
    now = () => Date.now(),
  ) {
    this.storage = storage;
    this.tabStorage = tabStorage;
    this.replace = replace;
    this.now = now;
  }

  permitOwnAction(address: string): boolean {
    const url = sisDestinationURL(address);
    if (!url || !sisActionURL(url) || !ownActionMatches(this.ownActions(), address, this.now())) return false;
    this.ownAction = String(address);
    return true;
  }

  private ownActions(): unknown {
    try {
      return JSON.parse(this.storage?.getItem(OWN_ACTION_KEY) || 'null');
    } catch {
      return null;
    }
  }

  // Remove the click record before replaying it. Another tab admitted from the same
  // click, a record past its age limit or one cleared by a logout no longer matches.
  private claimOwnAction(address: string): boolean {
    const now = this.now();
    const record = this.ownActions();
    if (!this.storage || !ownActionMatches(record, address, now)) {
      this.ownAction = null;
      return false;
    }
    try {
      const remaining = consumeOwnAction(record, address, now);
      if (remaining) this.storage.setItem(OWN_ACTION_KEY, JSON.stringify(remaining));
      else this.storage.removeItem(OWN_ACTION_KEY);
    } catch {}
    this.ownAction = null;
    return !ownActionMatches(this.ownActions(), address, now);
  }

  clearOwnActions() {
    this.ownAction = null;
    try {
      this.storage?.removeItem(OWN_ACTION_KEY);
    } catch {}
  }

  read(): BridgeSessionRecord | null {
    try {
      const item = JSON.parse(this.storage?.getItem(SESSION_BRIDGE_KEY) || 'null') as BridgeSessionRecord | null;
      if (
        !item ||
        !validSessionId(item.id) ||
        !Number.isFinite(item.at) ||
        this.now() - item.at < 0 ||
        this.now() - item.at > SESSION_BRIDGE_MAX_AGE
      ) {
        if (item) this.clear();
        return null;
      }
      return item;
    } catch {
      return null;
    }
  }

  save(id: string, tid: unknown = ''): boolean {
    if (!validSessionId(id) || !this.storage) return false;
    try {
      const value = JSON.stringify({ id, tid: String(tid ?? ''), at: this.now() });
      this.storage.setItem(SESSION_BRIDGE_KEY, value);
      return this.storage.getItem(SESSION_BRIDGE_KEY) === value;
    } catch {
      return false;
    }
  }

  clear() {
    try {
      this.storage?.removeItem(SESSION_BRIDGE_KEY);
    } catch {}
  }

  readWebapps(): BridgeSessionRecord | null {
    try {
      const item = JSON.parse(this.storage?.getItem(WEBAPPS_SESSION_BRIDGE_KEY) || 'null') as BridgeSessionRecord | null;
      if (
        !item ||
        !validSessionId(item.id) ||
        !Number.isFinite(item.at) ||
        this.now() - item.at < 0 ||
        this.now() - item.at > SESSION_BRIDGE_MAX_AGE
      ) {
        if (item) this.clearWebapps();
        return null;
      }
      return item;
    } catch {
      return null;
    }
  }

  saveWebapps(id: string | null | undefined): boolean {
    if (!validSessionId(id)) return false;
    try {
      const value = JSON.stringify({ id, at: this.now() });
      this.storage?.setItem(WEBAPPS_SESSION_BRIDGE_KEY, value);
      return this.storage?.getItem(WEBAPPS_SESSION_BRIDGE_KEY) === value;
    } catch {
      return false;
    }
  }

  clearWebapps() {
    try {
      this.storage?.removeItem(WEBAPPS_SESSION_BRIDGE_KEY);
    } catch {}
  }

  webappsRejected(): BridgeRejectedRecord[] {
    try {
      const parsed = JSON.parse(this.storage?.getItem(WEBAPPS_SESSION_BRIDGE_REJECTED_KEY) || '[]') as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (item: BridgeRejectedRecord): item is BridgeRejectedRecord =>
          item &&
          validSessionId(item.id) &&
          Number.isFinite(item.at) &&
          this.now() - item.at >= 0 &&
          this.now() - item.at <= SESSION_BRIDGE_REJECTED_MAX_AGE,
      );
    } catch {
      return [];
    }
  }

  writeWebappsRejected(items: BridgeRejectedRecord[]): boolean {
    try {
      if (!items.length) this.storage?.removeItem(WEBAPPS_SESSION_BRIDGE_REJECTED_KEY);
      else this.storage?.setItem(WEBAPPS_SESSION_BRIDGE_REJECTED_KEY, JSON.stringify(items));
      return true;
    } catch {
      return false;
    }
  }

  rejectWebapps(id: string | null | undefined): boolean {
    if (!validSessionId(id)) return false;
    const active = this.readWebapps();
    if (active?.id.toLowerCase() === id.toLowerCase()) this.clearWebapps();
    const items = this.webappsRejected().filter(item => item.id.toLowerCase() !== id.toLowerCase());
    items.push({ id, at: this.now() });
    return this.writeWebappsRejected(items.slice(-SESSION_BRIDGE_REJECTED_LIMIT));
  }

  forgetWebappsRejected(id: string | null | undefined): boolean {
    if (!validSessionId(id)) return false;
    return this.writeWebappsRejected(
      this.webappsRejected().filter(item => item.id.toLowerCase() !== id.toLowerCase()),
    );
  }

  isWebappsRejected(id: string | null | undefined): boolean {
    return (
      validSessionId(id) &&
      this.webappsRejected().some(item => item.id.toLowerCase() === id.toLowerCase())
    );
  }

  clearWebappsRejected() {
    try {
      this.storage?.removeItem(WEBAPPS_SESSION_BRIDGE_REJECTED_KEY);
    } catch {}
  }

  attemptWebapps(id: string, replacedId = '', address?: string): boolean {
    try {
      if (!this.tabStorage || !validSessionId(id)) return false;
      const destination = address ? recoveryDestination(address, this.admitSis) : null;
      const previous = this.attemptedWebapps();
      const count = previous && Number.isSafeInteger(previous.count) && previous.count! > 0 ? previous.count! : previous ? 1 : 0;
      const value = JSON.stringify({
        id,
        replacedId: validSessionId(replacedId) ? replacedId : '',
        at: previous?.at ?? this.now(),
        count: count + 1,
        ...(destination !== null ? { destination } : {}),
      });
      this.tabStorage.setItem(WEBAPPS_SESSION_BRIDGE_ATTEMPT_KEY, value);
      return this.tabStorage.getItem(WEBAPPS_SESSION_BRIDGE_ATTEMPT_KEY) === value;
    } catch {
      return false;
    }
  }

  attemptedWebapps(): BridgeAttemptRecord | null {
    try {
      const item = JSON.parse(this.tabStorage?.getItem(WEBAPPS_SESSION_BRIDGE_ATTEMPT_KEY) || 'null') as BridgeAttemptRecord | null;
      if (
        !item ||
        !validSessionId(item.id) ||
        !Number.isFinite(item.at) ||
        this.now() - item.at < 0 ||
        this.now() - item.at > SESSION_BRIDGE_ATTEMPT_MAX_AGE
      ) {
        this.clearWebappsAttempt();
        return null;
      }
      return item;
    } catch {
      return null;
    }
  }

  clearWebappsAttempt() {
    try {
      this.tabStorage?.removeItem(WEBAPPS_SESSION_BRIDGE_ATTEMPT_KEY);
    } catch {}
  }

  resetWebapps() {
    if (this.documentFailure?.app === 'webapps') {
      this.stopWatching?.();
      this.documentFailure = null;
    }
    this.clearWebapps();
    this.clearWebappsRejected();
    this.clearWebappsAttempt();
  }

  rejected(): BridgeRejectedRecord[] {
    try {
      const parsed = JSON.parse(this.storage?.getItem(SESSION_BRIDGE_REJECTED_KEY) || '[]') as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (item: BridgeRejectedRecord): item is BridgeRejectedRecord =>
          item &&
          validSessionId(item.id) &&
          Number.isFinite(item.at) &&
          this.now() - item.at >= 0 &&
          this.now() - item.at <= SESSION_BRIDGE_REJECTED_MAX_AGE,
      );
    } catch {
      return [];
    }
  }

  writeRejected(items: BridgeRejectedRecord[]): boolean {
    try {
      if (!items.length) this.storage?.removeItem(SESSION_BRIDGE_REJECTED_KEY);
      else this.storage?.setItem(SESSION_BRIDGE_REJECTED_KEY, JSON.stringify(items));
      return true;
    } catch {
      return false;
    }
  }

  reject(id: string | null | undefined): boolean {
    if (!validSessionId(id)) return false;
    const active = this.read();
    if (sameSessionId(active?.id, id)) this.clear();
    const items = this.rejected().filter(item => !sameSessionId(item.id, id));
    items.push({ id, at: this.now() });
    return this.writeRejected(items.slice(-SESSION_BRIDGE_REJECTED_LIMIT));
  }

  forgetRejected(id: string | null | undefined): boolean {
    if (!validSessionId(id)) return false;
    return this.writeRejected(this.rejected().filter(item => !sameSessionId(item.id, id)));
  }

  isRejected(id: string | null | undefined): boolean {
    return validSessionId(id) && this.rejected().some(item => sameSessionId(item.id, id));
  }

  clearRejected() {
    try {
      this.storage?.removeItem(SESSION_BRIDGE_REJECTED_KEY);
    } catch {}
  }

  attempt(id: string, replacedId = '', address?: string): boolean {
    try {
      if (!this.tabStorage || !validSessionId(id)) return false;
      const destination = address ? recoveryDestination(address, this.admitSis) : null;
      const previous = this.attempted();
      const count = previous && Number.isSafeInteger(previous.count) && previous.count! > 0 ? previous.count! : previous ? 1 : 0;
      const value = JSON.stringify({
        id,
        replacedId: validSessionId(replacedId) ? replacedId : '',
        at: previous?.at ?? this.now(),
        count: count + 1,
        ...(destination !== null ? { destination } : {}),
      });
      this.tabStorage.setItem(SESSION_BRIDGE_ATTEMPT_KEY, value);
      return this.tabStorage.getItem(SESSION_BRIDGE_ATTEMPT_KEY) === value;
    } catch {
      return false;
    }
  }

  attempted(): BridgeAttemptRecord | null {
    try {
      const item = JSON.parse(this.tabStorage?.getItem(SESSION_BRIDGE_ATTEMPT_KEY) || 'null') as BridgeAttemptRecord | null;
      if (
        !item ||
        !validSessionId(item.id) ||
        !Number.isFinite(item.at) ||
        this.now() - item.at < 0 ||
        this.now() - item.at > SESSION_BRIDGE_ATTEMPT_MAX_AGE
      ) {
        this.clearAttempt();
        return null;
      }
      return item;
    } catch {
      return null;
    }
  }

  clearAttempt() {
    try {
      this.tabStorage?.removeItem(SESSION_BRIDGE_ATTEMPT_KEY);
    } catch {}
  }

  reset() {
    this.documentFailure = null;
    this.stopWatching?.();
    this.clear();
    this.clearRejected();
    this.clearAttempt();
    this.clearOwnActions();
    this.resetWebapps();
  }

  private rejectedHere(address: string, id: string, webapps: boolean): boolean {
    const failure = this.documentFailure;
    return !!failure && failure.app === (webapps ? 'webapps' : 'sis')
      && failure.address === address
      && sameSessionId(failure.id, id);
  }

  private alreadyAttempted(address: string, id: string, webapps: boolean): boolean {
    const attempt = webapps ? this.attemptedWebapps() : this.attempted();
    if (!attempt) return false;
    if (typeof attempt.count === 'number' && attempt.count >= SESSION_BRIDGE_ATTEMPT_LIMIT) return true;
    const destination = recoveryDestination(address, this.admitSis);
    if (typeof attempt.destination !== 'string' || attempt.destination !== destination) {
      return false;
    }
    return sameSessionId(attempt.id, id);
  }

  redirectWebapps(address: string): boolean {
    const url = bridgeableWebappsURL(address);
    const active = this.readWebapps();
    if (!url || !active || this.isWebappsRejected(active.id) || this.alreadyAttempted(address, active.id, true)) return false;

    const existing = webappsSessionParts(url)?.id || '';
    const replaceExisting =
      validSessionId(existing) &&
      !sameSessionId(existing, active.id) &&
      this.rejectedHere(address, existing, true);
    if (existing && !replaceExisting) return false;

    const target = graftWebappsSession(address, active, replaceExisting);
    if (!target || target.href === String(address)) return false;
    if (!this.attemptWebapps(active.id, replaceExisting ? existing : '', address)) return false;
    this.replace(target.href);
    return true;
  }

  // Before the DOM: fill in missing session IDs now. Replace an explicit ID only after reconcile() saw a logged-out page.
  redirect(address: string, enabled = true): boolean {
    if (!enabled) return false;
    if (bridgeableWebappsURL(address)) return this.redirectWebapps(address);
    const url = this.admitSis(address);
    const active = this.read();
    if (!url || !active || this.isRejected(active.id) || this.alreadyAttempted(address, active.id, false)) return false;

    const existing = url.searchParams.get('id') || '';
    const replaceExisting =
      validSessionId(existing) && !sameSessionId(existing, active.id)
      && this.rejectedHere(address, existing, false);
    if (existing && !replaceExisting) return false;

    const target = graftSession(address, active, replaceExisting, this.admitSis);
    if (!target || target.href === String(address)) return false;
    if (!bridgeableSisURL(address) && !this.claimOwnAction(address)) return false;
    if (!this.attempt(active.id, replaceExisting ? existing : '', address)) return false;
    this.replace(target.href);
    return true;
  }

  reconcileWebapps(doc: BridgeDocument, address: string, evidence: BridgeEvidence = 'document'): boolean {
    if (evidence === 'restored') return false;
    const url = sisURL(address);
    if (!url || url.origin !== 'https://is.cuni.cz' || url.username || url.password) return false;
    const path = normalizedPath(url.pathname);
    if (!path.startsWith('/webapps/')) return false;

    const parts = webappsSessionParts(url);
    const id = parts?.id || '';
    const rest = parts ? parts.rest : path.slice('/webapps'.length);
    if (/^\/logout\/?$/i.test(rest)) {
      this.resetWebapps();
      return false;
    }

    if (!bridgeableWebappsURL(address)) return false;
    const state = webappsAuthenticationState(doc, address);
    this.documentFailure = state === 'logged-out' ? { app: 'webapps', address, id } : null;
    if (state === 'authenticated' && validSessionId(id)) {
      this.forgetWebappsRejected(id);
      this.clearWebappsAttempt();
      this.saveWebapps(id);
      return false;
    }
    if (state !== 'logged-out') return false;

    const attempted = this.attemptedWebapps();
    if (validSessionId(id)) {
      this.rejectWebapps(id);
      if (attempted?.id.toLowerCase() === id.toLowerCase()) this.clearWebappsAttempt();
    }
    return validSessionId(id) ? this.redirectWebapps(address) : false;
  }

  watchForSession(doc: BridgeDocument, address: string, events: BridgeEventHost | null | undefined, enabled = true): void {
    this.stopWatching?.();
    if (!enabled || !events?.addEventListener || !events?.removeEventListener) return;
    const sis = this.admitSis(address);
    const web = !sis && bridgeableWebappsURL(address);
    if (!sis && !web) return;
    const id = sis ? sis.searchParams.get('id') || '' : webappsSessionParts(web)?.id;
    const state = () => sis ? authenticationState(doc, address) : webappsAuthenticationState(doc, address);
    const observedHere = this.documentFailure?.address === address
      && this.documentFailure.app === (sis ? 'sis' : 'webapps');
    const rejectedBefore = sis ? this.isRejected(id) : this.isWebappsRejected(id);
    if (state() !== 'logged-out' || (!observedHere && !rejectedBefore)) return;
    if (id && !validSessionId(id)) return;
    this.documentFailure = { app: sis ? 'sis' : 'webapps', address, id: id || '' };
    const key = sis ? SESSION_BRIDGE_KEY : WEBAPPS_SESSION_BRIDGE_KEY;
    let stopped = false;
    const stop = () => {
      stopped = true;
      events.removeEventListener('storage', changed);
      if (this.stopWatching === stop) this.stopWatching = null;
    };
    const recover = () => {
      if (stopped || state() !== 'logged-out') return;
      if (events.location && events.location.href !== String(address)) {
        stop();
        return;
      }
      if (this.redirect(address, true)) stop();
    };
    const changed = (event: BridgeStorageChange) => {
      if (event.storageArea === this.storage && event.key === key) {
        recover();
      }
    };
    this.stopWatching = stop;
    events.addEventListener('storage', changed);
    // Re-check in case another tab saved a session right before the listener attached.
    recover();
  }

  reconcile(doc: BridgeDocument, address: string, enabled = true, evidence: BridgeEvidence = 'document'): boolean {
    if (!enabled) {
      this.reset();
      return false;
    }

    // Ignore bfcache restores so navigating back cannot overwrite a newer session.
    if (evidence === 'restored') return false;
    const url = sisURL(address);
    if (!url || url.origin !== 'https://is.cuni.cz' || url.username || url.password) return false;
    const path = normalizedPath(url.pathname);
    if (path.startsWith('/webapps/')) return this.reconcileWebapps(doc, address, evidence);
    if (/^\/studium\/(?:eng\/)?logoff\.php$/i.test(path)) {
      this.reset();
      return false;
    }

    if (!this.admitSis(address)) return false;
    const id = url.searchParams.get('id') || '';
    const state = authenticationState(doc, address);
    this.documentFailure = state === 'logged-out' ? { app: 'sis', address, id } : null;
    if (state === 'authenticated' && validSessionId(id)) {
      this.forgetRejected(id);
      this.clearAttempt();
      this.save(id, url.searchParams.has('tid') ? url.searchParams.get('tid') : '');
      return false;
    }
    if (state !== 'logged-out') return false;

    const attempted = this.attempted();
    if (validSessionId(id)) {
      this.reject(id);
      if (sameSessionId(attempted?.id, id)) this.clearAttempt();
    }
    return validSessionId(id) ? this.redirect(address, true) : false;
  }
}

export {
  OWN_ACTION_KEY,
  SessionBridge,
  authenticationState,
  bridgeableSisURL,
  bridgeableWebappsURL,
  canonicalCuniAliasURL,
  consumeOwnAction,
  graftSession,
  graftWebappsSession,
  normalizedPath,
  ownActionClick,
  ownActionMatches,
  recordOwnAction,
  validSessionId,
  webappsAuthenticationState,
  webappsSessionParts,
};
export type { BridgeStorage };
