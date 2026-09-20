import test from 'node:test';
import assert from 'node:assert/strict';
import {createAnswerQuote,validateAnswerQuote,inlineDraft} from '../obsidian/answer-quote.js';
import {previousTurns,discussionMarkdown,isSentInput} from '../obsidian/conversation.js';
import {conversationHistory} from '../obsidian/review.js';
import {notePrompt} from '../server/codex.js';
const capture={path:'synthetic.md',version:'v1',start:0,end:2,expected:'原文',startLine:1,endLine:1,context:[{line:1,text:'原文'}]};
const record={id:'thread',capture,mode:'ask',message:'问题',result:{answer:'建议采用 **方案 A**。\n\n下一步验证。',citations:[]}};

test('quotes use rendered answer text across Markdown spans and reject wrong, oversized or changed answers',()=>{
 const q=createAnswerQuote(record,0,'建议采用 方案 A。');assert.equal(q.turnIndex,0);assert.deepEqual(validateAnswerQuote(record,q),q);
 assert.throws(()=>createAnswerQuote(record,0,'原文'),/已变化/);
 assert.throws(()=>createAnswerQuote(record,-1,'建议'),/已变化/);
 assert.throws(()=>createAnswerQuote(record,0,'字'.repeat(2001)),/2000/);
 assert.throws(()=>validateAnswerQuote({...record,id:'another'},q),/当前讨论/);
 assert.throws(()=>validateAnswerQuote({...record,result:{answer:record.result.answer+' changed'}},q),/原回答已变化/);
});
test('a quoted answer remains identifiable beyond context limits and through history/export',()=>{
 const q=createAnswerQuote(record,0,'方案 A');let current={...record};
 for(let i=0;i<10;i++)current={...record,turns:previousTurns(current),message:'后续问题 '+i,result:{answer:'后续回答 '+i,citations:[]},quote:q};
 assert.deepEqual(validateAnswerQuote(current,q),q);assert.equal(conversationHistory(current).length,8);
 assert.deepEqual(conversationHistory(current).at(-1).quotedAnswer,{round:1,text:'方案 A'});
 assert.match(discussionMarkdown(current),/引用第 1 轮 AI 回答/);
});
test('legacy string drafts remain questions, new drafts preserve mode and reference',()=>{
 assert.deepEqual(inlineDraft('旧草稿'),{text:'旧草稿',mode:'ask',quote:null,preserveNumbers:true});
 const draft={text:'按建议改',mode:'edit',quote:createAnswerQuote(record,0,'方案 A'),preserveNumbers:false};assert.deepEqual(inlineDraft(draft),draft);
 const answered={...record,quote:draft.quote};assert.equal(isSentInput({...answered,replyQuote:draft.quote},[answered]),true);
 assert.equal(isSentInput({...record,replyQuote:createAnswerQuote(record,0,'下一步验证。')},[answered]),false);
});
test('prompt clearly separates selected AI quote from editable original and keeps local identifiers out',()=>{
 const q=createAnswerQuote(record,0,'方案 A'),prompt=notePrompt({capture,mode:'edit',instruction:'按此修改',quotedAnswer:{round:q.turnIndex+1,text:q.text},preserveNumbers:true});
 assert.match(prompt,/not note text or an edit target/);assert.match(prompt,/exact Markdown replacement for the selected range only/);assert.match(prompt,/Preserve all numbers/);
 assert.match(prompt,/方案 A/);assert.doesNotMatch(prompt,/synthetic\.md|responseHash|recordId/);
});
