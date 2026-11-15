import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import * as runtime from '../.test/runtime.mjs';

const { version } = JSON.parse(await readFile(new URL('../release.json', import.meta.url), 'utf8'));

test('storage admission checks read/write/remove and preserves an existing probe value', () => {
  assert.equal(typeof runtime.writableStorage, 'function');
  const values = new Map([['sis-login-fix:storage-probe:v1', 'existing']]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key,value) => values.set(key,value), removeItem: key => values.delete(key) };
  assert.equal(runtime.writableStorage(storage), true);
  assert.equal(values.get('sis-login-fix:storage-probe:v1'), 'existing');
  assert.equal(runtime.writableStorage({ ...storage, setItem() {} }), false);
  assert.equal(runtime.writableStorage({ ...storage, getItem() { throw Error('denied'); } }), false);
});

class Store {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
function withRuntime(address, links, exercise, initialize = () => {}, stores = {}) {
  const saved = Object.fromEntries(['window', 'document', 'location'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const bus = new EventTarget(), redirects = [];
  const local = stores.local ?? new Store(), perTab = stores.perTab ?? new Store();
  const location = { href: address, replace: href => redirects.push(href) };
  Object.assign(bus, { top: bus, location, localStorage: local, sessionStorage: perTab });
  const document = Object.assign(new EventTarget(), {
    baseURI: address, readyState: 'complete', documentElement: { dataset: {} },
    querySelector: selector => {
      const href = links.find(link => selector.includes('logoff.php') && link.includes('logoff.php')
        || selector.includes('/logout/') && link.includes('/logout/'));
      return href ? { getAttribute: name => name === 'href' ? href : null } : null;
    },
    querySelectorAll: selector => selector === 'a[href]'
      ? links.map(href => ({ getAttribute: name => name === 'href' ? href : null })) : [],
  });
  let stop = () => {};
  try {
    Object.assign(globalThis, { window: bus, document, location });
    initialize({ local, perTab });
    stop = runtime.startLoginFix(version);
    exercise({ bus, local, perTab, redirects, stop });
  } finally {
    stop();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}
for (const web of [false, true]) {
  test(`${web ? 'WebApps' : 'SIS'} BFCache pageshow does not overwrite newer session state`, () => {
    const a = 'a'.repeat(32), b = 'b'.repeat(32);
    const prefix = web ? 'sis-suite:webapps-' : 'sis-suite:';
    const key = prefix + 'active-session:v1', rejected = prefix + 'rejected-sessions:v1';
    const address = web ? `https://is.cuni.cz/webapps/UKSESSION${a}/student/` : `https://is.cuni.cz/studium/index.php?id=${a}`;
    const logout = web ? `/webapps/UKSESSION${a}/logout/` : `/studium/logoff.php?id=${a}`;
    withRuntime(address, [logout], ({ bus, local, redirects }) => {
      assert.equal(JSON.parse(local.getItem(key)).id, a);
      local.setItem(rejected, JSON.stringify([{ id: a, at: Date.now() }]));
      local.setItem(key, JSON.stringify({ id: b, at: Date.now() }));
      const before = local.getItem(key);
      const restored = new Event('pageshow');
      Object.defineProperty(restored, 'persisted', { value: true });
      bus.dispatchEvent(restored);
      assert.equal(local.getItem(key), before);
      assert.equal(JSON.parse(local.getItem(rejected))[0].id, a);
      assert.equal(redirects.length, 0);
    });
  });
}

for (const web of [false, true]) {
  test(`${web ? 'WebApps' : 'SIS'} startup reads the new explicit-ID document before using older rejection evidence`, () => {
    const a = 'a'.repeat(32), b = 'b'.repeat(32);
    const prefix = web ? 'sis-suite:webapps-' : 'sis-suite:';
    const key = prefix + 'active-session:v1', rejected = prefix + 'rejected-sessions:v1';
    const address = web ? `https://is.cuni.cz/webapps/UKSESSION${a}/student/` : `https://is.cuni.cz/studium/predmety/index.php?id=${a}`;
    const logout = web ? `/webapps/UKSESSION${a}/logout/` : `/studium/logoff.php?id=${a}`;
    withRuntime(address, [logout], ({ local, redirects }) => {
      assert.equal(redirects.length, 0);
      assert.equal(JSON.parse(local.getItem(key)).id, a);
      assert.equal(JSON.parse(local.getItem(rejected) || '[]').some(row => row.id === a), false);
    }, ({ local }) => {
      local.setItem(key, JSON.stringify({ id: b, at: Date.now() }));
      local.setItem(rejected, JSON.stringify([{ id: a, at: Date.now() }]));
    });
  });
}

const ALIAS = 'https://www.is.cuni.cz/studium/predmety/index.php?do=predmet&kod=TEST';

test('www alias moves stop when the canonical host keeps sending the tab back', () => {
  const stores = { local: new Store(), perTab: new Store() }, counts = [];
  for (let n = 0; n < 6; n += 1) {
    withRuntime(ALIAS, [], ({ redirects }) => counts.push(redirects.length), undefined, stores);
  }
  assert.deepEqual(counts, [1, 1, 1, 0, 0, 0]);
  assert.equal(stores.local.values.size, 0);
});

test('a www link opened after a burst has passed is moved again', () => {
  const stores = { local: new Store(), perTab: new Store() }, counts = [], now = Date.now;
  let time = 1_000_000_000;
  Date.now = () => time;
  try {
    for (let n = 0; n < 4; n += 1) {
      withRuntime(ALIAS, [], ({ redirects }) => counts.push(redirects.length), undefined, stores);
    }
    time += 10_001;
    withRuntime(ALIAS, [], ({ redirects }) => counts.push(redirects.length), undefined, stores);
  } finally { Date.now = now; }
  assert.deepEqual(counts, [1, 1, 1, 0, 1]);
});

test('www alias moves do not depend on per-tab storage', () => {
  const broken = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); }, removeItem() {} };
  const counts = [];
  for (let n = 0; n < 5; n += 1) {
    withRuntime(ALIAS, [], ({ redirects }) => counts.push(redirects.length), undefined, { perTab: broken });
  }
  assert.deepEqual(counts, [1, 1, 1, 1, 1]);
});

test('an alias page that is not moved is left alone', () => {
  const action = 'https://www.is.cuni.cz/studium/predm_st2/index.php?do=zapsat&kod=TEST';
  const stores = { local: new Store(), perTab: new Store() };
  stores.local.setItem('sis-suite:active-session:v1', JSON.stringify({ id: 'b'.repeat(32), at: Date.now() }));
  withRuntime(action, [], ({ redirects }) => {
    assert.equal(redirects.length, 0);
    assert.equal(document.documentElement.dataset.sisLoginFixVersion, undefined);
  }, undefined, stores);
  assert.deepEqual([...stores.local.values.keys()], ['sis-suite:active-session:v1']);
  assert.equal(stores.perTab.values.size, 0);
});

const OWN_ACTION = 'sis-login-fix:own-action:v1';
const ACTION = 'https://is.cuni.cz/studium/rozvrhng/do_delete_bookmark.php?ucebna=123';
function clickLink(href) {
  const anchor = { href, getAttribute: name => name === 'href' ? href : null };
  anchor.closest = selector => selector === 'a[href]' ? anchor : null;
  const event = new Event('click', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'target', { value: anchor });
  document.dispatchEvent(event);
  return event;
}

test('clicking an SIS action link that carries the page session is remembered', () => {
  const a = 'a'.repeat(32);
  const page = `https://is.cuni.cz/studium/predmety/index.php?id=${a}&tid=&do=predmet&kod=TEST`;
  withRuntime(page, [`/studium/logoff.php?id=${a}`], ({ local }) => {
    const event = clickLink(`${ACTION}&id=${a}&tid=`);
    assert.equal(event.defaultPrevented, false);
    const record = JSON.parse(local.getItem(OWN_ACTION));
    assert.equal(record.destination, ACTION);
    assert.equal(record.id, a);
    assert.ok(Number.isFinite(record.at));
  });
});

test('links without the page session, non-action links and logged-out pages leave no record', () => {
  const a = 'a'.repeat(32), b = 'b'.repeat(32);
  const page = `https://is.cuni.cz/studium/predmety/index.php?id=${a}&tid=&do=predmet&kod=TEST`;
  withRuntime(page, [`/studium/logoff.php?id=${a}`], ({ local }) => {
    clickLink(`${ACTION}`);
    clickLink(`${ACTION}&id=${b}`);
    clickLink(`https://is.cuni.cz/studium/predmety/index.php?id=${a}&do=predmet&kod=OTHER`);
    clickLink(`https://example.org/studium/rozvrhng/do_delete_bookmark.php?id=${a}`);
    assert.equal(local.getItem(OWN_ACTION), null);
  });
  withRuntime(page, ['/studium/index.php?sso'], ({ local }) => {
    clickLink(`${ACTION}&id=${a}`);
    assert.equal(local.getItem(OWN_ACTION), null);
  });
});

for (const [label, age, expected] of [['fresh', 1000, 1], ['five minutes old', 300001, 0]]) {
  test(`a remembered own action is repeated after another tab logs in when the record is ${label}`, () => {
    const a = 'a'.repeat(32), b = 'b'.repeat(32);
    const stale = `${ACTION}&id=${a}`;
    withRuntime(stale, ['/studium/index.php?sso'], ({ bus, local, redirects }) => {
      assert.equal(redirects.length, 0);
      local.setItem('sis-suite:active-session:v1', JSON.stringify({ id: b, at: Date.now() }));
      bus.dispatchEvent(Object.assign(new Event('storage'), { key: 'sis-suite:active-session:v1', storageArea: local }));
      assert.equal(redirects.length, expected);
      if (expected) {
        assert.equal(redirects[0], `https://is.cuni.cz/studium/rozvrhng/do_delete_bookmark.php?id=${b}&tid=&ucebna=123`);
        assert.equal(local.getItem(OWN_ACTION), null);
      }
    }, ({ local }) => {
      local.setItem('sis-suite:active-session:v1', JSON.stringify({ id: a, at: Date.now() }));
      local.setItem(OWN_ACTION, JSON.stringify({ destination: ACTION, id: a, at: Date.now() - age }));
    });
  });
}

test('a remembered own action is not repeated for a different session or destination', () => {
  const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32);
  for (const [address, record] of [
    [`${ACTION}&id=${c}`, { destination: ACTION, id: a }],
    [`${ACTION.replace('123', '124')}&id=${a}`, { destination: ACTION, id: a }],
    [ACTION, { destination: ACTION, id: a }],
  ]) {
    withRuntime(address, ['/studium/index.php?sso'], ({ bus, local, redirects }) => {
      local.setItem('sis-suite:active-session:v1', JSON.stringify({ id: b, at: Date.now() }));
      bus.dispatchEvent(Object.assign(new Event('storage'), { key: 'sis-suite:active-session:v1', storageArea: local }));
      assert.deepEqual(redirects, [], address);
    }, ({ local }) => {
      local.setItem('sis-suite:active-session:v1', JSON.stringify({ id: a, at: Date.now() }));
      local.setItem(OWN_ACTION, JSON.stringify({ ...record, at: Date.now() }));
    });
  }
});

