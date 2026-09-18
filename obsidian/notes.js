import { randomUUID } from 'node:crypto';
import { hash, UserError, MAX_DOCUMENT_BYTES } from '../server/documents.js';

export function captureNote(path, source, start, end = start) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_DOCUMENT_BYTES) throw new UserError('笔记不能超过 5 MB。');
  if (![start,end].every(n=>Number.isSafeInteger(n) && n>=0 && n<=source.length) || start>end) throw new UserError('选区已失效，请重新选择。');
  if (start===end) {
    const lines=source.split(/(?<=\n)/);let offset=0,index=0;
    for(let i=0;i<lines.length;i++){if(offset+lines[i].length>start || i===lines.length-1){index=i;break;}offset+=lines[i].length;}
    if (!lines[index]?.trim()) throw new UserError('请选中文字，或把光标放在有内容的段落内。');
    let first=index,last=index;
    while(first>0 && lines[first-1].trim())first--;
    while(last<lines.length-1 && lines[last+1].trim())last++;
    start=lines.slice(0,first).join('').length;end=start+lines.slice(first,last+1).join('').replace(/[\r\n]+$/,'').length;
  }
  const expected=source.slice(start,end);
  if (!expected.trim())throw new UserError('请选择有内容的文字。');
  if (Buffer.byteLength(expected)>20_000)throw new UserError('每条留言请选择不超过 20 KB 的内容，可以分段处理。');
  const lines=source.split('\n');
  const startLine=source.slice(0,start).split('\n').length,endLine=source.slice(0,end).split('\n').length;
  let first=startLine-1,last=endLine-1,size=Buffer.byteLength(lines.slice(first,last+1).join('\n'));
  if(size>24_000)throw new UserError('选区所在行太长，请先拆成较短的段落。');
  while(first>0 || last<lines.length-1){
    let added=false;
    if(first>0 && size+Buffer.byteLength(lines[first-1])+1<=24_000){size+=Buffer.byteLength(lines[--first])+1;added=true;}
    if(last<lines.length-1 && size+Buffer.byteLength(lines[last+1])+1<=24_000){size+=Buffer.byteLength(lines[++last])+1;added=true;}
    if(!added)break;
  }
  return { path, version:hash(source), start,end,expected,startLine,endLine, context:lines.slice(first,last+1).map((text,i)=>({line:first+i+1,text:text.replace(/\r$/,'')})), partial:first>0 || last<lines.length-1, newline:source.includes('\r\n')?'\r\n':'\n' };
}

export function validateNoteResult(result, capture, mode, preserveNumbers=true) {
  if(mode==='ask') {
    if(typeof result?.answer!=='string' || !result.answer.trim() || result.answer.length>30_000 || !Array.isArray(result.citations) || result.citations.length>8)throw new UserError('回答格式不正确，请重试。');
    const lines=new Set(capture.context.map(l=>l.line));
    const citations=result.citations.map(c=>{
      if(!Number.isInteger(c.startLine)||!Number.isInteger(c.endLine)||c.endLine<c.startLine||c.endLine-c.startLine>100 || !lines.has(c.startLine)||!lines.has(c.endLine))throw new UserError('回答引用了未提供的行，已拦截，请重试。');
      return {startLine:c.startLine,endLine:c.endLine};
    });
    return {answer:result.answer,citations};
  }
  if(typeof result?.replacement!=='string' || Buffer.byteLength(result.replacement)>120_000 || typeof result.summary!=='string')throw new UserError('修改建议格式不正确，请重试。');
  const replacement=result.replacement.replace(/\r\n|\r|\n/g,capture.newline);
  const numbers=s=>(s.match(/\d+(?:[.,]\d+)*(?:%|％)?/g)||[]).sort().join('|');
  if(preserveNumbers && numbers(replacement)!==numbers(capture.expected))throw new UserError('建议改变了数字，已拦截。需要调整数字时，请取消“保留数字”。');
  return {replacement,summary:result.summary.slice(0,400)};
}

