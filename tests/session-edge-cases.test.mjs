import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OWN_ACTION_KEY, SessionBridge, authenticationState, webappsAuthenticationState,
  bridgeableSisURL, bridgeableWebappsURL, canonicalCuniAliasURL, graftSession, graftWebappsSession,
  ownActionClick, recordOwnAction,
} from '../.test/session.mjs';

const O = 'https://is.cuni.cz';
const A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32);
const ACTIVE = 'sis-suite:active-session:v1';
const WEB_ACTIVE = 'sis-suite:webapps-active-session:v1';
class Store {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
function node(attributes) {
  return { getAttribute: name => attributes[name] ?? null };
}
function doc(links = [], login = false) {
  const anchors = links.map(href => node({ href }));
  const form = node({ action: '/studium/verif.php' });
  return {
    baseURI: O + '/studium/',
    querySelectorAll(selector) {
      if (selector.startsWith('a[')) return anchors;
      if (selector.startsWith('form[')) return login ? [form] : [];
      return [];
    },
    querySelector(selector) {
      if (selector.includes('logoff.php')) return anchors.find(a => a.getAttribute('href').includes('logoff.php')) ?? null;
      if (selector.includes('/logout/')) return anchors.find(a => a.getAttribute('href').includes('/logout/')) ?? null;
      if (selector.includes('input[name="login"]')) return login ? node({ name: 'login' }) : null;
      if (selector.includes('?sso=1')) return anchors.find(a => a.getAttribute('href').includes('?sso=1')) ?? null;
      return null;
    },
  };
}
const authenticated = id => doc(['/studium/logoff.php?id=' + id]);
const loggedOut = () => doc([], true);
const webAuthenticated = id => doc(['/webapps/UKSESSION' + id + '/logout/']);
const webLoggedOut = () => doc(['/webapps/?sso=1']);
const unknown = doc();
function environment(shared = new Store()) {
  let time = 1_000_000_000;
  const tab = new Store(), redirects = [];
  const bridge = new SessionBridge(shared, tab, href => redirects.push(href), () => time);
  return { bridge, shared, tab, redirects, advance: ms => { time += ms; } };
}
// What the runtime does when the user clicks an action link and the tab then opens it.
function clicked(bridge, address) {
  const previous = JSON.parse(bridge.storage.getItem(OWN_ACTION_KEY) || 'null');
  const record = recordOwnAction(previous, ownActionClick(address, address), bridge.now());
  bridge.storage.setItem(OWN_ACTION_KEY, JSON.stringify(record));
  return bridge.permitOwnAction(address);
}
function events(href) {
  const listeners = new Set();
  return {
    location: { href },
    addEventListener: (type, fn) => { if (type === 'storage') listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'storage') listeners.delete(fn); },
    dispatch(storage, key) { for (const fn of [...listeners]) fn({ storageArea: storage, key }); },
    get size() { return listeners.size; },
  };
}
for (const web of [false, true]) {
  const app = web ? 'WebApps' : 'SIS';
  const address = id => web ? `${O}/webapps/UKSESSION${id}/student/` : `${O}/studium/predmety/index.php?id=${id}`;
  test(`${app}: restored authentication cannot supersede newer state`, () => {
    const { bridge } = environment();
    const oldDoc = web ? webAuthenticated(A) : authenticated(A);
    bridge.reconcile(oldDoc, address(A));
    web ? bridge.rejectWebapps(A) : bridge.reject(A);
    web ? bridge.saveWebapps(B) : bridge.save(B);
    bridge.reconcile(oldDoc, address(A), true, 'restored');
    assert.equal((web ? bridge.readWebapps() : bridge.read()).id, B);
    assert.equal(web ? bridge.isWebappsRejected(A) : bridge.isRejected(A), true);
  });
  test(`${app}: a new authenticated document for a previously rejected ID remains learnable`, () => {
    const { bridge } = environment();
    web ? bridge.rejectWebapps(A) : bridge.reject(A);
    web ? bridge.saveWebapps(B) : bridge.save(B);
    bridge.reconcile(web ? webAuthenticated(A) : authenticated(A), address(A));
    assert.equal((web ? bridge.readWebapps() : bridge.read()).id, A);
  });
  test(`${app}: restoring cached logout markup does not reject a newer active ID`, () => {
    const { bridge } = environment();
    web ? bridge.saveWebapps(B) : bridge.save(B);
    bridge.reconcile(web ? webLoggedOut() : loggedOut(), address(B), true, 'restored');
    assert.equal((web ? bridge.readWebapps() : bridge.read()).id, B);
  });
  test(`${app}: an unrelated idless response never rejects an attempted session`, () => {
    const { bridge, redirects } = environment();
    web ? bridge.saveWebapps(B) : bridge.save(B);
    const first = web ? O + '/webapps/first/' : O + '/studium/first/index.php';
    assert.equal(bridge.redirect(first), true);
    bridge.reconcile(unknown, redirects[0]);
    bridge.reconcile(web ? webLoggedOut() : loggedOut(), web ? O + '/webapps/second/' : O + '/studium/second/index.php');
    assert.equal((web ? bridge.readWebapps() : bridge.read()).id, B);
  });
  test(`${app}: a pending attempt does not block another destination`, () => {
    const { bridge } = environment();
    web ? bridge.saveWebapps(B) : bridge.save(B);
    const first = web ? O + '/webapps/first/' : O + '/studium/first/index.php?x=1';
    const second = web ? O + '/webapps/second/' : O + '/studium/first/index.php?x=2';
    assert.equal(bridge.redirect(first), true);
    assert.equal(bridge.redirect(second), true);
  });
  test(`${app}: matching idless failure keeps the session but prevents a loop`, () => {
    const { bridge, redirects } = environment();
    web ? bridge.saveWebapps(B) : bridge.save(B);
    const url = web ? O + '/webapps/student/' : O + '/studium/predmety/index.php?kod=TEST';
    assert.equal(bridge.redirect(url), true);
    bridge.reconcile(web ? webLoggedOut() : loggedOut(), url);
    assert.equal((web ? bridge.readWebapps() : bridge.read()).id, B);
    assert.equal(bridge.redirect(url), false);
    assert.equal(redirects.length, 1);
    web ? bridge.saveWebapps(C) : bridge.save(C);
    assert.equal(bridge.redirect(url), true);
  });
  test(`${app}: idless waiting page resumes when another tab learns a session`, () => {
    const { bridge, shared, redirects } = environment();
    const url = web ? O + '/webapps/student/' : O + '/studium/predmety/index.php?kod=TEST';
    const out = web ? webLoggedOut() : loggedOut(), bus = events(url);
    bridge.reconcile(out, url);
    bridge.watchForSession(out, url, bus);
    web ? bridge.saveWebapps(B) : bridge.save(B);
    bus.dispatch(shared, web ? WEB_ACTIVE : ACTIVE);
    assert.equal(redirects.length, 1);
    assert.equal(bus.size, 0);
  });
  for (const count of [1, 5, 8, 9, 16]) {
    test(`${app}: all ${count} distinct rejected documents retain their evidence`, () => {
      const store = new Store(), pages = [];
      for (let n = 1; n <= count; n++) {
        const id = n.toString(16).padStart(32, '0');
        const e = environment(store), url = address(id), out = web ? webLoggedOut() : loggedOut();
        const bus = events(url);
        e.bridge.reconcile(out, url);
        e.bridge.watchForSession(out, url, bus);
        pages.push({ ...e, bus });
      }
      const writer = environment(store).bridge;
      web ? writer.saveWebapps(B) : writer.save(B);
      for (const e of pages) e.bus.dispatch(store, web ? WEB_ACTIVE : ACTIVE);
      assert.deepEqual(pages.map(e => e.redirects.length), Array(count).fill(1));
    });
  }
}

