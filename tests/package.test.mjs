import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';

const sizes = [16, 32, 48, 64, 96, 128];
const targets = ['firefox', 'chrome'];
const release = JSON.parse(await readFile('release.json', 'utf8'));
// The store build (the AMO source archive) also writes ZIPs that carry README.txt and PRIVACY.txt.
const storeBuild = await readFile('README.txt').then(() => true, () => false);
const expectedMatches = [
  'https://is.cuni.cz/studium/*',
  'https://is.cuni.cz/webapps/*',
  'https://www.is.cuni.cz/studium/*',
  'https://www.is.cuni.cz/webapps/*',
  'https://cas.cuni.cz/cas/*',
];
const iconHashes = {
  16: 'f580e0fa8f104661ca2d3e30aec8a5f043968ad7226a2efe3854f148dfa31796',
  32: '36b014632f0d3a64d2517f170fa8eb5e0eee34eee78a2e53b10d46227a485312',
  48: '0710903c6255b14f6fd7d4a005dbb21a849a88d676ee3bdd90233c15383cfdbe',
  64: 'a328704805e0d53126a93d31fe1a702e6fbd2bb4ddf93c85e94daee88b423e84',
  96: '3d14f55312fd5df0646087cd04510a0545b3955e2a09137a99ccfdb7f31e5f9b',
  128: '50aa9319e3fb109704754d3fe1227c51c9369a0035bec8e6c759c91cc2818b18',
};

const manifests = Object.fromEntries(await Promise.all(targets.map(async target => [
  target,
  JSON.parse(await readFile(`dist/${target}/manifest.json`, 'utf8')),
])));

for (const target of targets) {
  const manifest = manifests[target];

  test(`${target}: public name and version`, () => {
    assert.equal(manifest.name, 'SIS Login Fix - Session ID Replacer');
    assert.equal(manifest.version, release.version);
  });

  test(`${target}: declared icons match the included artwork`, async () => {
    assert.deepEqual(
      manifest.icons,
      Object.fromEntries(sizes.map(size => [String(size), `icons/icon-${size}.png`])),
    );

    for (const size of sizes) {
      const bytes = await readFile(`dist/${target}/icons/icon-${size}.png`);
      assert.equal(bytes.readUInt32BE(16), size);
      assert.equal(bytes.readUInt32BE(20), size);
      assert.deepEqual(bytes, await readFile(`icons/icon-${size}.png`));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), iconHashes[size]);
    }
  });

  test(`${target}: host scope and privileges stay narrow`, () => {
    assert.deepEqual(manifest.content_scripts, [{
      matches: expectedMatches,
      js: ['content.js'],
      run_at: 'document_start',
      all_frames: false,
    }]);

    for (const key of [
      'permissions',
      'host_permissions',
      'background',
      'options_ui',
      'action',
      'key',
      'web_accessible_resources',
      'update_url',
    ]) {
      assert.ok(!(key in manifest), key);
    }
  });

  test(`${target}: installer contains only runtime and declared assets`, async () => {
    const hasSignedManifest = await readFile(`signatures/${target}-MANIFEST.asc`).then(() => true, () => false);
    const expected = ['LICENSE', 'content.js', 'icons', 'manifest.json'];
    if (storeBuild) {
      expected.push('PRIVACY.txt', 'README.txt');
    }
    if (hasSignedManifest) {
      expected.push('MANIFEST.asc');
    }
    assert.deepEqual(
      (await readdir(`dist/${target}`)).sort(),
      expected.sort(),
    );
    assert.deepEqual(
      (await readdir(`dist/${target}/icons`)).sort(),
      sizes.map(size => `icon-${size}.png`).sort(),
    );
  });
}

test('Firefox manifest identity and minimum versions', () => {
  assert.deepEqual(manifests.firefox.browser_specific_settings, {
    gecko: {
      id: '@addenda-carolina-session',
      strict_min_version: '140.0',
      data_collection_permissions: { required: ['none'] },
    },
    gecko_android: { strict_min_version: '142.0' },
  });
});

test('Chrome manifest minimum version and identity shape', () => {
  assert.equal(manifests.chrome.minimum_chrome_version, '120');
  assert.ok(!('browser_specific_settings' in manifests.chrome));
});

test('Chrome and Firefox ship identical content scripts', async () => {
  const firefox = await readFile('dist/firefox/content.js');
  const chrome = await readFile('dist/chrome/content.js');

  assert.deepEqual(firefox, chrome);
  assert.ok(chrome.toString().includes(`startLoginFix("${release.version}")`));

  for (const api of [
    'fetch(',
    'XMLHttpRequest',
    'sendBeacon',
    'WebSocket',
    'eval(',
    'new Function(',
    'replaceState(',
  ]) {
    assert.ok(!chrome.toString().includes(api), api);
  }
});

test('userscript has expected metadata and runtime', async () => {
  const userscript = await readFile(`dist/sis-login-fix-${release.version}.user.js`, 'utf8');
  const runtime = await readFile('dist/chrome/content.js', 'utf8');
  const header = [
    '// ==UserScript==',
    '// @name         SIS Login Fix',
    '// @namespace    https://github.com/Addenda-Carolina/addenda',
    `// @version      ${release.version}`,
    '// @description  Repairs stale SIS and WebApps session links and fixes CUNI CAS 2FA autofill.',
    '// @author       skrblk',
    '// @license      GPL-3.0-or-later',
    '// @homepageURL  https://github.com/Addenda-Carolina/addenda',
    '// @supportURL   https://github.com/Addenda-Carolina/addenda/issues',
    '// @icon         https://addenda.rychle.info/icon-128.png',
    '// @downloadURL  https://github.com/Addenda-Carolina/addenda/releases/latest/download/sis-login-fix.user.js',
    '// @updateURL    https://github.com/Addenda-Carolina/addenda/releases/latest/download/sis-login-fix.user.js',
    ...expectedMatches.map(match => `// @match        ${match}`),
    '// @run-at       document-start',
    '// @noframes',
    '// @grant        none',
    '// ==/UserScript==',
    '',
    '',
  ].join('\n');
  assert.equal(userscript, header + runtime);
});

test('build output contains only the declared formats', async () => {
  const expected = ['chrome', 'firefox', `sis-login-fix-${release.version}.user.js`];
  if (storeBuild) {
    expected.push(`sis-login-fix-chrome-${release.version}.zip`, `sis-login-fix-firefox-${release.version}.zip`);
  }
  assert.deepEqual((await readdir('dist')).sort(), expected.sort());
});
