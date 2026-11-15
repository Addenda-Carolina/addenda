import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';

const release = JSON.parse(await readFile('release.json', 'utf8'));
execFileSync(process.execPath, ['tools/build.mjs'], { stdio: 'inherit' });

for (const name of ['session', 'runtime', 'otp']) {
  await build({
    entryPoints: [`src/${name}.ts`],
    outfile: `.test/${name}.mjs`,
    bundle: true,
    format: 'esm',
    define: { __VERSION__: JSON.stringify(release.version) },
  });
}

const tests = (await readdir('tests'))
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => `tests/${name}`);
execFileSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