test('SIS query graft preserves unrelated octets, order, duplicates, flags and fragment', () => {
  const tail = 'raw=%E8&x=one%20two&x=one+two&flag&empty=&encoded=%2f%2F&&';
  const result = graftSession(`${O}/studium/predmety/index.php?${tail}#section`, { id: B, tid: '' });
  assert.equal(result.search, `?id=${B}&tid=&${tail}`);
  assert.equal(result.hash, '#section');
});
for (const query of [`id=&id=${A}`, `id=${A}&id=`, `id=${A}&%69d=${B}`, 'tid=x&tid=y']) {
  test('Ambiguous parameters are not admitted: ' + query, () => {
    assert.equal(bridgeableSisURL(`${O}/studium/predmety/index.php?${query}`), null);
    assert.equal(graftSession(`${O}/studium/predmety/index.php?${query}`, { id: C }, true), null);
  });
}
test('An encoded single session key is replaced without touching unrelated bytes', () => {
  const result = graftSession(`${O}/studium/predmety/index.php?%69d=${A}&raw=%E8&t%69d=x`, { id: B }, true);
  assert.equal(result.search, `?id=${B}&tid=&raw=%E8`);
});
test('Whitespace-only explicit ID is not treated as absent', () => {
  const { bridge } = environment();
  bridge.save(B);
  assert.equal(bridge.redirect(O + '/studium/predmety/index.php?id=%20'), false);
});
test('Ambiguous IDs cannot be learned or rejected during reconciliation', () => {
  const { bridge } = environment();
  bridge.save(C);
  const url = `${O}/studium/predmety/index.php?id=${A}&id=${B}`;
  bridge.reconcile(authenticated(A), url);
  assert.equal(bridge.read().id, C);
  bridge.reconcile(loggedOut(), url);
  assert.equal(bridge.isRejected(A), false);
});
test('Reconciliation stays inside the same admitted origin and application', () => {
  for (const url of [`${O}/other/index.php?id=${A}`, `https://u:p@is.cuni.cz/studium/index.php?id=${A}`]) {
    const { bridge } = environment();
    bridge.reconcile(authenticated(A), url);
    assert.equal(bridge.read(), null);
  }
});
test('Logout ID mismatch returns unknown instead of validating the URL ID', () => {
  assert.equal(authenticationState(authenticated(B), `${O}/studium/index.php?id=${A}`), 'unknown');
  assert.equal(webappsAuthenticationState(webAuthenticated(B), `${O}/webapps/UKSESSION${A}/student/`), 'unknown');
});
test('External links mentioning logoff.php or sso=1 are ignored', () => {
  assert.equal(authenticationState(doc(['https://example.org/docs/logoff.php-guide'], true)), 'logged-out');
  assert.equal(webappsAuthenticationState(doc(['https://example.org/?sso=1'])), 'unknown');
});
test('SSO query parameter order and optional WebApps logout trailing slash are accepted', () => {
  assert.equal(authenticationState(doc(['/studium/index.php?lang=en&sso'])), 'logged-out');
  assert.equal(webappsAuthenticationState(doc(['/webapps/?lang=en&sso=1'])), 'logged-out');
  assert.equal(webappsAuthenticationState(doc([`/webapps/UKSESSION${B}/logout`])), 'authenticated');
});
test('Pages with both login and logout controls return unknown', () => {
  assert.equal(authenticationState(doc(['/studium/logoff.php'], true)), 'unknown');
});
for (const path of ['/webapps/logout/', '/webapps/logout', `/webapps/UKSESSION${B}/logout/`]) {
  test('Recognized WebApps logout shape clears only WebApps: ' + path, () => {
    const { bridge } = environment();
    bridge.save(A); bridge.saveWebapps(B);
    bridge.reconcile(webLoggedOut(), O + path);
    assert.equal(bridge.readWebapps(), null);
    assert.equal(bridge.read().id, A);
  });
}

