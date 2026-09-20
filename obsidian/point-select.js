import { MarkdownView, Notice } from 'obsidian';
import { captureSection } from './notes.js';
import { hash, UserError } from '../server/documents.js';
import { InlineNotes } from './inline-notes.js';
import { relocateCapture } from './review.js';


export class NotePointSelect {
  constructor(plugin){
    this.plugin=plugin;this.sections=new WeakMap();this.generation=0;this.selectionRequest=0;
    this.inline=new InlineNotes(plugin);
    plugin.registerMarkdownPostProcessor((el,ctx)=>{this.sections.set(el,ctx);this.inline.register(el,ctx);});
    plugin.registerEvent(plugin.app.workspace.on('layout-change',()=>{const s=this.session;if(s && (s.view.file?.path!==s.path || s.view.getMode()!=='preview' || !s.root.isConnected || s.panel.closed))this.stop(false); }));
    plugin.registerEvent(plugin.app.vault.on('modify',file=>{if(this.session?.path===file.path)this.clearSelection();this.inline.refresh(file.path);}));
  }
  active(path){return this.session?.path===path;}
  async enable(panel,path,{leaf:target,passive=false}={}){
    if(this.active(path) && this.session.panel===panel && (!target || this.session.leaf===target))return this.session;
    await this.stop(!passive);
    const file=this.plugin.noteStore.file(path),app=this.plugin.app;
    const leaf=target||app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path===path)||app.workspace.getLeaf('tab');
    if(passive && (leaf.view.file?.path!==path || leaf.view.getMode()!=='preview'))return;
    if(!passive)await leaf.openFile(file);
    const previousMode=leaf.view.getMode();
    if(!passive)await leaf.setViewState({type:'markdown',state:{...leaf.view.getState(),file:path,mode:'preview'}});
    const view=leaf.view;if(!(view instanceof MarkdownView))throw new UserError('请先打开笔记。');
    const root=view.containerEl.querySelector('.markdown-reading-view > .markdown-preview-view');if(!root)throw new UserError('阅读视图尚未准备好，请重试。');
    const s=this.session={panel,path,leaf,view,root,previousMode,generation:++this.generation};
    root.classList.add('folio-note-point-mode');
    const details=view.addAction('messages-square','页间：审稿与历史',()=>{this.plugin.notePanel(file).catch(error=>new Notice(error.message));});
    details.addClass('folio-note-panel-toggle');details.setText('审稿与历史');
    s.details=details;
    const doc=root.ownerDocument,win=doc.defaultView;
    const over=e=>{const hit=this.find(e.target);if(this.hover===hit?.el)return;this.hover?.classList.remove('folio-note-point-hover');this.hover=hit?.el;this.hover?.classList.add('folio-note-point-hover');};
    const leave=()=>{this.hover?.classList.remove('folio-note-point-hover');this.hover=null;};
    const click=e=>{
      const hit=this.find(e.target);if(!hit)return;
      e.preventDefault();e.stopImmediatePropagation();
      this.select(hit).catch(error=>new Notice(error.message));
    };
    const key=e=>{if(e.key==='Escape'){e.preventDefault();if(this.composer){this.closeComposer();return;}this.stop(true).catch(error=>new Notice(error.message));}};
    const position=()=>this.position();
    root.addEventListener('pointerover',over);root.addEventListener('pointerleave',leave);root.addEventListener('click',click,true);
    doc.addEventListener('keydown',key);doc.addEventListener('scroll',position,true);win.addEventListener('resize',position);
    s.cleanup=()=>{root.removeEventListener('pointerover',over);root.removeEventListener('pointerleave',leave);root.removeEventListener('click',click,true);doc.removeEventListener('keydown',key);doc.removeEventListener('scroll',position,true);win.removeEventListener('resize',position);};
    view.previewMode.rerender(true);panel.render();return s;
  }
  find(target){
    const s=this.session;if(!s || !(target instanceof s.root.ownerDocument.defaultView.Element) || !s.root.contains(target) || target.closest('.markdown-embed, [data-folio-note-ui]'))return null;
    for(let el=target;el && el!==s.root;el=el.parentElement){const ctx=this.sections.get(el);if(ctx && ctx.sourcePath===s.path && !el.closest('.markdown-embed'))return {el,ctx};}
    return null;
  }
  async select(hit){
    const request=++this.selectionRequest;const s=this.session,info=hit.ctx.getSectionInfo(hit.el);if(!s)return;
    if(s.panel.controller)throw new UserError('请等待或停止当前留言，再选择其他位置。');
    const source=await this.plugin.app.vault.read(this.plugin.noteStore.file(s.path));
    if(this.session!==s || request!==this.selectionRequest || !hit.el.isConnected)return;
    const capture=captureSection(s.path,source,info);
    this.mark(hit.el,capture);
    // Clicking a block changes the visible target immediately; sending still
    // requires an explicit user message and the normal Generate/Ask button.
    await s.panel.useCapture(capture,s.panel.mode,{focus:false});
  }
  mark(el,capture){
    this.clearSelection();this.selected=el;this.capture=capture;el.classList.add('folio-note-point-selected');
    const s=this.session,doc=s.root.ownerDocument;
    const toolbar=this.toolbar=doc.body.createDiv({cls:'folio-note-point-tools',attr:{role:'toolbar','aria-label':'所选段落操作'}});
    toolbar.createSpan({cls:'folio-note-point-label',text:`已选中 · 第 ${capture.startLine}${capture.endLine===capture.startLine?'':`–${capture.endLine}`} 行`});
    for(const [mode,text]of [['edit','修改'],['ask','提问']]){
      const button=toolbar.createEl('button',{text,attr:{'data-note-action':mode}});
      button.onclick=()=>{if(this.session!==s)return;this.openComposer(capture,mode).catch(error=>new Notice(error.message));};
    }
    const cancel=toolbar.createEl('button',{text:'×',attr:{'aria-label':'取消高亮'}});cancel.onclick=()=>this.clearSelection();this.position();
  }
  async openComposer(capture,mode,{replyId=null}={}){
    const s=this.session,selected=this.selected;if(!s)return;
    await s.panel.useCapture(capture,mode,{focus:false,replyId});
    if(this.session!==s || this.selected!==selected)return;
    this.closeComposer(false);
    this.hover?.classList.remove('folio-note-point-hover');this.hover=null;
    const panel=s.panel,box=this.composer=s.root.ownerDocument.body.createDiv({cls:'folio-inline-composer',attr:{role:'dialog','aria-label':mode==='ask'?'向 AI 提问':'请 AI 修改','data-folio-note-ui':'true'}});
    box.folioCapture=capture;box.folioMode=mode;
    const header=box.createDiv({cls:'folio-inline-composer-header'});
    header.createEl('strong',{text:mode==='ask'?'问问这段内容':'让 AI 修改这段'});
    const close=header.createEl('button',{text:'×',attr:{'aria-label':'收起输入，保留草稿'}});close.onclick=()=>this.closeComposer();
    box.createDiv({cls:'folio-inline-excerpt',text:capture.expected.slice(0,90)+(capture.expected.length>90?'…':'')});
    const input=box.createEl('textarea',{attr:{'aria-label':'原地留言',placeholder:mode==='ask'?'这段是什么意思？有什么依据？':'希望怎么修改这段内容？',rows:'3',maxlength:'2000'}});input.value=panel.message;
    input.oninput=()=>{panel.message=input.value;const side=panel.contentEl.querySelector('textarea');if(side)side.value=input.value;panel.persist().catch(error=>panel.report(error));};
    if(mode==='edit'){
      const label=box.createEl('label',{cls:'folio-note-numbers'}),check=label.createEl('input',{attr:{type:'checkbox'}});check.checked=panel.preserveNumbers;label.appendText('保留数字');check.onchange=()=>{panel.preserveNumbers=check.checked;panel.persist().catch(error=>panel.report(error));};
    }
    const footer=box.createDiv({cls:'folio-inline-composer-footer'}),status=footer.createSpan({text:'草稿自动保存 · ⌘ / Ctrl + Enter 发送',attr:{role:'status'}});
    const send=footer.createEl('button',{cls:'mod-cta folio-inline-send',text:mode==='ask'?'发送提问':'生成建议'});
    const submit=async()=>{
      if(panel.controller)return;send.disabled=true;input.disabled=true;
      try{await panel.run();}catch(error){status.setText(error.message);panel.report(error);}finally{send.disabled=false;input.disabled=false;}
    };
    send.onclick=submit;input.onkeydown=e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)&&!e.isComposing){e.preventDefault();submit();}};
    this.position();input.focus();
  }
  closeComposer(focus=true){this.composer?.remove();this.composer=null;if(this.toolbar){this.toolbar.hidden=false;if(focus)this.toolbar.querySelector('button')?.focus();}this.position();}
  recordSaved(record){if(record.state==='running' && this.session?.path===record.capture.path)this.closeComposer(false);this.inline.refresh(record.capture.path);}
  selectedBounds(){
    const rects=[...this.selected.children].filter(el=>!el.hasAttribute('data-folio-note-ui')).map(el=>el.getBoundingClientRect()).filter(r=>r.width&&r.height);
    if(!rects.length)return this.selected.getBoundingClientRect();
    return {left:Math.min(...rects.map(r=>r.left)),right:Math.max(...rects.map(r=>r.right)),top:Math.min(...rects.map(r=>r.top)),bottom:Math.max(...rects.map(r=>r.bottom))};
  }
  position(){
    if(!this.toolbar || !this.selected || !this.session)return;
    if(!this.selected.isConnected){this.clearSelection();return;}
    const rect=this.selectedBounds(),bounds=this.session.root.getBoundingClientRect(),win=this.session.root.ownerDocument.defaultView;
    const visible=rect.bottom>bounds.top && rect.top<bounds.bottom;
    this.toolbar.hidden=!visible;if(this.composer)this.composer.hidden=!visible;if(!visible)return;
    if(this.composer){
      this.toolbar.hidden=true;
      const box=this.composer,width=box.offsetWidth,height=box.offsetHeight;
      box.style.left=`${Math.max(8,Math.min(rect.right-width,win.innerWidth-width-8))}px`;
      box.style.top=`${Math.max(bounds.top+8,Math.min(rect.bottom+12,bounds.bottom-height-8,win.innerHeight-height-8))}px`;
      return;
    }
    const width=this.toolbar.offsetWidth,height=this.toolbar.offsetHeight;
    this.toolbar.style.left=`${Math.max(8,Math.min(rect.left,win.innerWidth-width-8))}px`;
    this.toolbar.style.top=`${Math.max(bounds.top+5,Math.min(rect.top-height-7,bounds.bottom-height-5))}px`;
  }
  clearSelection(){this.composer?.remove();this.composer=null;this.selected?.classList.remove('folio-note-point-selected');this.selected=null;this.capture=null;this.toolbar?.remove();this.toolbar=null;}
  async locate(panel,capture,range=capture){
    const source=await this.plugin.app.vault.read(this.plugin.noteStore.file(capture.path));
    if(hash(source)!==capture.version){if(range!==capture)throw new UserError('笔记已改变，此引用对应旧版本，请重新提问。');capture=relocateCapture(capture,source);range=capture;}
    const s=await this.enable(panel,capture.path);
    await s.leaf.openFile(this.plugin.noteStore.file(capture.path),{eState:{line:range.startLine-1}});
    // The reading renderer may virtualize sections until the requested line is visible.
    for(let attempt=0;attempt<12;attempt++){
      if(this.session!==s)return;
      for(const el of s.root.querySelectorAll('*')){
        const ctx=this.sections.get(el);if(!ctx||ctx.sourcePath!==s.path||el.closest('.markdown-embed'))continue;
        const info=ctx.getSectionInfo(el);
        if(info && info.text.replace(/\r\n/g,'\n')===source.replace(/\r\n/g,'\n') && info.lineStart<=range.startLine-1 && info.lineEnd>=range.startLine-1){
          const current=captureSection(s.path,source,info);this.mark(el,current);el.scrollIntoView({block:'center'});this.position();return;
        }
      }
      await new Promise(resolve=>setTimeout(resolve,40));
    }
    throw new UserError('此处暂未渲染，请滚动到对应段落后点选。');
  }
  async stop(restore=true){
    const s=this.session;this.session=null;++this.generation;this.clearSelection();this.hover?.classList.remove('folio-note-point-hover');this.hover=null;
    if(!s)return;s.details?.remove();s.cleanup?.();s.root.classList.remove('folio-note-point-mode');
    if(restore && s.previousMode==='source' && s.view.file?.path===s.path && s.view.getMode()==='preview')await s.leaf.setViewState({type:'markdown',state:{...s.view.getState(),mode:'source'}});
    if(!s.panel.closed)s.panel.render();
  }
}
