import { posix } from 'node:path';

// Sending a follow-up must not archive the text of an already sent question as
// a new draft. Require the exact original capture; matching words alone is unsafe.
export function isSentInput(draft, records) {
  if (!draft?.capture || !draft.message?.trim()) return false;
  const sameCapture = capture => capture && ['path','version','start','end','expected'].every(key => capture[key] === draft.capture[key]);
  const sameTurn = turn => turn?.result && turn.message === draft.message && turn.mode === draft.mode && JSON.stringify(turn.quote||null)===JSON.stringify(draft.replyQuote||draft.quote||null);
  return records.some(record => (sameCapture(record.capture) && sameTurn(record)) || (record.turns || []).some(turn => sameCapture(turn.capture || record.capture) && sameTurn(turn)));
}

export function chronologicalRecords(records) {
  // Storage remains most-recently-updated first. Presentation is
  // oldest-created first; a follow-up keeps its thread in the same position.
  return [...records].reverse().sort((a, b) => (a.createdAt ?? a.date ?? 0) - (b.createdAt ?? b.date ?? 0));
}

// Display paging and model context limits never truncate persisted history.
export function historyPage(records, count=30) {
  const sorted=chronologicalRecords(records);
  return {records:sorted.slice(-count),remaining:Math.max(0,sorted.length-count),total:sorted.length};
}

export function previousTurns(record) {
  const turns=[...(record?.turns||[])];
  if(record?.result)turns.push({message:record.message,mode:record.mode,result:record.result,date:record.date,capture:record.capture,quote:record.quote||null});
  return turns;
}

export function discussionMarkdown(record, target=record.capture.path) {
  // Preserve source/model Markdown literally. Opening an export must not run a
  // vault code-block processor or fetch an image embedded in model output.
  const quote=text=>{
    const value=String(text||'').replace(/\r\n?/g,'\n');
    const fence='`'.repeat(Math.max(3,...[...value.matchAll(/`+/g)].map(m=>m[0].length+1)));
    return fence+'text\n'+value+'\n'+fence;
  };
  // Encode every URL delimiter, including parentheses, in relative note links.
  const path=record.capture.path;
  const relative=posix.relative(posix.dirname(target),path);
  const href='./'+relative.split('/').map(part=>encodeURIComponent(part).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16))).join('/');
  const lines=['# 讨论记录','',`来源：[打开原笔记](${href})`,'',quote(path),'','以下是导出时保留的讨论；行号与原文摘录对应各轮保存时的版本。',''];
  const turns=[...(record.turns||[]),record];
  turns.forEach((turn,index)=>{
    const capture=turn.capture||record.capture;
    lines.push(`## 第 ${index+1} 轮 · ${turn.mode==='ask'?'提问':'修改'}`,'',`原文位置：第 ${capture.startLine}–${capture.endLine} 行`,'',quote(capture.expected),'','### 留言','',quote(turn.message),'');
    if(turn.quote)lines.push(`引用第 ${turn.quote.turnIndex+1} 轮 AI 回答：`,'',quote(turn.quote.text),'');
    if(turn.result){
      lines.push('### AI 回答 / 建议（原始文本）','',quote(turn.result.answer??turn.result.replacement??turn.result.summary??''),'');
      if(turn.result.replacement!==undefined&&turn.result.summary)lines.push('修改说明：',quote(turn.result.summary),'');
      for(const c of turn.result.citations||[])lines.push(`引用原笔记：第 ${c.startLine}–${c.endLine} 行`,'');
    }else lines.push('尚无完成的回答。','');
  });
  return lines.join('\n');
}
