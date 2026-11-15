import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'));
const version = release.version;
const sizes = [16, 32, 48, 64, 96, 128];
const matches = [
  'https://is.cuni.cz/studium/*',
  'https://is.cuni.cz/webapps/*',
  'https://www.is.cuni.cz/studium/*',
  'https://www.is.cuni.cz/webapps/*',
  'https://cas.cuni.cz/cas/*',
];

if (typeof version !== 'string'
    || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)
    || version.split('.').some(part => Number(part) > 65535)
    || version === '0.0.0') {
  throw new Error('Version must be three integers from 0 to 65535, without leading zeros or an all-zero value.');
}
for (const field of ['name', 'firefoxId', 'firefoxMinimum', 'firefoxAndroidMinimum', 'chromeMinimum']) {
  if (typeof release[field] !== 'string' || !release[field].trim()) {
    throw new Error(`Missing release field: ${field}`);
  }
}

execFileSync(
  process.execPath,
  [require.resolve('typescript/bin/tsc'), '--project', join(root, 'tsconfig.json')],
  { stdio: 'inherit' },
);

const output = join(root, 'dist');
try {
  if (!(await lstat(output)).isDirectory()) {
    throw new Error('dist must be a directory, not a link or file.');
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const license = await readFile(join(root, 'LICENSE'));
const stage = await mkdtemp(join(root, '.build-'));
let previous;
try {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['src/content.ts'],
    outfile: 'content.js',
    bundle: true,
    format: 'iife',
    target: ['es2022'],
    minify: false,
    legalComments: 'inline',
    charset: 'utf8',
    write: false,
    define: { __VERSION__: JSON.stringify(version) },
  });
  const runtime = result.outputFiles[0].contents;

  for (const browser of ['chrome', 'firefox']) {
    const folder = join(stage, browser);
    const manifest = {
      manifest_version: 3,
      name: release.name,
      version,
      description: 'Repairs stale SIS links and improves CUNI CAS one-time-code autofill.',
      content_scripts: [{
        matches,
        js: ['content.js'],
        run_at: 'document_start',
        all_frames: false,
      }],
    };
    if (browser === 'firefox') {
      manifest.browser_specific_settings = {
        gecko: {
          id: release.firefoxId,
          strict_min_version: release.firefoxMinimum,
          data_collection_permissions: { required: ['none'] },
        },
        gecko_android: { strict_min_version: release.firefoxAndroidMinimum },
      };
    } else {
      manifest.minimum_chrome_version = release.chromeMinimum;
    }
    manifest.icons = Object.fromEntries(sizes.map(size => [String(size), `icons/icon-${size}.png`]));
    await mkdir(join(folder, 'icons'), { recursive: true });
    await writeFile(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(join(folder, 'content.js'), runtime);
    await writeFile(join(folder, 'LICENSE'), license);
    for (const size of sizes) {
      await cp(join(root, `icons/icon-${size}.png`), join(folder, `icons/icon-${size}.png`));
    }
  }

  const header = [
    '// ==UserScript==',
    '// @name         SIS Login Fix',
    '// @namespace    https://github.com/Addenda-Carolina/addenda',
    `// @version      ${version}`,
    '// @description  Repairs stale SIS and WebApps session links and fixes CUNI CAS 2FA autofill.',
    '// @author       skrblk',
    '// @license      GPL-3.0-or-later',
    '// @homepageURL  https://github.com/Addenda-Carolina/addenda',
    '// @supportURL   https://github.com/Addenda-Carolina/addenda/issues',
    '// @icon         https://addenda.rychle.info/icon-128.png',
    '// @downloadURL  https://github.com/Addenda-Carolina/addenda/releases/latest/download/sis-login-fix.user.js',
    '// @updateURL    https://github.com/Addenda-Carolina/addenda/releases/latest/download/sis-login-fix.user.js',
    ...matches.map(match => `// @match        ${match}`),
    '// @run-at       document-start',
    '// @noframes',
    '// @grant        none',
    '// ==/UserScript==',
    '',
    '',
  ].join('\n');
  await writeFile(
    join(stage, `sis-login-fix-${version}.user.js`),
    header + Buffer.from(runtime).toString('utf8'),
  );

  try {
    await lstat(output);
    previous = await mkdtemp(join(root, '.build-previous-'));
    await rm(previous, { recursive: true });
    await rename(output, previous);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await rename(stage, output);
  } catch (error) {
    if (previous) await rename(previous, output);
    previous = undefined;
    throw error;
  }
  if (previous) await rm(previous, { recursive: true });
  console.log(`Built Chrome, Firefox, and userscript ${version} in dist/`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
