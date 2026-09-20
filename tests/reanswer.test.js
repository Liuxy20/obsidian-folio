import test from 'node:test';
import assert from 'node:assert/strict';
import { latestAnswer, reanswerMessage } from '../obsidian/reanswer.js';
import { inlineDraft } from '../obsidian/answer-quote.js';
import { previousTurns } from '../obsidian/conversation.js';

const answered={mode:'ask',message:'这段话是什么意思？',result:{answer:'第一份回答',citations:[]}};

test('reanswer keeps a completed answer available after a stopped attempt and rejects edit-only threads',()=>{
  const stopped={mode:'ask',state:'cancelled',turns:previousTurns(answered)};
  assert.equal(latestAnswer(stopped).result.answer,'第一份回答');
  assert.match(reanswerMessage(stopped,'用一个例子解释'),/调整要求：用一个例子解释/);
  assert.match(reanswerMessage(answered),/不修改笔记原文/);
  const edited={mode:'edit',result:{replacement:'修改后的原文'},turns:previousTurns(answered)};
  assert.equal(latestAnswer(edited),null);
  assert.throws(()=>reanswerMessage(edited),/没有可重答/);
});

test('reanswer rejects missing context and oversized instructions instead of sending an ambiguous request',()=>{
  assert.throws(()=>reanswerMessage(null),/没有可重答/);
  assert.throws(()=>reanswerMessage(answered,'字'.repeat(2000)),/要求过长/);
  assert.throws(()=>reanswerMessage({...answered,message:'字'.repeat(2000),result:{answer:'字'.repeat(5000)}}),/上下文过长/);
});

test('reanswer drafts retain their mode without changing legacy ask and edit drafts',()=>{
  const draft={mode:'reanswer',text:'更简洁',quote:null,preserveNumbers:true};
  assert.deepEqual(inlineDraft(draft),draft);
  assert.equal(inlineDraft('旧问题').mode,'ask');
  assert.equal(inlineDraft({mode:'edit'}).mode,'edit');
});