for (const web of [false, true]) {
  test(`${web ? 'WebApps' : 'SIS'}: inconclusive redirects across different routes have a finite budget`, () => {
    const { bridge, redirects, advance } = environment();
    web ? bridge.saveWebapps(B) : bridge.save(B);
    for (let n = 0; n < 20; n += 1) {
      const address = web ? `${O}/webapps/unknown-${n}/` : `${O}/studium/unknown-${n}/index.php`;
      bridge.redirect(address);
      bridge.reconcile(unknown, address);
    }
    assert.equal(redirects.length, 8);
    assert.equal((web ? bridge.readWebapps() : bridge.read()).id, B);
    advance(300001);
    assert.equal(bridge.redirect(web ? `${O}/webapps/next/` : `${O}/studium/next/index.php`), true);
  });
  test(`${web ? 'WebApps' : 'SIS'}: a fresh authenticated document resets inconclusive retry accounting`, () => {
    const { bridge, redirects } = environment();
    web ? bridge.saveWebapps(B) : bridge.save(B);
    for (let n = 0; n < 20; n += 1) {
      const address = web ? `${O}/webapps/good-${n}/` : `${O}/studium/good-${n}/index.php`;
      assert.equal(bridge.redirect(address), true);
      bridge.reconcile(web ? webAuthenticated(B) : authenticated(B), redirects.at(-1));
    }
    assert.equal(redirects.length, 20);
  });
  test(`${web ? 'WebApps' : 'SIS'}: unknown idless documents never wait or navigate`, () => {
    const { bridge, shared, redirects } = environment();
    const address = web ? `${O}/webapps/unknown/` : `${O}/studium/unknown/index.php`;
    const bus = events(address);
    bridge.reconcile(unknown, address);
    bridge.watchForSession(unknown, address, bus);
    web ? bridge.saveWebapps(B) : bridge.save(B);
    bus.dispatch(shared, web ? WEB_ACTIVE : ACTIVE);
    assert.equal(bus.size, 0);
    assert.equal(redirects.length, 0);
  });
}

