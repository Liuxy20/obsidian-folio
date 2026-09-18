import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { parse } from 'smol-toml';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Never report the matched content. Findings contain only relative filenames,
// line numbers and rule names. Local credential values never leave memory.
export function findingsFor(text,known=[]){
  const findings=[];
  const rules=[
    ['credential-pattern',/\b(?:sk-[a-zA-Z0-9_-]{20,}|gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/],
    ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['jwt-token',/\beyJ[a-zA-Z0-9_-]{15,}\.eyJ[a-zA-Z0-9_-]{15,}\.[a-zA-Z0-9_-]{15,}\b/],
    ['personal-path',/(?:\/Users\/|\/home\/)(?!example(?:\/|\b))[^\s/"'<>]+/],
    ['url-credentials',/https?:\/\/[^\s/@:]+:[^\s/@]+@/],
  ];
  for(const [index,line]of text.split('\n').entries()){
    for(const [rule,pattern]of rules)if(pattern.test(line))findings.push({line:index+1,rule});
    if(known.some(value=>line.includes(value)))findings.push({line:index+1,rule:'local-credential-match'});
  }
  return findings;
}

async function localCredentials(){
  const values=new Set();
  const add=value=>{if(typeof value==='string'&&value.length>=12&&!/^[A-Z][A-Z0-9_]+$/.test(value)){values.add(value);values.add(Buffer.from(value).toString('base64'));}};
  const walk=(value,parent='')=>{if(value&&typeof value==='object')for(const [key,child]of Object.entries(value)){if(typeof child==='string'&&/key|token|secret|password|authorization/i.test(key+' '+parent))add(child);else walk(child,key);}};
  for(const [key,value]of Object.entries(process.env))if(/key|token|secret|password|authorization/i.test(key))add(value);
  const homes=new Set([path.join(homedir(),'.codex'),process.env.CODEX_HOME].filter(Boolean));
  for(const home of homes)for(const name of ['auth.json','config.toml']){
    try{const text=await readFile(path.join(home,name),'utf8');walk(name.endsWith('.toml')?parse(text):JSON.parse(text));}catch(error){if(error.code!=='ENOENT')throw new Error('Local credential comparison could not complete; no contents were printed.');}
  }
  return [...values];
}

export async function scanPublic(root,{compareLocal=false}={}){
  root=await realpath(root);const known=compareLocal?await localCredentials():[],findings=[];let count=0,syntheticExceptions=0;
  const forbidden=/^(?:\.env(?:\..*)?|\.npmrc|\.codex|auth\.json|config\.toml|state(?:\.previous)?\.json|data\.json|\.test-vault|\.test-profile|\.folio|test-results)$/;
  async function visit(directory){
    for(const entry of await readdir(directory,{withFileTypes:true})){
      if(entry.name==='.git'||entry.name==='node_modules'||entry.name==='dist')continue;
      const absolute=path.join(directory,entry.name),file=path.relative(root,absolute);
      const stat=await lstat(absolute);
      if(stat.isSymbolicLink()){findings.push({file,rule:'symlink'});continue;}
      if(forbidden.test(entry.name)){findings.push({file,rule:'private-state-file'});continue;}
      if(stat.isDirectory()){await visit(absolute);continue;}
      if(!stat.isFile())continue;
      const bytes=await readFile(absolute);count++;
      if(bytes.includes(0)){findings.push({file,rule:'unreviewed-binary'});continue;}
      const text=bytes.toString('utf8');
      for(const finding of findingsFor(text,known)){
        // Exact audited fixture: intentionally invalid login URL for an
        // in-process loopback image server. Any edit invalidates this exception.
        const fixture=file==='tests/images.test.js'&&finding.rule==='url-credentials'&&createHash('sha256').update(text.split('\n')[finding.line-1]).digest('hex')==='a33b95339b898a30a6005dc7b99d44fffcfd95310b04251321482e7905d153bb';
        if(fixture)syntheticExceptions++;else findings.push({file,...finding});
      }
    }
  }
  await visit(root);return {filesScanned:count,localCredentialComparison:compareLocal,syntheticExceptions,findings};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const report=await scanPublic(process.argv[2]||'.',{compareLocal:process.argv.includes('--compare-local')});console.log(JSON.stringify(report,null,2));if(report.findings.length)process.exitCode=1;}
  catch{console.error('Privacy scan failed; no file contents or credential values were printed.');process.exitCode=1;}
}
