import { conversationHistory } from './review.js';
import { UserError } from '../server/documents.js';

export function latestAnswer(record) {
  const turns=[...(record?.turns||[]),record];
  const completed=turns.filter(turn=>turn?.result).at(-1);
  return completed?.mode==='ask'&&typeof completed.result.answer==='string'?completed:null;
}

export function reanswerMessage(record, adjustment='') {
  if(!latestAnswer(record))throw new UserError('当前没有可重答的 AI 回答，请先提问。');
  if(!conversationHistory(record).length)throw new UserError('回答上下文过长，请选中回答片段后引用追问。');
  const message='请重新回答本讨论最近一次已经得到回答的问题，结合已有讨论改进上一份回答。只回复新的答案，不修改笔记原文。'+(adjustment.trim()?'\n调整要求：'+adjustment.trim():'');
  if(message.length>2000)throw new UserError('重答要求过长，请缩短后重试。');
  return message;
}
