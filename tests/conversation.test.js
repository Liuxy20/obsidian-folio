import test from 'node:test';
import assert from 'node:assert/strict';
import { isSentInput, chronologicalRecords } from '../obsidian/conversation.js';
const capture={path:'synthetic.md',version:'v1',start:10,end:20,expected:'合成原文'};
const answered={id:'a',capture,message:'解释这段',mode:'ask',state:'answered',result:{answer:'合成回答',citations:[]},date:100};
const draft={capture,message:answered.message,mode:'ask'};
test('sent text left in legacy composer is not a new draft; unsent or different targets are preserved',()=>{
  assert.equal(isSentInput(draft,[answered]),true);
  assert.equal(isSentInput({...draft,message:'另一个问题'},[answered]),false);
  assert.equal(isSentInput({...draft,mode:'edit'},[answered]),false);
  for(const key of ['path','version','start','end','expected'])assert.equal(isSentInput({...draft,capture:{...capture,[key]:'changed'}},[answered]),false);
  assert.equal(isSentInput(draft,[{...answered,result:null,state:'draft'}]),false);
});
test('already answered history is recognized only at its exact saved capture',()=>{
  const moved={...answered,capture:{...capture,version:'v2'},message:'追问',turns:[answered]};
  assert.equal(isSentInput(draft,[moved]),true);
  assert.equal(isSentInput({...draft,capture:{...capture,path:'other.md'}},[moved]),false);
});
test('threads render oldest first without moving an old thread after a new reply',()=>{
  const a={...answered,createdAt:100,date:500},b={id:'b',date:300},c={id:'c',date:400};
  const records=[a,c,b];assert.deepEqual(chronologicalRecords(records).map(r=>r.id),['a','b','c']);
  assert.deepEqual(records.map(r=>r.id),['a','c','b']);
  assert.deepEqual(chronologicalRecords([{id:'new',date:100},{id:'old',date:100}]).map(r=>r.id),['old','new']);
});
