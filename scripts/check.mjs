import { readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);
for(const directory of ['obsidian','server','public','scripts','tests'])for(const file of await readdir(directory))if(/\.(?:js|mjs)$/.test(file))await exec(process.execPath,['--check',directory+'/'+file]);
console.log('JavaScript syntax checks passed.');