// A grafted session authorizes whatever the address does. Shapes seen on native SIS action
// routes: action scripts, delete/action parameters and the enrollment command.
const ACTION_ROUTES = [
  '/studium/rozvrhng/do_add_bookmark.php?gl=TEST&redir=x&skr=2026&sem=1',
  '/studium/rozvrhng/do_delete_bookmark.php?ucebna=123',
  '/studium/eng/rozvrhng/do_delete_bookmark.php?ucebna=123',
  '/studium/predm_st2/index.php?do=zapsat&kod=TEST',
  '/studium/predm_st2/index.php?do=ceka&delete=1',
  '/studium/predm_st2/index.php?do=zapis_plan&action=delete',
  '/studium/predm_st2/index.php?do=zapis_plan&do=zapsat',
  '/studium/predm_st2/index.php?do=ZAPSAT',
  '/studium/predm_st2/index.php?%64o=zapsat',
  '/studium/predm_st2/index.php?kod=TEST&%64elete=1',
];
for (const route of ACTION_ROUTES) {
  test('Action-shaped SIS address stays native: ' + route, () => {
    assert.equal(bridgeableSisURL(O + route), null);
    assert.equal(graftSession(O + route, { id: B }), null);
    assert.equal(canonicalCuniAliasURL('https://www.is.cuni.cz' + route), null);
    const { bridge, redirects } = environment();
    bridge.save(B);
    assert.equal(bridge.redirect(O + route), false);
    const stale = O + route + '&id=' + A;
    assert.equal(bridge.reconcile(loggedOut(), stale), false);
    assert.equal(bridge.isRejected(A), false);
    assert.deepEqual(redirects, []);
  });
}
test('View routes sharing that vocabulary remain repairable', () => {
  for (const route of [
    '/studium/predmety/index.php?do=predmet&kod=TEST',
    '/studium/predm_st2/index.php?do=zapis_plan',
    '/studium/predm_st2/index.php?do=ceka',
    '/studium/rozvrhng/roz_predmet_gl.php?gl=TEST&skr=2026&sem=1',
  ]) {
    assert.ok(bridgeableSisURL(O + route), route);
    assert.ok(graftSession(O + route, { id: B }), route);
    assert.ok(canonicalCuniAliasURL('https://www.is.cuni.cz' + route), route);
  }
});

