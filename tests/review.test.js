import test from 'node:test';
import assert from 'node:assert/strict';
import { captureNote } from '../obsidian/notes.js';
import { relocateCapture, planNoteChanges, validateReview, conversationHistory, recordCapture, reviewContext } from '../obsidian/review.js';
import { ReviewStore } from '../obsidian/review-store.js';
import { PluginState } from '../obsidian/vault-store.js';
import { notePrompt, reviewPrompt } from '../server/codex.js';
const path='review.md', source='# 合成方案\n\n第一段需要精简。\n\n第二段需要补充说明。\n';
const make=(id,text,replacement,s=source)=>({id,capture:captureNote(path,s,s.indexOf(text),s.indexOf(text)+text.length),mode:'edit',message:'修改 '+id,state:'ready',preserveNumbers:true,result:{replacement,summary:'合成修改'}});
async function fixture(){
  const bodies=new Map([[path,source]]),files=new Map([[path,{path,extension:'md'}]]);
  const adapter={mkdir:async()=>{},exists:async p=>bodies.has(p),read:async p=>{if(!bodies.has(p))throw Error('missing');return bodies.get(p);},write:async(p,v)=>bodies.set(p,v)};
  const vault={adapter,getAbstractFileByPath:p=>files.get(p),read:async f=>bodies.get(f.path),process:async(f,fn)=>bodies.set(f.path,fn(bodies.get(f.path)))};
  const state=new PluginState(adapter,'.plugin');await state.init();const store=new ReviewStore(vault,state,'.plugin');
  const a=make('a','第一段需要精简。','第一段。'),b=make('b','第二段需要补充说明。','第二段的说明。');
  await store.record(path,a);await store.record(path,b);return {store,state,vault,bodies,files,a,b};
}
test('quote anchors follow unique text, preserve CRLF, reject removed or ambiguous duplicates',()=>{
  const c=make('a','第一段需要精简。','x').capture;
  assert.equal(relocateCapture(c,'前言\n'+source).start,c.start+3);
  assert.throws(()=>relocateCapture(c,source.replace(c.expected,'全新段落')),/已改变/);
  const duplicate='同样。\n同样。',d=captureNote(path,duplicate,0,3);
  assert.throws(()=>relocateCapture(d,'同样。'),/匹配/);
  const legacy={...d};delete legacy.prefix;delete legacy.suffix;
  assert.throws(()=>relocateCapture(legacy,duplicate+'\n'),/匹配/);
  delete legacy.ambiguous;
  assert.throws(()=>relocateCapture(legacy,'同样。'),/匹配/);
  const crlf=source.replaceAll('\n','\r\n');const e=make('a','第一段需要精简。','x',crlf).capture;
  assert.equal(relocateCapture(e,'前言\r\n'+crlf).newline,'\r\n');
  assert.throws(()=>recordCapture({...make('a','第一段需要精简。','x'),removed:true},source),/删除/);
});
test('revision plans reject overlap, duplicates and wrong modes; selected edits preserve everything else',()=>{
  const a=make('a','第一段需要精简。','第一段。'),b=make('b','第二段需要补充说明。','第二段。');
  const plan=planNoteChanges(source,[b,a]);assert.equal(plan.next,source.replace(a.capture.expected,'第一段。').replace(b.capture.expected,'第二段。'));
  assert.equal(plan.changes[1].anchor.expected,'第二段。');assert.equal(plan.next.slice(plan.changes[1].anchor.start,plan.changes[1].anchor.end),'第二段。');
  assert.throws(()=>planNoteChanges(source,[a,a]),/重复/);
  assert.throws(()=>planNoteChanges(source,[a,{...a,id:'overlap'}]),/重叠/);
  assert.throws(()=>planNoteChanges(source,[{...a,mode:'ask'}]));
  assert.equal(planNoteChanges(source,[{...a,result:{replacement:'',summary:'删除'}}]).changes[0].anchor,null);
});
test('two revisions share one backup and undo; a partially accepted batch leaves other suggestions usable',async()=>{
  const {store,bodies,a,b}=await fixture();const plan=await store.preview([a,b]);
  const changes=await store.applyBatch([a,b],plan.version);assert.equal(bodies.get(path),plan.next);assert.equal(changes[0].backup,changes[1].backup);
  await store.undoBatch(path);assert.equal(bodies.get(path),source);
  const second=await fixture();let preview=await second.store.preview([second.a]);await second.store.applyBatch([second.a],preview.version);
  preview=await second.store.preview([second.b]);await second.store.applyBatch([second.b],preview.version);
  assert.match(second.bodies.get(path),/第一段。/);assert.match(second.bodies.get(path),/第二段的说明。/);
  await second.store.undoBatch(path);assert.match(second.bodies.get(path),/第一段。/);assert.match(second.bodies.get(path),/第二段需要补充说明。/);
});
test('preview version, changed proposals, editor changes and write-time conflicts never overwrite',async()=>{
  const f=await fixture(),p=await f.store.preview([f.a]);f.bodies.set(path,source+'外部修改');
  await assert.rejects(f.store.applyBatch([f.a],p.version),/预览后/);assert.match(f.bodies.get(path),/外部修改/);
  f.bodies.set(path,source);await assert.rejects(f.store.applyBatch([f.a],p.version,()=>{throw Error('编辑器更新');}),/编辑器更新/);
  await f.store.record(path,{...f.a,message:'新意见'});await assert.rejects(f.store.applyBatch([f.a],p.version),/建议已更新/);
  await f.store.record(path,f.a);const process=f.vault.process;f.vault.process=async(file,fn)=>{f.bodies.set(path,source+'并发');return process(file,fn);};
  await assert.rejects(f.store.applyBatch([f.a],p.version),/外部修改/);assert.equal(f.state.data.notes[path].pendingBatch,undefined);assert.match(f.bodies.get(path),/并发/);
});
test('failed backup or prepare prevents writes; failed final state commit recovers after reopening',async()=>{
  for(const failure of ['backup','prepare']){
    const f=await fixture(),p=await f.store.preview([f.a]);const write=f.vault.adapter.write;
    f.vault.adapter.write=async(name,value)=>{if(failure==='backup'&&name.includes('note-history')||failure==='prepare'&&name.endsWith('state.json'))throw Error('disk full');return write(name,value);};
    await assert.rejects(f.store.applyBatch([f.a],p.version));assert.equal(f.bodies.get(path),source);
  }
  const f=await fixture(),p=await f.store.preview([f.a]);const write=f.vault.adapter.write;let failed=false;
  f.vault.adapter.write=async(name,value)=>{if(!failed&&name.endsWith('state.json')&&f.bodies.get(path)!==source){failed=true;f.bodies.set(name,'{');throw Error('interrupted');}return write(name,value);};
  await assert.rejects(f.store.applyBatch([f.a],p.version));assert.equal(f.bodies.get(path),p.next);
  const state=new PluginState(f.vault.adapter,'.plugin');await state.init();assert.equal(state.recovered,true);
  const recovered=new ReviewStore(f.vault,state,'.plugin');const thread=await recovered.thread(path);assert.equal(thread.records.find(r=>r.id==='a').state,'applied');assert.equal(thread.pendingBatch,undefined);
  await recovered.undoBatch(path);assert.equal(f.bodies.get(path),source);
});
test('rename keeps discussions, draft, and batch undo; existing target discussions are never overwritten',async()=>{
  const f=await fixture();await f.store.draft(path,{capture:f.a.capture,message:'追问',replyId:'a'});
  const p=await f.store.preview([f.a]);await f.store.applyBatch([f.a],p.version);
  const file=f.files.get(path);f.files.delete(path);file.path='moved.md';f.files.set(file.path,file);f.bodies.set(file.path,f.bodies.get(path));
  await f.store.rename(path,file.path);const thread=await f.store.thread(file.path);assert.equal(thread.draft.replyId,'a');assert.equal(thread.records[0].capture.path,file.path);
  await f.store.undoBatch(file.path);assert.equal(f.bodies.get(file.path),source);
  await f.store.rename(file.path,file.path);
  f.files.set('target.md',{path:'target.md',extension:'md'});f.bodies.set('target.md',source);
  await f.store.record('target.md',{...f.b,capture:{...f.b.capture,path:'target.md'}});
  const before=structuredClone(f.state.data.notes);
  await assert.rejects(f.store.rename(file.path,'target.md'),/已有留言/);
  assert.deepEqual(f.state.data.notes,before);
});
test('review results require real exact quotes and line ranges; no invented citations or duplicate issues',()=>{
  const issue={quote:'第一段需要精简。',startLine:3,endLine:3,title:'可以更具体',comment:'说明要精简什么。',category:'clarity'};
  assert.equal(validateReview({issues:[issue]},path,source)[0].capture.expected,issue.quote);
  for(const bad of [{...issue,quote:'不存在的句子'},{...issue,startLine:99,endLine:99},{...issue,category:'made-up'}])assert.throws(()=>validateReview({issues:[bad]},path,source));
  assert.throws(()=>validateReview({issues:[issue,issue]},path,source));assert.equal(validateReview({issues:[]},path,source).length,0);
  assert.throws(()=>reviewContext('文'.repeat(21000)),/60 KB/);assert.match(reviewPrompt(source,'审稿'),/cannot fact-check/);
});
test('follow-up context includes only bounded thread history, not paths or saved captures',()=>{
  const record={turns:Array.from({length:20},(_,i)=>({message:'问'+i,mode:'ask',result:{answer:'答'+i},capture:{path:'do-not-send.md'}})),message:'最后一问',mode:'ask',result:{answer:'最后的回答'}};
  const history=conversationHistory(record);assert.equal(history.length,8);assert.equal(history.at(-1).response,'最后的回答');assert.doesNotMatch(JSON.stringify(history),/do-not-send/);
  const prompt=notePrompt({capture:make('a','第一段需要精简。','x').capture,mode:'ask',instruction:'再解释',history});assert.match(prompt,/最后的回答/);assert.match(prompt,/untrusted data/);
  record.turns=Array.from({length:8},()=>({message:'问',result:{answer:'长'.repeat(5000)}}));assert.ok(Buffer.byteLength(JSON.stringify(conversationHistory(record)))<17000);
});
