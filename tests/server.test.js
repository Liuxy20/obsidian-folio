import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import http from 'node:http';
import {createApp} from '../server/index.js';
import {configOverrides} from '../server/codex.js';

test('批注 API：来源认证、重叠预检、批量生成、原文保护、取消',async()=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'folio-api-test-')); let calls=0, aborted=false;
 const {server,store}=await createApp({dataDir,status:async()=>({available:true,mode:'test'}),generate:({block,signal})=>new Promise(resolve=>{
   calls++; const timer=setTimeout(()=>resolve({html:block.html.replace('好的想法','清晰想法').replace('本周概览','本周重点'),summary:'测试建议'}),80);
   signal.addEventListener('abort',()=>{aborted=true;clearTimeout(timer);resolve({html:block.html,summary:'cancel'});});
 })});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const base=`http://127.0.0.1:${server.address().port}`;
 try {
  assert.equal((await fetch(base+'/api/documents')).status,403);
  assert.equal((await fetch(base+'/api/bootstrap',{headers:{Origin:'https://evil.example'}})).status,403);
  const hostStatus=await new Promise((resolve,reject)=>{http.get(base+'/api/bootstrap',{headers:{Host:'evil.example'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});assert.equal(hostStatus,403);
  const {token}=await(await fetch(base+'/api/bootstrap')).json();const headers={'x-folio-token':token,'content-type':'application/json'};
  const post=(route,data)=>fetch(base+'/api/'+route,{method:'POST',headers,body:JSON.stringify(data)});
  const [{id}]=await store.list();const doc=await store.get(id);const h1=doc.elements.find(e=>e.tag==='h1'),h2=doc.elements.find(e=>e.tag==='h2');
  const note=e=>({id:e.id,targetId:e.id,expected:e.html,version:doc.version,comment:'精简标题'});
  assert.equal((await post('proposals',{source:doc.source,annotations:[note(h1),note(doc.elements.find(e=>e.id===h1.parentId))]})).status,409);assert.equal(calls,0);
  const req={source:doc.source,annotations:[note(h1),note(h2)],preserveNumbers:true};
  const response=await post('proposals',req);assert.equal(response.status,202);const {id:jobId}=await response.json();
  assert.equal((await post('proposals',req)).status,409);
  let job;for(let i=0;i<50;i++){job=await(await fetch(base+'/api/proposals/'+jobId,{headers})).json();if(job.state!=='running')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(job.state,'done');assert.equal(job.changes.length,2);assert.match(job.changes[0].html,/清晰想法/);assert.equal((await store.get(id)).source,doc.source);
  const applied=await post('draft/replace',{source:doc.source,changes:job.changes,version:job.version});assert.equal(applied.status,200);
  assert.equal((await post('draft/replace',{source:doc.source+'\n',changes:job.changes,version:job.version})).status,409);
  const preview=await(await post('preview',{source:doc.source})).json();assert.match(preview.html,/FOLIO_CHANNEL/);assert.equal(preview.html.includes(token),false);
  const {id:next}=await(await post('proposals',req)).json();await post(`proposals/${next}/cancel`,{});assert.equal(aborted,true);
  assert.equal((await post('documents/import',{name:'x.html',source:'<script>alert(1)</script>'})).status,400);
 }finally{await new Promise(r=>server.close(r));await rm(dataDir,{recursive:true,force:true});}
});
test('Codex 覆盖仅用于子进程，不传递配置密钥',()=>{
 const overrides=configOverrides();assert.ok(overrides.includes('mcp_servers={}'));assert.ok(overrides.includes('plugins={}'));assert.ok(overrides.includes('features.shell_tool=false'));
});