// A permitted own action: the user clicked this exact action link in SIS and its session had died.
for (const [label, action] of [['SIS script', '/studium/rozvrhng/do_delete_bookmark.php?ucebna=123'], ['SIS command', '/studium/predm_st2/index.php?do=zapsat&kod=TEST']]) {
  test(`Permitted own action is repaired after a later login: ${label}`, () => {
    const { bridge, shared, redirects } = environment();
    const stale = `${O}${action}&id=${A}`;
    bridge.save(A);
    clicked(bridge, stale);
    assert.equal(bridge.redirect(stale), false);
    assert.equal(bridge.reconcile(loggedOut(), stale), false);
    assert.equal(bridge.isRejected(A), true);
    const bus = events(stale);
    bridge.watchForSession(loggedOut(), stale, bus);
    assert.equal(bus.size, 1);
    environment(shared).bridge.save(B);
    bus.dispatch(shared, ACTIVE);
    assert.equal(redirects.length, 1);
    assert.equal(new URL(redirects[0]).searchParams.get('id'), B);
    assert.equal(redirects[0], `${O}${action.replace('?', `?id=${B}&tid=&`)}`);
    assert.equal(bus.size, 0);
  });
}
test('A permitted own action with a different session already known is repaired at once', () => {
  const { bridge, redirects } = environment();
  const stale = `${O}/studium/rozvrhng/do_delete_bookmark.php?ucebna=123&id=${A}`;
  bridge.save(B);
  clicked(bridge, stale);
  assert.equal(bridge.redirect(stale), false);
  assert.equal(bridge.reconcile(loggedOut(), stale), true);
  assert.equal(redirects.length, 1);
  assert.equal(new URL(redirects[0]).searchParams.get('id'), B);
});
test('Permission covers one exact address and no other action', () => {
  const { bridge, redirects } = environment();
  const stale = `${O}/studium/rozvrhng/do_delete_bookmark.php?ucebna=123&id=${A}`;
  bridge.save(B);
  clicked(bridge, stale);
  for (const other of [`${O}/studium/rozvrhng/do_delete_bookmark.php?ucebna=124&id=${A}`, `${O}/studium/rozvrhng/do_delete_bookmark.php?ucebna=123`, `${O}/studium/rozvrhng/do_add_bookmark.php?ucebna=123&id=${A}`]) {
    assert.equal(bridge.reconcile(loggedOut(), other), false, other);
  }
  assert.deepEqual(redirects, []);
});
test('Permission never admits authentication routes or ambiguous addresses', () => {
  const { bridge, redirects } = environment();
  bridge.save(B);
  for (const address of [`${O}/studium/login.php?do=zapsat&id=${A}`, `${O}/studium/predm_st2/index.php?do=zapsat&sso&id=${A}`, `${O}/studium/predm_st2/index.php?do=zapsat&id=${A}&id=${B}`]) {
    bridge.permitOwnAction(address);
    assert.equal(bridge.reconcile(loggedOut(), address), false, address);
  }
  assert.deepEqual(redirects, []);
});

test('Cookie-check handshakes and unnormalized authentication paths are never bridged', () => {
  for (const route of [
    '/studium/cookies.php?do=xcheck&ret=index.php',
    '/studium/eng/cookies.php?ret=index.php&opakovano=1',
    '/studium//login.php',
    '/studium//logoff.php',
    '/studium//verif.php',
    '/studium//cookies.php?do=xcheck',
    '/studium//index.php?unexpected=1',
    '/studium/zkous_st/index.php?sso?ret=zkous_st/index.php',
    '/studium/zkous_st/index.php?sso_nia',
  ]) {
    assert.equal(bridgeableSisURL(O + route), null, route);
    assert.equal(graftSession(O + route, { id: B }), null, route);
  }
});

test('Action-shaped WebApps and duplicate-slash SIS routes stay native', () => {
  for (const route of [
    '/webapps/student/?action=delete',
    '/webapps/student/?delete=1',
    '/webapps/student/do_remove.php',
    '/webapps//logout/',
  ]) {
    assert.equal(bridgeableWebappsURL(O + route), null, route);
    assert.equal(graftWebappsSession(O + route, { id: B }), null, route);
    if (!route.includes('logout')) {
      assert.equal(canonicalCuniAliasURL('https://www.is.cuni.cz' + route), null, route);
    }
  }
  const slashAction = '/studium//rozvrhng//do_delete_bookmark.php?ucebna=123';
  assert.equal(bridgeableSisURL(O + slashAction), null);
  assert.equal(canonicalCuniAliasURL('https://www.is.cuni.cz' + slashAction), null);
});

test('Live SIS login variants and submodule relative forms count as logged-out evidence', () => {
  assert.equal(authenticationState(doc(['/studium/index.php?sso?ret=zkous_st/index.php'])), 'logged-out');
  assert.equal(authenticationState(doc(['/studium/index.php?sso_nia'])), 'logged-out');
  assert.equal(authenticationState(doc(['/studium/zkous_st/index.php?sso_nia'])), 'logged-out');
  assert.equal(authenticationState(doc(['/studium/zkous_st/index.php?&sso&sso_ret_role=1'])), 'logged-out');
  const submoduleButtonDoc = {
    baseURI: O + '/studium/zkous_st/index.php',
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === 'button[data-href]') {
        return [node({ 'data-href': O + '/studium/zkous_st/index.php?&sso&sso_ret_role=1' })];
      }
      return [];
    },
  };
  assert.equal(authenticationState(submoduleButtonDoc, O + '/studium/zkous_st/index.php'), 'logged-out');
  const submoduleFormDoc = {
    baseURI: O + '/studium/zkous_st/index.php',
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector.startsWith('form[')) return [node({ action: 'verif.php' })];
      return [];
    },
  };
  assert.equal(authenticationState(submoduleFormDoc, O + '/studium/zkous_st/index.php'), 'logged-out');
});

