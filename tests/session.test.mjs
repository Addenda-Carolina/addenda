import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SessionBridge,
  bridgeableSisURL,
  bridgeableWebappsURL,
  canonicalCuniAliasURL,
  graftSession,
} from '../.test/session.mjs';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const origin = 'https://is.cuni.cz';

const loggedIn = {
  querySelector: selector => selector === 'a[href*="logoff.php"]'
    ? { getAttribute: name => name === 'href' ? '/studium/logoff.php' : null }
    : null,
  querySelectorAll: selector => selector === 'a[href]'
    ? [{ getAttribute: name => name === 'href' ? '/studium/logoff.php' : null }]
    : [],
};

class MemoryStorage {
  data = new Map();
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { this.data.set(key, value); }
  removeItem(key) { this.data.delete(key); }
}

test('URL parsing and session grafting do not depend on URLSearchParams iterators', () => {
  const keys = URLSearchParams.prototype.keys;
  const entries = URLSearchParams.prototype.entries;
  URLSearchParams.prototype.keys = () => ({ next() { throw Error('unusable iterator'); } });
  URLSearchParams.prototype.entries = () => ({ next() { throw Error('unusable iterator'); } });
  try {
    assert.ok(bridgeableSisURL(`${origin}/studium/index.php?id=${A}`));
    assert.equal(bridgeableSisURL(`${origin}/studium/index.php?unknown=1`), null);
    const url = graftSession(`${origin}/studium/predmety/index.php?x=1&x=2#target`, { id: B });
    assert.deepEqual(url.searchParams.getAll('x'), ['1', '2']);
    assert.equal(url.hash, '#target');
  } finally {
    URLSearchParams.prototype.keys = keys;
    URLSearchParams.prototype.entries = entries;
  }
});

test('a newer authenticated SIS page replaces the stored session', () => {
  const store = new MemoryStorage();
  const bridge = new SessionBridge(store, new MemoryStorage(), () => {});
  bridge.reconcile(loggedIn, `${origin}/studium/predmety/index.php?id=${A}`);
  bridge.reconcile(loggedIn, `${origin}/studium/index.php?id=${B}`);
  assert.equal(bridge.read().id, B);
});

test('explicit SIS authentication paths stay native', () => {
  for (const path of ['/studium/index.php?sso', '/studium/login.php', '/studium/index.php?ticket=x', '/studium/eng/logoff.php']) {
    assert.equal(bridgeableSisURL(origin + path), null);
  }
});

test('Moodle URLs are never bridged', () => {
  for (const fn of [bridgeableSisURL, bridgeableWebappsURL]) {
    assert.equal(fn('https://dl1.cuni.cz/login/index.php'), null);
  }
});

test('save returns false if storage drops the write', () => {
  const broken = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const bridge = new SessionBridge(broken, new MemoryStorage(), () => {});
  assert.equal(bridge.save(A), false);
  assert.equal(bridge.saveWebapps(A), false);
});

test('malformed WebApps tokens and authentication callbacks are ignored', () => {
  for (const url of [
    `${origin}/webapps/UKSESSIONnot-a-session/x`,
    `${origin}/webapps/?sso`,
    `${origin}/webapps/?ticket=synthetic`,
    'https://u:p@is.cuni.cz/webapps/',
  ]) {
    assert.equal(bridgeableWebappsURL(url), null);
  }
});

test('alias canonicalization skips URLs containing credentials', () => {
  assert.equal(canonicalCuniAliasURL('https://user:password@www.is.cuni.cz/studium/index.php'), null);
});

test('unknown SIS authentication state leaves storage and location untouched', () => {
  const shared = new MemoryStorage();
  const redirects = [];
  const bridge = new SessionBridge(shared, new MemoryStorage(), href => redirects.push(href));
  const unknown = { querySelector: () => null };
  assert.equal(bridge.reconcile(unknown, `${origin}/studium/index.php?id=${A}`), false);
  assert.equal(bridge.read(), null);
  assert.equal(redirects.length, 0);
});

test('unknown WebApps authentication state leaves storage and location untouched', () => {
  const shared = new MemoryStorage();
  const redirects = [];
  const bridge = new SessionBridge(shared, new MemoryStorage(), href => redirects.push(href));
  const unknown = { querySelector: () => null };
  assert.equal(bridge.reconcile(unknown, `${origin}/webapps/UKSESSION${A}/student/`), false);
  assert.equal(bridge.readWebapps(), null);
  assert.equal(redirects.length, 0);
});
