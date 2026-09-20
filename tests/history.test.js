import test from 'node:test';
import assert from 'node:assert/strict';
import { NoteStore, captureNote } from '../obsidian/notes.js';
import { PluginState } from '../obsidian/vault-store.js';
import { historyPage, previousTurns, discussionMarkdown } from '../obsidian/conversation.js';
import { conversationHistory } from '../obsidian/review.js';

function fixture(){
  const path='资料/示例 (A) #1.md',source='这是合成原文。';
  const files=new Map([['资料',{path:'资料',children:[]}],[path,{path,extension:'md'}]]),bodies=new Map([[path,source]]);
  const adapter={mkdir:async()=>{},exists:async p=>bodies.has(p),read:async p=>bodies.get(p),write:async(p,s)=>{bodies.set(p,s);}};
  const vault={adapter,getAbstractFileByPath:p=>files.get(p),createFolder:async p=>{if(files.has(p))throw Error('exists');files.set(p,{path:p,children:[]});},create:async(p,s)=>{if(files.has(p))throw Error('exists');const f={path:p,extension:'md'};files.set(p,f);bodies.set(p,s);return f;}};
  const state=new PluginState(adapter,'.synthetic'),store=new NoteStore(vault,state,'.synthetic');
  const capture=captureNote(path,source,0,source.length);
  return {path,source,vault,bodies,state,store,capture};
}

test('65 discussions survive updates, state reload, and display paging without silent deletion',async()=>{
  const {path,vault,state,store,capture}=fixture();await state.init();
  for(let i=1;i<=65;i++)await store.record(path,{id:'r'+i,capture,message:'问题 '+i,date:i,mode:'ask',state:'answered',result:{answer:'回答 '+i,citations:[]}});
  await store.record(path,{...(await store.thread(path)).records.find(r=>r.id==='r1'),createdAt:1,date:100});
  const reopened=new PluginState(vault.adapter,'.synthetic');await reopened.init();
  const records=(await new NoteStore(vault,reopened,'.synthetic').thread(path)).records;
  assert.equal(records.length,65);assert.equal(records.find(r=>r.id==='r1').result.answer,'回答 1');
  const first=historyPage(records),second=historyPage(records,60),all=historyPage(records,90);
  assert.equal(first.remaining,35);assert.deepEqual(first.records.map(r=>r.id),Array.from({length:30},(_,i)=>'r'+(i+36)));
  assert.equal(second.remaining,5);assert.equal(all.records[0].id,'r1');assert.equal(all.records.at(-1).id,'r65');assert.equal(all.total,65);
});

test('12 answered rounds survive reopen; model still receives at most 8 bounded rounds without captures',async()=>{
  const {path,vault,state,store,capture}=fixture();await state.init();let record;
  for(let i=1;i<=12;i++){
    record={id:'thread',capture,turns:previousTurns(record),mode:'ask',message:'第 '+i+' 轮',date:i,result:{answer:'合成回答 '+i,citations:[]},state:'answered'};
    await store.record(path,record);
  }
  const reopened=new PluginState(vault.adapter,'.synthetic');await reopened.init();
  const saved=(await new NoteStore(vault,reopened,'.synthetic').thread(path)).records[0];
  assert.equal(saved.turns.length,11);assert.equal(saved.turns[0].message,'第 1 轮');
  assert.equal(saved.message,'第 12 轮');const context=conversationHistory(saved);
  assert.equal(context.length,8);assert.equal(context[0].message,'第 5 轮');assert.doesNotMatch(JSON.stringify(context),/示例|capture|context|version/);
  assert.ok(Buffer.byteLength(JSON.stringify(conversationHistory({...saved,turns:saved.turns.map(t=>({...t,result:{answer:'长'.repeat(5000)}}))})))<17000);
  const reattached=previousTurns(saved);assert.equal(reattached.length,12);assert.equal(reattached[11].capture.path,path);
});

test('export includes complete ordered discussion and exact snapshots without overwriting or leaking state',async()=>{
  const {path,source,bodies,state,store,capture}=fixture();await state.init();
  const record={id:'thread',capture,mode:'ask',message:'现在的问题',result:{answer:'现在的回答',citations:[{startLine:1,endLine:1}]},turns:[{capture,mode:'edit',message:'最初的问题',result:{replacement:'建议原文',summary:'修改说明'}}]};
  await store.record(path,record);await store.draft(path,{message:'尚未发送的私有草稿'});
  const a=await store.exportDiscussion(path,'thread'),b=await store.exportDiscussion(path,'thread');
  assert.notEqual(a.path,b.path);assert.equal(bodies.get(path),source);
  const content=bodies.get(a.path);assert.ok(content.indexOf('最初的问题')<content.indexOf('现在的问题'));
  assert.ok(content.includes(source));assert.match(content,/引用原笔记：第 1–1 行/);assert.doesNotMatch(content,/尚未发送的私有草稿|state\.json/);
  assert.ok(content.includes('%28A%29%20%231.md'));
  await assert.rejects(store.exportDiscussion(path,'missing'),/不存在/);
});

test('display preferences survive reload without mutating discussion data or the original note',async()=>{
  const {path,source,bodies,state,store,vault,capture}=fixture();await state.init();
  const record={id:'r',capture,message:'合成问题',mode:'ask'};await store.record(path,record);
  await store.display(path,'r',{open:true,historyOpen:false,message:'must not persist'});
  const reopened=new PluginState(vault.adapter,'.synthetic');await reopened.init();
  assert.deepEqual(reopened.data.notes[path].display.r,{open:true,historyOpen:false});
  assert.deepEqual(reopened.data.notes[path].records,[record]);assert.equal(bodies.get(path),source);
});

test('export quotes active Markdown as literal text, including nested fences',()=>{
  const payload='![image](https://example.com/a.png)\n```dataviewjs\nactiveCode()\n```\n<iframe src="example"></iframe>';
  const md=discussionMarkdown({capture:{path:'x.md',expected:payload,startLine:1,endLine:1},mode:'ask',message:'合成',result:{answer:payload}});
  assert.ok(md.includes('````text\n'+payload+'\n````'));
});

test('custom export directory creates nested folders, preserves source links and refuses overwrites',async()=>{
 const {path,vault,state,store,capture,bodies,source}=fixture();await state.init();
 await store.record(path,{id:'r',capture,mode:'ask',message:'问题',result:{answer:'回答',citations:[]}});
 const target='Folio/讨论/自定义.md';await store.exportDiscussion(path,'r',target);
 assert.ok(Array.isArray(vault.getAbstractFileByPath('Folio/讨论').children));
 assert.match(bodies.get(target),/\.\/\.\.\/\.\.\/.*%28A%29%20%231.md/);
 await assert.rejects(store.exportDiscussion(path,'r',target),/同名文件/);
 await assert.rejects(store.exportDiscussion(path,'r',path),/同名文件/);
 await assert.rejects(store.exportDiscussion(path,'r','资料/示例 (A) #1.md/child.md'),/同名文件/);
 for(const target of ['../out.md','/tmp/out.md','.obsidian/x.md','a/../out.md','a\\b.md'])await assert.rejects(store.exportDiscussion(path,'r',target));
 assert.equal(bodies.get(path),source);
 const root=await store.exportDiscussion(path,'r','根目录导出.md');assert.match(bodies.get(root.path),/\.\/%E8%B5%84%E6%96%99\//);
});