test('SIS navigation tiles and read-only module views remain repairable', () => {
  for (const route of [
    '/studium/predmety/index.php?KEY=2659676693z1',
    '/studium/help2.php?modul=stev',
    '/studium/predmety/index.php?do=search',
    '/studium/bookmarks/index.php?do=mybookmarks',
    '/studium/bookmarks/index.php?do=sharedbookmarks',
  ]) {
    assert.ok(bridgeableSisURL(O + route), route);
  }
});

test('SIS session ID comparisons are case-insensitive across URLs, logout links and rejection state', () => {
  const upperA = A.toUpperCase();
  assert.equal(authenticationState(authenticated(A), `${O}/studium/index.php?id=${upperA}`), 'authenticated');
  assert.equal(graftSession(`${O}/studium/index.php?id=${upperA}&tid=`, { id: A, tid: '' }, true), null);
  const { bridge } = environment();
  bridge.save(A);
  bridge.reject(upperA);
  assert.equal(bridge.read(), null);
  assert.equal(bridge.isRejected(A), true);
  assert.equal(bridge.isRejected(upperA), true);
  bridge.forgetRejected(A);
  assert.equal(bridge.isRejected(upperA), false);
});

test('Encoded action pathnames, PHP path-info, padded/bracketed fields and non-menu KEY routes are never bridged', () => {
  for (const route of [
    '/studium/rozvrhng/%64%6f_delete_bookmark.php?ucebna=123',
    '/studium/predmety/%2e%2e/rozvrhng/%64%6f_add_bookmark.php?gl=26aTEST123x01',
    '/studium/rozvrhng/do_delete_bookmark.php/extra?ucebna=123',
    '/studium/predm_st2/index.php?%20delete=1',
    '/studium/predm_st2/index.php?action[]=delete',
    '/studium/predm_st2/index.php?do[0]=zapsat',
    '/studium/rozvrhng/roz_muj_macro.php?rezim=kosik&KEY=ACTION',
    '/studium/predm_st2/index.php?do=zapis_plan&KEY=2659676693z1',
    '/studium/predmety/index.php?KEY[]=2659676693z1',
    '/studium/%6c%6f%67%69%6e.php?ret=predmety/index.php',
    '/studium/login.php/extra?ret=predmety/index.php',
    '/studium/index.php/extra?unexpected=1',
  ]) {
    assert.equal(bridgeableSisURL(O + route), null, route);
    assert.equal(graftSession(O + route, { id: B, tid: '' }), null, route);
  }
  for (const actionRoute of [
    '/studium/rozvrhng/%64%6f_delete_bookmark.php?ucebna=123',
    '/studium/rozvrhng/do_delete_bookmark.php/extra?ucebna=123',
    '/studium/rozvrhng/roz_muj_macro.php?rezim=kosik&KEY=ACTION',
    '/studium/predm_st2/index.php?action[]=delete',
  ]) {
    assert.equal(canonicalCuniAliasURL('https://www.is.cuni.cz' + actionRoute), null, actionRoute);
  }
});

// A tab left on the logged-out result of a clicked action, waiting for a new session.
function waitingAction(shared, click = true) {
  const tab = environment(shared);
  const stale = `${O}/studium/rozvrhng/do_delete_bookmark.php?ucebna=123&id=${A}`;
  if (click) clicked(tab.bridge, stale);
  else tab.bridge.permitOwnAction(stale);
  tab.bridge.reconcile(loggedOut(), stale);
  tab.bus = events(stale);
  tab.bridge.watchForSession(loggedOut(), stale, tab.bus);
  return tab;
}

for (const [minutes, expected] of [[4, 1], [6, 0]]) {
  test(`A waiting own action ${expected ? 'is' : 'is not'} replayed when the new session appears after ${minutes} minutes`, () => {
    const shared = new Store();
    const tab = waitingAction(shared);
    tab.advance(minutes * 60 * 1000);
    environment(shared).bridge.save(B);
    tab.bus.dispatch(shared, ACTIVE);
    assert.equal(tab.redirects.length, expected);
  });
}

