import { mkdir, readdir, lstat, copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanPublic } from './scan-public.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const draft=process.argv.includes('--draft');
const selectedLicense=draft?'UNLICENSED':process.env.FOLIO_PUBLIC_LICENSE;
if(!draft&&!['MIT','Apache-2.0'].includes(selectedLicense))throw new Error('Set FOLIO_PUBLIC_LICENSE to the explicitly chosen license before final export.');
const output=path.join(root,draft?'.public-preview':'.public-release');
// A fresh directory is required. Never copy git history, a vault, configuration,
// caches or screenshots from a development workspace into a public repository.
await mkdir(output);
async function copy(relative){
  const from=path.join(root,relative),to=path.join(output,relative),stat=await lstat(from);
  if(stat.isSymbolicLink())throw new Error('Public inputs cannot be symbolic links.');
  if(stat.isDirectory()){
    await mkdir(to,{recursive:true});
    for(const entry of await readdir(from)){if(entry.startsWith('.'))throw new Error('Unexpected hidden public input.');await copy(path.join(relative,entry));}
  }else if(stat.isFile()){await mkdir(path.dirname(to),{recursive:true});await copyFile(from,to);}
}
const files=['README.md','PRIVACY.md','SECURITY.md','LICENSE','CHANGELOG.md','manifest.json','versions.json','.gitignore','obsidian','server','public','examples','scripts/build-obsidian.mjs','scripts/scan-public.mjs','scripts/prepare-public.mjs','scripts/check.mjs','.github/workflows/ci.yml'];
for(const file of files)if(!draft||file!=='LICENSE')await copy(file);
for(const name of await readdir(path.join(root,'tests'))){if(name.endsWith('.test.js')||['browser.mjs','recovery-browser.mjs','obsidian-live.mjs','codex-smoke.mjs','image-fixtures.js'].includes(name))await copy('tests/'+name);}
const manifest=JSON.parse(await readFile(path.join(root,'manifest.json'),'utf8'));
const original=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const pkg={name:'obsidian-folio',version:manifest.version,private:true,type:'module',description:'Inline Markdown and HTML comments, questions and reviewed Codex edits in Obsidian.',license:selectedLicense,repository:{type:'git',url:'https://github.com/Liuxy20/obsidian-folio.git'},engines:original.engines,scripts:{start:'node server/index.js',test:'node --test tests/*.test.js',check:'node scripts/check.mjs','test:browser':'node tests/browser.mjs','test:recovery':'node tests/recovery-browser.mjs','test:codex':'node tests/codex-smoke.mjs','test:obsidian:live':'node tests/obsidian-live.mjs','build:obsidian':'node scripts/build-obsidian.mjs','check:privacy':'node scripts/scan-public.mjs .'},dependencies:original.dependencies,devDependencies:original.devDependencies};
const lock=JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8'));
lock.name=pkg.name;lock.version=pkg.version;Object.assign(lock.packages[''],{name:pkg.name,version:pkg.version,license:pkg.license});
await writeFile(path.join(output,'package.json'),JSON.stringify(pkg,null,2)+'\n');
await writeFile(path.join(output,'package-lock.json'),JSON.stringify(lock,null,2)+'\n');
const report=await scanPublic(output,{compareLocal:true});
console.log(JSON.stringify(report,null,2));
if(report.findings.length)process.exitCode=1;
