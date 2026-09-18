import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { findingsFor, scanPublic } from '../scripts/scan-public.mjs';

test('Public scan reports positions and rule names without exposing matched secrets',()=>{
  const value=['sample','credential','for','test'].join('-');
  const findings=findingsFor('first line\n'+value,[value]);
  assert.deepEqual(findings,[{line:2,rule:'local-credential-match'}]);
  assert.equal(JSON.stringify(findings).includes(value),false);
  assert.equal(findingsFor('sk-'+ 'x'.repeat(32))[0].rule,'credential-pattern');
  assert.equal(findingsFor('/Users/'+'test-person/private')[0].rule,'personal-path');
  assert.deepEqual(findingsFor('/Users/example/test.html'),[]);
});

test('Public scan rejects local state and unreviewed binary files',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'folio-public-scan-'));
  try{
    await writeFile(path.join(root,'state.json'),'{}');
    await writeFile(path.join(root,'image.png'),Buffer.from([0,1,2]));
    const report=await scanPublic(root);
    assert.deepEqual(report.findings.map(x=>x.rule).sort(),['private-state-file','unreviewed-binary']);
  }finally{await rm(root,{recursive:true,force:true});}
});