test('Two tabs opened from one action click replay it only once', () => {
  const shared = new Store();
  const first = waitingAction(shared);
  const second = waitingAction(shared, false);
  environment(shared).bridge.save(B);
  first.bus.dispatch(shared, ACTIVE);
  second.bus.dispatch(shared, ACTIVE);
  assert.equal(first.redirects.length, 1);
  assert.deepEqual(second.redirects, []);
  assert.equal(shared.getItem(OWN_ACTION_KEY), null);
});

test('Signing out cancels a waiting own action', () => {
  const shared = new Store();
  const tab = waitingAction(shared);
  environment(shared).bridge.reconcile(unknown, `${O}/studium/logoff.php?id=${A}`);
  assert.equal(shared.getItem(OWN_ACTION_KEY), null);
  environment(shared).bridge.save(B);
  tab.bus.dispatch(shared, ACTIVE);
  assert.deepEqual(tab.redirects, []);
});

test('A stale view link is still repaired after signing out and back in', () => {
  const shared = new Store();
  const { bridge, redirects } = environment(shared);
  bridge.save(A);
  bridge.reconcile(unknown, `${O}/studium/logoff.php?id=${A}`);
  bridge.save(B);
  const stale = `${O}/studium/predmety/index.php?id=${A}&tid=&do=predmet&kod=TEST`;
  assert.equal(bridge.reconcile(loggedOut(), stale), true);
  assert.deepEqual(redirects, [`${O}/studium/predmety/index.php?id=${B}&tid=&do=predmet&kod=TEST`]);
});

test('An own action record older than five minutes grants nothing at load', () => {
  const { bridge, redirects, advance } = environment();
  const stale = `${O}/studium/rozvrhng/do_delete_bookmark.php?ucebna=123&id=${A}`;
  clicked(bridge, stale);
  advance(5 * 60 * 1000 + 1);
  assert.equal(bridge.permitOwnAction(stale), false);
  bridge.save(B);
  assert.equal(bridge.reconcile(loggedOut(), stale), false);
  assert.deepEqual(redirects, []);
});

test('A signed-in page keeps its own ID while another session is stored', () => {
  const { bridge, redirects } = environment();
  bridge.save(B);
  const page = `${O}/studium/predmety/index.php?id=${A}&tid=`;
  assert.equal(bridge.redirect(page), false);
  assert.equal(bridge.reconcile(authenticated(A), page), false);
  assert.deepEqual(redirects, []);
  assert.equal(bridge.read().id, A);
});

test('A page with both login and logout controls does not replace its ID', () => {
  const { bridge, redirects } = environment();
  bridge.save(B);
  const page = `${O}/studium/predmety/index.php?id=${A}&tid=`;
  const mixed = doc([`/studium/logoff.php?id=${A}`], true);
  assert.equal(bridge.reconcile(mixed, page), false);
  assert.deepEqual(redirects, []);
  assert.equal(bridge.read().id, B);
  assert.equal(bridge.isRejected(A), false);
});

const MENU = `${O}/studium/predm_st2/index.php`;
test('A menu KEY from an expired login is dropped when the ID is replaced', () => {
  const { bridge, redirects } = environment();
  bridge.save(B);
  assert.equal(bridge.reconcile(loggedOut(), `${MENU}?id=${A}&tid=&KEY=1234567890z1`), true);
  assert.deepEqual(redirects, [`${MENU}?id=${B}&tid=`]);
});

test('A menu KEY is not paired with a stored session on a sessionless link', () => {
  assert.equal(graftSession(`${MENU}?KEY=1234567890z1`, { id: B, tid: '' }).href, `${MENU}?id=${B}&tid=`);
  assert.equal(graftSession(`${MENU}?%20KEY=1234567890z1`, { id: B, tid: '' }).href, `${MENU}?id=${B}&tid=`);
});

test('A menu KEY stays when only tid changes for the same session', () => {
  const url = graftSession(`${MENU}?id=${B}&tid=1&KEY=1234567890z1`, { id: B, tid: '' }, true);
  assert.equal(url.href, `${MENU}?id=${B}&tid=&KEY=1234567890z1`);
});
