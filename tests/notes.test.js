import test from 'node:test';
import assert from 'node:assert/strict';
import {captureNote,captureSection,validateNoteResult,NoteStore} from '../obsidian/notes.js';
import {PluginState} from '../obsidian/vault-store.js';
import {notePrompt} from '../server/codex.js';
const path='测试/笔记.md';
const sample='---\r\ntags: [测试]\r\n---\r\n\r\n# 项目\r\n\r\n同样的文字。\r\n\r\n同样的文字。\r\n已完成 12 项。\r\n\r\n> [!note] 说明\r\n> 关联 [[另一笔记]]。\r\n';
test('阅读视图 section 映射：按行定位重复段落、保留 CRLF、拒绝过期 DOM 和无效范围',()=>{
  const c=captureSection(path,sample,{text:sample.replace(/\r\n/g,'\n'),lineStart:8,lineEnd:9});
  assert.equal(c.start,sample.lastIndexOf('同样的文字。'));assert.equal(c.expected,'同样的文字。\r\n已完成 12 项。');
  assert.throws(()=>captureSection(path,sample+'外部变更',{text:sample,lineStart:8,lineEnd:9}),/发生变化/);
  assert.throws(()=>captureSection(path,sample,null),/无法定位/);
  assert.throws(()=>captureSection(path,sample,{text:sample,lineStart:100,lineEnd:110}),/位置已改变/);
});
test('Markdown 选区：重复文字、CRLF、默认段落、上下文行号及长度',()=>{
  const start=sample.lastIndexOf('同样的文字'),c=captureNote(path,sample,start,start+6);
  assert.equal(c.expected,'同样的文字。');assert.equal(c.startLine,9);assert.equal(c.newline,'\r\n');
  const paragraph=captureNote(path,sample,start+1);assert.equal(paragraph.expected,'同样的文字。\r\n已完成 12 项。');
  assert.equal(c.context[0].line,1);assert.equal(c.partial,false);
  assert.throws(()=>captureNote(path,sample,1,-1));assert.throws(()=>captureNote(path,'\n\n',0));
  const long=Array.from({length:3000},(_,i)=>`第 ${i} 行，相关信息。`).join('\n');const mid=long.indexOf('第 1500 行');
  const scoped=captureNote(path,long,mid,mid+7);assert.equal(scoped.partial,true);assert.ok(scoped.context[0].line<1501);assert.ok(scoped.context.at(-1).line>1501);assert.ok(JSON.stringify(scoped.context).length<40_000);
});
test('修改与问答校验：数字保护、换行保留、引用不得指向未提供内容',()=>{
  const start=sample.indexOf('已完成');const c=captureNote(path,sample,start,start+9);
  assert.throws(()=>validateNoteResult({replacement:'已完成 13 项。',summary:'调整'},c,'edit',true),/数字/);
  assert.equal(validateNoteResult({replacement:'已完成 12 项。\n继续。',summary:'拆行'},c,'edit',true).replacement,'已完成 12 项。\r\n继续。');
  assert.throws(()=>validateNoteResult({answer:'答案',citations:[{startLine:999,endLine:1000}]},c,'ask'),/未提供/);
  assert.equal(validateNoteResult({answer:'根据第 10 行，完成了 12 项。',citations:[{startLine:10,endLine:10}]},c,'ask').citations.length,1);
  const prompt=notePrompt({capture:c,mode:'ask',instruction:'完成多少项？'});assert.match(prompt,/untrusted data/);assert.match(prompt,/do not return replacement/);assert.doesNotMatch(prompt,/测试\/笔记.md/);
});
function fixture(){
  const bodies=new Map([[path,sample]]),file={path,extension:'md'},files=new Map([[path,file]]);
  const adapter={mkdir:async()=>{},exists:async p=>bodies.has(p),read:async p=>{if(!bodies.has(p))throw Error('missing');return bodies.get(p);},write:async(p,s)=>{bodies.set(p,s);}};
  const vault={adapter,getAbstractFileByPath:p=>files.get(p),read:async f=>bodies.get(f.path),process:async(f,fn)=>{const s=fn(bodies.get(f.path));bodies.set(f.path,s);return s;}};
  const state=new PluginState(adapter,'.obsidian/plugins/folio'),store=new NoteStore(vault,state,'.obsidian/plugins/folio');
  return {vault,state,store,bodies,file};
}
test('Markdown 保存只改选区，问答不写文件，外部修改与移动阻止覆盖，备份撤销',async()=>{
  const {vault,store,bodies,file}=fixture(),start=sample.lastIndexOf('同样的文字');
  const capture=captureNote(path,sample,start,start+6),record={id:'test',capture,mode:'edit',state:'ready',preserveNumbers:true,result:{replacement:'更清楚的表达。',summary:'精简'}};
  await assert.rejects(store.apply({...record,mode:'ask'}));assert.equal(bodies.get(path),sample);
  const applied=await store.apply(record);assert.equal(bodies.get(path),sample.slice(0,start)+'更清楚的表达。'+sample.slice(start+6));assert.equal(bodies.get(applied.backup),sample);
  await store.undo(applied);assert.equal(bodies.get(path),sample);
  bodies.set(path,sample+'外部修改');await assert.rejects(store.apply(record),/已改变/);bodies.set(path,sample);
  await assert.rejects(store.apply(record,()=>{throw new Error('编辑器有更新');}),/编辑器有更新/);assert.equal(bodies.get(path),sample);
  const process=vault.process;vault.process=async(f,fn)=>{bodies.set(path,sample+'并发');return process(f,fn);};await assert.rejects(store.apply(record),/外部修改/);
  vault.process=process;bodies.set(path,sample);file.path='移动.md';await assert.rejects(store.apply(record),/已移动/);
});
test('Markdown 留言和结果持久化，HTML 状态不丢失，磁盘失败不确认',async()=>{
  const {state,store,vault}=fixture();await state.init();await state.request('storage/set',{key:'folio.test',value:'HTML 状态'});
  const capture=captureNote(path,sample,sample.indexOf('同样'),sample.indexOf('同样')+6);
  await store.draft(path,{capture,mode:'ask',message:'解释一下'});await store.record(path,{id:'q',capture,mode:'ask',state:'answered',result:{answer:'说明',citations:[]}});
  const next=new PluginState(vault.adapter,'.obsidian/plugins/folio');await next.init();const restored=new NoteStore(vault,next,'.obsidian/plugins/folio');
  assert.equal((await restored.thread(path)).draft.message,'解释一下');assert.equal((await restored.thread(path)).records[0].result.answer,'说明');assert.equal((await next.request('storage/get'))['folio.test'],'HTML 状态');
  vault.adapter.write=async()=>{throw Error('disk full');};await assert.rejects(restored.draft(path,{message:'失败'}));assert.equal((await restored.thread(path)).draft.message,'解释一下');
});