test('clicking a child text node inside an SIS action link records the action', () => {
  const a = 'a'.repeat(32);
  const page = `https://is.cuni.cz/studium/predmety/index.php?id=${a}&tid=&do=predmet&kod=TEST`;
  withRuntime(page, [`/studium/logoff.php?id=${a}`], ({ local }) => {
    const href = `${ACTION}&id=${a}&tid=`;
    const anchor = { href, getAttribute: name => name === 'href' ? href : null };
    anchor.closest = selector => selector === 'a[href]' ? anchor : null;
    const textNode = { parentElement: anchor };
    const event = new Event('auxclick', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: textNode });
    Object.defineProperty(event, 'button', { value: 1 });
    document.dispatchEvent(event);
    const record = JSON.parse(local.getItem(OWN_ACTION));
    assert.equal(record.destination, ACTION);
    assert.equal(record.id, a);
  });
});

test('multiple middle-clicked SIS action links in separate tabs each recover once after login', () => {
  const a = 'a'.repeat(32), b = 'b'.repeat(32);
  const secondAction = ACTION.replace('123', '124');
  const page = `https://is.cuni.cz/studium/predmety/index.php?id=${a}&tid=&do=predmet&kod=TEST`;
  const shared = new Store();
  withRuntime(page, [`/studium/logoff.php?id=${a}`], () => {
    clickLink(`${ACTION}&id=${a}&tid=`);
    clickLink(`${secondAction}&id=${a}&tid=`);
  }, undefined, { local: shared });

  const firstTab = [];
  const secondTab = [];
  withRuntime(`${ACTION}&id=${a}`, ['/studium/index.php?sso'], ({ bus, local, redirects }) => {
    local.setItem('sis-suite:active-session:v1', JSON.stringify({ id: b, at: Date.now() }));
    bus.dispatchEvent(Object.assign(new Event('storage'), { key: 'sis-suite:active-session:v1', storageArea: local }));
    firstTab.push(...redirects);
  }, undefined, { local: shared, perTab: new Store() });

  assert.equal(firstTab.length, 1);
  assert.notEqual(shared.getItem(OWN_ACTION), null);

  withRuntime(`${secondAction}&id=${a}`, ['/studium/index.php?sso'], ({ redirects }) => {
    secondTab.push(...redirects);
  }, undefined, { local: shared, perTab: new Store() });

  assert.equal(secondTab.length, 1);
  assert.equal(firstTab[0], `https://is.cuni.cz/studium/rozvrhng/do_delete_bookmark.php?id=${b}&tid=&ucebna=123`);
  assert.equal(secondTab[0], `https://is.cuni.cz/studium/rozvrhng/do_delete_bookmark.php?id=${b}&tid=&ucebna=124`);
  assert.equal(shared.getItem(OWN_ACTION), null);
});