export class NoteStore {
  constructor(vault,state,directory){Object.assign(this,{vault,state,directory});this.locks=new Map();}
  file(path){
    if(typeof path!=='string'||path.startsWith('/')||path.includes('\\')||path.split('/').some(p=>!p||p==='..'||p.startsWith('.')))throw new UserError('笔记路径无效。');
    const file=this.vault.getAbstractFileByPath(path);
    if(file?.extension!=='md'||file.path!==path)throw new UserError('笔记已移动或删除，请重新打开。');
    return file;
  }
  async thread(path){this.file(path);await this.state.queue.catch(()=>{});return structuredClone(this.state.data.notes?.[path] || {draft:null,records:[]});}
  async draft(path,draft){this.file(path);await this.state.mutate(data=>{data.notes ||= {}; const thread=data.notes[path] ||= {draft:null,records:[]};thread.draft=draft;});}
  async record(path,record){this.file(path);await this.state.mutate(data=>{data.notes ||= {};const thread=data.notes[path] ||= {draft:null,records:[]};thread.records=[record,...thread.records.filter(r=>r.id!==record.id)].slice(0,30);});}
  async locked(path,fn){const old=this.locks.get(path)||Promise.resolve();const task=old.catch(()=>{}).then(fn);this.locks.set(path,task);try{return await task;}finally{if(this.locks.get(path)===task)this.locks.delete(path);}}
  async apply(record,checkEditor=()=>{}) {
    return this.locked(record.capture.path,async()=>{
      if(record.mode!=='edit'||record.state!=='ready')throw new UserError('这条留言没有可保存的修改。');
      const c=record.capture,file=this.file(c.path),current=await this.vault.read(file);
      if(hash(current)!==c.version||current.slice(c.start,c.end)!==c.expected)throw new UserError('笔记已改变，未覆盖。请重新选择内容生成建议。',409);
      checkEditor(current);
      const replacement=validateNoteResult(record.result,c,'edit',record.preserveNumbers).replacement;
      const next=current.slice(0,c.start)+replacement+current.slice(c.end);
      if(Buffer.byteLength(next)>MAX_DOCUMENT_BYTES)throw new UserError('修改后笔记超过 5 MB。');
      const dir=`${this.directory}/note-history/${hash(c.path)}`;await this.vault.adapter.mkdir(dir);
      const backup=`${dir}/${Date.now()}-${randomUUID()}.md`;await this.vault.adapter.write(backup,current);
      await this.vault.process(file,latest=>{checkEditor(current);if(file.path!==c.path||hash(latest)!==c.version)throw new UserError('保存时检测到外部修改，未覆盖。',409);return next;});
      return {...record,state:'applied',backup,appliedVersion:hash(next)};
    });
  }
  async undo(record,checkEditor=()=>{}) {
    return this.locked(record.capture.path,async()=>{
      const dir=`${this.directory}/note-history/${hash(record.capture.path)}/`;
      if(record.state!=='applied'||!record.backup?.startsWith(dir)||!/^\d+-[\w-]+\.md$/.test(record.backup.slice(dir.length)))throw new UserError('保存备份不存在。');
      const file=this.file(record.capture.path),current=await this.vault.read(file);
      if(hash(current)!==record.appliedVersion)throw new UserError('保存后笔记又有修改，不能直接撤销。',409);
      checkEditor(current);const original=await this.vault.adapter.read(record.backup);
      if(hash(original)!==record.capture.version)throw new UserError('备份校验失败，未改动笔记。');
      await this.vault.process(file,latest=>{checkEditor(current);if(file.path!==record.capture.path||hash(latest)!==record.appliedVersion)throw new UserError('撤销时检测到外部修改。',409);return original;});
      return {...record,state:'undone'};
    });
  }
}

export function captureSection(path, source, info) {
  if (!info || !Number.isInteger(info.lineStart) || !Number.isInteger(info.lineEnd) || info.lineStart<0 || info.lineEnd<info.lineStart) throw new UserError('此处暂时无法定位，请选择正文段落。');
  if (typeof info.text!=='string' || info.text.replace(/\r\n/g,'\n')!==source.replace(/\r\n/g,'\n')) throw new UserError('正文刚刚发生变化，请等页面刷新后重新点选。');
  const lines=source.split(/(?<=\n)/);
  if(info.lineEnd>=lines.length)throw new UserError('段落位置已改变，请重新点选。');
  const start=lines.slice(0,info.lineStart).join('').length;
  const end=start+lines.slice(info.lineStart,info.lineEnd+1).join('').replace(/[\r\n]+$/,'').length;
  return captureNote(path,source,start,end);
}

