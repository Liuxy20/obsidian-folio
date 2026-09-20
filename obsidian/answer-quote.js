import { createHash } from 'node:crypto';
import { parseFragment } from 'parse5';
import { answerHTML } from './answer-markdown.js';
import { UserError } from '../server/documents.js';

const normalize=text=>text.replace(/\s+/g,' ').trim();
const fingerprint=text=>createHash('sha256').update(text).digest('hex');
const plain=node=>node.nodeName==='#text'?node.value:(node.childNodes||[]).map(plain).join('');

// History is append-only. Ordinal plus response digest identifies an old answer
// even after another reply, a reload, or reattaching the discussion to new text.
export function createAnswerQuote(record, turnIndex, text) {
  const turn=[...(record?.turns||[]),record][turnIndex];
  if(!Number.isSafeInteger(turnIndex)||turnIndex<0||typeof turn?.result?.answer!=='string')throw new UserError('这条 AI 回答已变化，请重新选择引用。');
  if(typeof text!=='string'||!text.trim()||text.length>2000)throw new UserError('每次请引用 1–2000 字的 AI 回答。');
  if(!normalize(plain(parseFragment(answerHTML(turn.result.answer)))).includes(normalize(text)))throw new UserError('引用内容已变化，请重新选择。');
  return {recordId:record.id,turnIndex,responseHash:fingerprint(turn.result.answer),text:text.trim()};
}

export function validateAnswerQuote(record, quote) {
  if(!quote)return null;
  if(quote.recordId!==record?.id)throw new UserError('引用不属于当前讨论，请重新选择。');
  const checked=createAnswerQuote(record,quote.turnIndex,quote.text);
  if(checked.responseHash!==quote.responseHash)throw new UserError('原回答已变化，请重新选择引用。');
  return checked;
}

export function inlineDraft(value) {
  if(typeof value==='string')return {text:value,mode:'ask',quote:null,preserveNumbers:true};
  return {text:typeof value?.text==='string'?value.text:'',mode:['edit','reanswer'].includes(value?.mode)?value.mode:'ask',quote:value?.quote||null,preserveNumbers:value?.preserveNumbers!==false};
}

export function renderQuotedAnswer(container, quote) {
  if(!quote)return;
  const box=container.createDiv({cls:'folio-quoted-answer'});
  box.createEl('small',{text:`引用第 ${quote.turnIndex+1} 轮 AI 回答`});
  box.createDiv({text:quote.text});
  return box;
}
