import { UserError } from '../server/documents.js';

export function exportPath(folder, name) {
  folder=String(folder||'').trim();name=String(name||'').trim();
  const valid=part=>part && !part.startsWith('.') && !/[<>:"|?*\x00-\x1f\\/]/.test(part) && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) && Buffer.byteLength(part)<=240;
  if(folder && !folder.split('/').every(valid))throw new UserError('请填写笔记库内的目录，如 Folio/讨论；不能使用绝对路径或 ..。');
  if(!valid(name))throw new UserError('请填写有效文件名，不要包含路径、特殊符号或隐藏文件名。');
  name=name.replace(/\.md$/i,'')+'.md';
  if(Buffer.byteLength(name)>240)throw new UserError('文件名太长，请缩短后重试。');
  return folder?folder+'/'+name:name;
}

export function defaultExportPath(vault, source) {
  const parts=source.split('/'),stem=parts.pop().replace(/\.md$/i,'').replace(/[<>:"|?*\x00-\x1f]/g,'-').slice(0,55),folder=parts.join('/');
  const now=new Date(),date=[now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')].join('-');
  const base=stem+'-讨论-'+date;
  const join=name=>folder?folder+'/'+name+'.md':name+'.md';
  let target=join(base),i=2;
  while(vault.getAbstractFileByPath(target))target=join(base+'-'+i++);
  return target;
}

export function checkExportTarget(vault, target) {
  const parts=target.split('/'),name=parts.pop();
  if(exportPath(parts.join('/'),name)!==target)throw new UserError('保存路径无效，请重新填写。');
  if(vault.getAbstractFileByPath(target))throw new UserError('同名文件已存在，请修改文件名；不会覆盖已有内容。');
  for(let i=1;i<=parts.length;i++){
    const item=vault.getAbstractFileByPath(parts.slice(0,i).join('/'));
    if(item&&!Array.isArray(item.children))throw new UserError('保存目录中有同名文件，请换一个目录。');
  }
  return target;
}
