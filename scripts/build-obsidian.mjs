import { build } from 'esbuild';
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);
const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8');
const root = new URL('../', import.meta.url).pathname;
const manifest = JSON.parse(await read('manifest.json'));
const output = root + 'dist/obsidian/' + manifest.id;
if(JSON.stringify(manifest)!==JSON.stringify(JSON.parse(await read('obsidian/manifest.json'))))throw new Error('Root and plugin manifests must match.');
await mkdir(output, { recursive: true });
const client = await build({ entryPoints: [root + 'public/app.js'], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'chrome120' });
const assets = { html: await read('public/index.html'), css: await read('public/style.css') + '\n' + await read('obsidian/workbench.css'), app: client.outputFiles[0].text, frame: await read('public/frame.js'), sample: await read('examples/weekly-review.html') };
await build({ entryPoints: [root + 'obsidian/main.js'], outfile: output + '/main.js', bundle: true, format: 'cjs', platform: 'node', target: 'node18', external: ['obsidian', 'electron'], plugins: [{ name: 'folio-assets', setup(build) { build.onResolve({ filter: /^folio-assets$/ }, () => ({ path: 'assets', namespace: 'folio' })); build.onLoad({ filter: /.*/, namespace: 'folio' }, () => ({ contents: 'export default ' + JSON.stringify(assets), loader: 'js' })); } }] });
await copyFile(root + 'manifest.json', output + '/manifest.json');
await copyFile(root + 'obsidian/styles.css', output + '/styles.css');
await copyFile(root + 'obsidian/README.md', output + '/README.md');
await copyFile(root + 'LICENSE', output + '/LICENSE');
await copyFile(root + 'PRIVACY.md', output + '/PRIVACY.md');
let licenses = '';
for (const pkg of ['parse5', 'entities', 'diff', 'smol-toml', 'markdown-it', 'markdown-it/node_modules/entities', 'argparse', 'linkify-it', 'mdurl', 'punycode.js', 'uc.micro']) {
  const { readdir } = await import('node:fs/promises');
  const dir = root + 'node_modules/' + pkg;
  const name = (await readdir(dir)).find(n => /^license/i.test(n));
  licenses += `\n===== ${pkg} =====\n` + await readFile(dir + '/' + name, 'utf8');
}
await writeFile(output + '/THIRD-PARTY-LICENSES.txt', licenses);
const zip = root + `dist/${manifest.id}-${manifest.version}.zip`;
// Fresh zip input list, never sweep local vaults or plugin state into a release.
const tempZip = root + `dist/${manifest.id}-${manifest.version}.tmp.zip`;
const { rm, rename } = await import('node:fs/promises');
await rm(tempZip, { force: true });
await exec('zip', ['-q', tempZip, ...['main.js','manifest.json','styles.css','README.md','LICENSE','PRIVACY.md','THIRD-PARTY-LICENSES.txt'].map(f => manifest.id+'/' + f)], { cwd: root + 'dist/obsidian' });
await rename(tempZip, zip);
await writeFile(zip + '.sha256', createHash('sha256').update(await readFile(zip)).digest('hex') + `  ${manifest.id}-${manifest.version}.zip\n`);
console.log(`插件包已生成：dist/${manifest.id}-${manifest.version}.zip`);
