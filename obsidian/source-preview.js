import { renderAnswer } from './answer-markdown.js';

// All three entry points share the same inert Markdown source preview.
export function renderSourcePreview(container, source, {title='关联笔记原文', className=''}={}) {
  const box=container.createDiv({cls:`folio-card-edit-target ${className}`.trim()});
  const header=box.createDiv({cls:'folio-card-target-header'});
  header.createEl('strong',{text:title});
  header.createEl('span',{text:'滚动查看 · 拖动右下角调整高度'});
  const preview=box.createDiv({cls:'folio-card-target-preview',attr:{tabindex:'0',role:'region','aria-label':'关联原文预览，可滚动查看'}});
  renderAnswer(preview,source);
  return box;
}
