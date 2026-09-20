import { ItemView, MarkdownView, FuzzySuggestModal, Notice } from 'obsidian';
import { randomUUID } from 'node:crypto';
import { diffWordsWithSpace } from 'diff';
import { captureNote, validateNoteResult } from './notes.js';
import { hash, UserError } from '../server/documents.js';
import { renderAnswer } from './answer-markdown.js';
import { renderSourcePreview } from './source-preview.js';
import { latestAnswer, reanswerMessage } from './reanswer.js';
import { relocateCapture, recordCapture, conversationHistory, validateReview, reviewContext } from './review.js';
import { ReviewRequestModal, RevisionModal } from './review-ui.js';
import { isSentInput, previousTurns, historyPage } from './conversation.js';
import { ExportDiscussionModal } from './export-modal.js';
import { validateAnswerQuote, renderQuotedAnswer } from './answer-quote.js';

export const NOTE_VIEW='folio-note-comments';
const labelRange=c=>`第 ${c.startLine}${c.endLine===c.startLine?'':`–${c.endLine}`} 行`;
export class NotePicker extends FuzzySuggestModal {
  constructor(app,plugin){super(app);this.plugin=plugin;this.setPlaceholder('选择笔记，直接点中段落修改或提问');}
  getItems(){return this.app.vault.getMarkdownFiles().filter(f=>this.plugin.isNoteFile(f)&&!f.path.split('/').some(p=>p.startsWith('.')));}
  getItemText(file){return file.path;}
  onChooseItem(file){this.plugin.openNote(file).catch(error=>new Notice(error.message));}
}

export class NoteView extends ItemView {
  constructor(leaf,plugin){super(leaf);this.plugin=plugin;this.mode='edit';this.message='';this.preserveNumbers=true;this.records=[];this.closed=false;}
  getViewType(){return NOTE_VIEW;}
  getDisplayText(){return '页间 · 笔记留言';}
  getIcon(){return 'messages-square';}
  getState(){return {file:this.path||null};}
  async onOpen(){this.plugin.noteViews.add(this);await this.plugin.ready;this.render();}
  async setState(state,result){
    if(state && 'file' in state && state.file!==this.path){
      await this.persist();this.stop();this.path=state.file;this.historyCount=30;
      const thread=this.path?await this.plugin.noteStore.thread(this.path):{records:[],draft:null};this.records=thread.records;this.lastBatch=thread.lastBatch;
      const draft=thread.draft;this.capture=draft?.capture||null;this.message=draft?.message||'';this.replyId=draft?.replyId||null;this.mode=draft?.mode||'edit';this.preserveNumbers=draft?.preserveNumbers!==false;
      this.replyQuote=draft?.quote||null;this.activeRecord=this.records[0]?.id;this.render();
    }
    await super.setState(state,result);
  }
  async useCapture(capture,mode='edit',{focus=true,replyId=null,quote=null}={}){
    if(this.controller)throw new UserError('请等待或停止当前留言。');
    if(this.message.trim() && this.capture && (this.capture.version!==capture.version||this.capture.start!==capture.start||this.capture.end!==capture.end||this.replyId!==replyId)) {
      const record={id:randomUUID(),capture:this.capture,message:this.message,mode:this.mode,preserveNumbers:this.preserveNumbers,state:'draft',date:Date.now(),quote:this.replyQuote||null};
      if(!isSentInput(this,this.records))await this.saveRecord(record);this.message='';
    }
    this.capture=capture;this.mode=mode;this.replyId=replyId;this.replyQuote=quote;this.activeRecord=null;await this.persist();this.render();if(focus)this.contentEl.querySelector('textarea')?.focus();
  }
  async persist(){
    if(!this.path || !this.capture)return;
    await this.plugin.noteStore.draft(this.path,{capture:this.capture,message:this.message,mode:this.mode,replyId:this.replyId,preserveNumbers:this.preserveNumbers,quote:this.replyQuote||null});
  }
  async saveRecord(record){await this.plugin.noteStore.record(record.capture.path,record);if(record.capture.path===this.path)this.records=[record,...this.records.filter(r=>r.id!==record.id)];if(!this.closed)this.plugin.pointSelect?.recordSaved(record);}
  report(error){if(!this.closed){this.statusEl?.setText(error instanceof UserError?error.message:'操作失败，请检查笔记库是否可写。');new Notice(error.message||'操作失败');}}
  button(parent,text,handler,cls=''){
    const button=parent.createEl('button',{text,cls});button.onclick=()=>Promise.resolve().then(handler).catch(error=>this.report(error));return button;
  }
  editor(){return this.app.workspace.getLeavesOfType('markdown').map(l=>l.view).find(v=>v instanceof MarkdownView && v.file?.path===this.path);}
  checkEditors(source,path=this.path){for(const leaf of this.app.workspace.getLeavesOfType('markdown')){const v=leaf.view;if(v instanceof MarkdownView && v.getMode()==='source' && v.file?.path===path && v.editor.getValue()!==source)throw new UserError('编辑器中有更新，未覆盖。请重新选取内容。',409);}}
  checkCurrent(capture){if(this.plugin.currentNoteLeaf()?.view?.file?.path!==capture.path)throw new UserError('当前文档已切换，请等待页间跟随后重新操作。');}
  async recapture(){
    let view=this.app.workspace.getActiveViewOfType(MarkdownView)||(this.plugin.lastNoteEditor?.file?.path===this.path?this.plugin.lastNoteEditor:this.editor());
    if(!view?.file || view.file.path!==this.path)throw new UserError('请在对应笔记中选中文字，再点击“使用当前选区”。');
    if(view.getMode()!=='source')throw new UserError('请先切到笔记编辑模式，再选中文字。');
    const e=view.editor;await this.useCapture(captureNote(view.file.path,e.getValue(),e.posToOffset(e.getCursor('from')),e.posToOffset(e.getCursor('to'))),this.mode);
  }
  async locate(capture,range=capture){
    return this.plugin.pointSelect.locate(this,capture,range);
  }
  run(){if(this.task)return this.task;const task=this.runCurrent();this.task=task;task.finally(()=>{if(this.task===task)this.task=null;}).catch(()=>{});return task;}
  async runCurrent(){
    if(this.controller)return;
    const controller=this.controller=new AbortController();let record;
    try {
      if(!this.capture)throw new UserError('请先选中笔记内容。');
      this.checkCurrent(this.capture);
      if(!this.message.trim()||this.message.length>2000)throw new UserError('请输入 1–2000 字留言。');
      const capture=this.capture,current=await this.app.vault.read(this.plugin.noteStore.file(capture.path));
      this.checkCurrent(capture);
      if(hash(current)!==capture.version)throw new UserError('笔记已变化或尚未自动保存，请重新选取内容。');
      this.checkEditors(current);await this.persist();
      const previous=this.replyId?this.records.find(r=>r.id===this.replyId):null;
      const quote=validateAnswerQuote(previous,this.replyQuote);
      const turns=previousTurns(previous);
      record={id:previous?.id||randomUUID(),capture,mode:this.mode,message:this.message,preserveNumbers:this.preserveNumbers,state:'running',createdAt:previous?.createdAt??previous?.date??Date.now(),date:Date.now(),turns,review:previous?.review,quote};
      const history=conversationHistory(previous);this.replyId=record.id;
      await this.saveRecord(record);this.activeRecord=record.id;this.message='';await this.persist();this.render();
      if(controller.signal.aborted)throw new UserError('已停止，原笔记未修改。');
      const result=await this.plugin.noteGenerate({capture,mode:record.mode,instruction:record.message,history,quotedAnswer:quote?{round:quote.turnIndex+1,text:quote.text}:null,preserveNumbers:record.preserveNumbers,signal:controller.signal,onProgress:text=>{if(!this.closed)this.statusEl?.setText(text);}});
      if(controller.signal.aborted)throw new UserError('已停止，原笔记未修改。');
      record.result=validateNoteResult(result,capture,record.mode,record.preserveNumbers);record.state=record.mode==='ask'?'answered':'ready';
      await this.saveRecord(record);
      if(this.path===capture.path){this.message='';this.replyQuote=null;await this.persist();}
    } catch(error){
      if(!record)throw error;
      record.state=controller.signal.aborted?'cancelled':'error';record.error=error instanceof UserError?error.message:'生成失败，请检查 Codex 配置后重试。';await this.saveRecord(record).catch(e=>this.report(e));
    } finally{if(this.controller===controller)this.controller=null;if(!this.closed){this.render();if(record?.result&&!this.inlineSubmission)this.contentEl.querySelector('.folio-note-result')?.scrollIntoView({block:'nearest'});}}
  }
  stop(){this.queueCancelled=true;this.controller?.abort();}
  async reloadRecords(){
    const path=this.path;if(!path)return;
    const thread=await this.plugin.noteStore.thread(path);
    if(this.path!==path||this.closed)return;
    this.records=thread.records;this.lastBatch=thread.lastBatch;this.render();
  }
  async apply(record){
    if(this.controller)throw new UserError('请等待当前留言结束。');
    await this.plugin.noteStore.applyBatch([record],record.capture.version,source=>this.checkEditors(source,record.capture.path));
    await this.reloadRecords();this.plugin.pointSelect.inline.refresh(record.capture.path);new Notice('已保存修改，保存前原文已备份。');
  }
  async undo(record){
    if(record.batchId)await this.plugin.noteStore.undoBatch(record.capture.path,s=>this.checkEditors(s,record.capture.path));
    else await this.saveRecord(await this.plugin.noteStore.undo(record,s=>this.checkEditors(s,record.capture.path)));
    await this.reloadRecords();this.plugin.pointSelect.inline.refresh(record.capture.path);new Notice('已恢复这次保存前的笔记。');
  }
  async reply(record,mode='ask',message=''){
    if(this.controller)throw new UserError('请先停止当前生成。');
    const source=await this.app.vault.read(this.plugin.noteStore.file(record.capture.path));
    const capture=recordCapture(record,source);
    await this.useCapture(capture,mode,{replyId:record.id});this.message=message;await this.persist();this.render();
    await this.locate(capture);
    await this.plugin.pointSelect.openComposer(capture,mode,{replyId:record.id});
  }
  async reattach(record){
    if(!this.capture||this.capture.path!==record.capture.path)throw new UserError('先在这篇笔记里选择要关联的段落。');
    const source=await this.app.vault.read(this.plugin.noteStore.file(this.capture.path));
    const capture=relocateCapture(this.capture,source);
    // Reattaching a discussion never carries a replacement onto different text.
    const turns=previousTurns(record);
    await this.saveRecord({...record,capture,anchor:null,removed:false,result:null,turns,state:'draft',resolved:false});this.render();
  }
  async queueComment(){
    if(!this.capture||!this.message.trim())throw new UserError('先选择段落并写下修改要求。');
    if(this.message.length>2000)throw new UserError('留言不能超过 2000 字。');
    await this.saveRecord({id:randomUUID(),capture:this.capture,mode:'edit',message:this.message,preserveNumbers:this.preserveNumbers,state:'draft',date:Date.now()});
    this.message='';this.replyId=null;await this.persist();this.render();
  }
  async generateQueued(){
    if(this.task)return this.task;
    const records=this.records.filter(r=>r.mode==='edit'&&['draft','review'].includes(r.state)&&!r.resolved);
    if(!records.length)throw new UserError('没有待生成的修改意见。');
    this.queueCancelled=false;
    const task=(async()=>{
      for(const item of records){
        if(this.queueCancelled)break;
        const source=await this.app.vault.read(this.plugin.noteStore.file(item.capture.path));
        if(this.queueCancelled)break;
        const capture=recordCapture(item,source);
        await this.useCapture(capture,'edit',{replyId:item.id,focus:false});this.message=item.review?.comment||item.message;
        await this.runCurrent();
        const result=this.records.find(r=>r.id===item.id);
        if(this.closed||this.path!==item.capture.path||['cancelled','error'].includes(result?.state))break;
      }
    })();
    this.task=task;try{await task;}finally{if(this.task===task)this.task=null;}
  }
  async requestReview(){
    if(this.controller)return;
    const file=this.plugin.noteStore.file(this.path),source=await this.app.vault.read(file);reviewContext(source);this.checkEditors(source);
    new ReviewRequestModal(this,source).open();
  }
  review(source,instruction){
    if(this.task)return this.task;
    const task=this.reviewCurrent(source,instruction);this.task=task;task.finally(()=>{if(this.task===task)this.task=null;}).catch(()=>{});return task;
  }
  async reviewCurrent(source,instruction){
    const path=this.path;this.checkCurrent({path});
    if(await this.app.vault.read(this.plugin.noteStore.file(path))!==source)throw new UserError('笔记已变化，请重新开始审稿。');
    const controller=this.controller=new AbortController();this.render();
    try{
      const result=await this.plugin.noteReview({source,instruction,signal:controller.signal,onProgress:t=>this.statusEl?.setText(t)});
      if(controller.signal.aborted)throw new UserError('已停止审稿。');
      if(await this.app.vault.read(this.plugin.noteStore.file(path))!==source)throw new UserError('审稿时原文发生变化，请重新审稿。');
      const issues=validateReview(result,path,source);
      const records=issues.map(issue=>({id:randomUUID(),capture:issue.capture,mode:'edit',state:'review',message:issue.title,review:{title:issue.title,comment:issue.comment,category:issue.category},preserveNumbers:true,date:Date.now()}));
      await this.plugin.state.mutate(data=>{data.notes||={};const thread=data.notes[path]||={draft:null,records:[]};thread.records=[...records,...thread.records];});
      if(this.path===path){this.activeRecord=records[0]?.id;await this.reloadRecords();}
      this.plugin.pointSelect.inline.refresh(path);new Notice(records.length?`AI 留下了 ${records.length} 条审稿意见，正文未修改。`:'本次没有发现需要提出的具体意见。');
    }finally{if(this.controller===controller)this.controller=null;if(!this.closed)this.render();}
  }
  renderReviewTools(root){
    const box=root.createDiv({cls:'folio-review-tools'});
    const header=box.createDiv({cls:'folio-review-heading'});header.createEl('strong',{text:'审稿清单'});
    const start=this.button(header,'请 AI 审稿',()=>this.requestReview(),'folio-review-request-button');start.disabled=!!this.controller;
    const queued=this.records.filter(r=>r.mode==='edit'&&['draft','review'].includes(r.state)&&!r.resolved);
    const ready=this.records.filter(r=>r.mode==='edit'&&r.state==='ready'&&!r.resolved);
    box.createEl('small',{text:`${queued.length} 条意见待处理 · ${ready.length} 处修改待采用`});
    if(queued.length){const b=this.button(box,'为待处理意见生成修改',()=>this.generateQueued(),'folio-review-generate');b.disabled=!!this.controller;}
    if(ready.length){const b=this.button(box,'集中预览与选择修改',()=>new RevisionModal(this,ready).open(),'folio-review-preview');b.disabled=!!this.controller;}
    if(this.lastBatch){const b=this.button(box,'撤销上次整批保存',async()=>{await this.plugin.noteStore.undoBatch(this.path,s=>this.checkEditors(s));await this.reloadRecords();this.plugin.pointSelect.inline.refresh(this.path);},'folio-review-undo');b.disabled=!!this.controller;}
  }
  render(){
    if(this.closed)return;
    const point=this.plugin.pointSelect,inline=point?.composer;
    if(point?.session?.panel===this && inline && (inline.folioCapture!==this.capture || inline.folioMode!==this.mode))point.closeComposer(false);
    const root=this.contentEl;root.empty();root.addClass('folio-note-panel');
    const header=root.createDiv({cls:'folio-note-header'});header.createDiv({cls:'folio-note-eyebrow',text:'FOLIO / 页间'});header.createEl('h2',{text:'笔记里的对话'});
    header.createDiv({cls:'folio-note-follow',text:'跟随当前文档'});
    this.button(header,'收起面板',()=>this.app.workspace.rightSplit.collapse(),'folio-note-collapse');
    if(!this.path){const file=this.plugin.currentNoteLeaf()?.view?.file;root.createEl('p',{text:file?'当前文档暂不支持正文批注。打开 Markdown 笔记后，这里会自动跟随。':'打开一篇 Markdown 笔记，即可在正文点选提问。'});return;}
    header.createDiv({cls:'folio-note-path',text:this.path});this.renderReviewTools(root);
    const target=root.createDiv({cls:'folio-note-target'});
    const pointing=this.plugin.pointSelect?.active(this.path);
    const toggle=this.button(target,pointing?'退出点选 · Esc':'在正文点选',()=>pointing?this.plugin.pointSelect.stop(true):this.plugin.pointSelect.enable(this,this.path),'folio-note-point-toggle');toggle.disabled=!!this.controller;
    target.createDiv({cls:'folio-note-point-hint',text:pointing?'鼠标移到正文查看范围，点击后选择「修改 / 提问」。':'开启后直接点选段落、标题、列表或表格。'});
    if(this.capture){
      this.button(target,`${labelRange(this.capture)} · 在正文中显示`,()=>this.locate(this.capture),'folio-note-link');
      renderSourcePreview(target,this.capture.expected,{className:'folio-sidebar-source'});
    }
    const precise=target.createEl('details',{cls:'folio-note-precise'});precise.createEl('summary',{text:'需要精确选择几个字？'});
    precise.createEl('small',{text:'在编辑模式选中文字，然后使用选区；也可右键选择页间操作。'});
    const pick=this.button(precise,'使用当前选区',()=>this.recapture(),'folio-note-recapture');pick.disabled=!!this.controller;
    const composer=root.createDiv({cls:'folio-note-composer'}),tabs=composer.createDiv({cls:'folio-note-modes'});
    for(const [mode,label]of [['edit','修改笔记原文'],['ask','提问']]){const b=this.button(tabs,label,async()=>{this.mode=mode;await this.persist();this.render();},this.mode===mode?'is-active':'');b.setAttribute('aria-pressed',String(this.mode===mode));b.dataset.mode=mode;b.disabled=!!this.controller;}
    const textarea=composer.createEl('textarea',{attr:{placeholder:this.mode==='ask'?'这段话是什么意思？结论的依据是什么？':'把这段写得更简洁，保留原意。','aria-label':'笔记留言',maxlength:'2000',rows:'4'}});textarea.value=this.message;textarea.disabled=!!this.controller;
    textarea.oninput=()=>{this.message=textarea.value;const inline=this.plugin.pointSelect?.session?.panel===this && this.plugin.pointSelect.composer?.querySelector('textarea');if(inline)inline.value=this.message;this.persist().catch(error=>this.report(error));};
    if(this.replyQuote){renderQuotedAnswer(composer,this.replyQuote);this.button(composer,'取消引用',async()=>{this.replyQuote=null;await this.persist();this.render();});}
    if(this.replyId)composer.createEl('small',{cls:'folio-reply-context',text:'讨论完整保存在本地 · 发给 AI 的历史最多取最近 8 轮，并受长度限制'});
    const detail=composer.createDiv({cls:'folio-note-context',text:this.capture?.partial?'上下文：选区及当前笔记附近内容。不会读取其他笔记。':'上下文：选区及当前笔记。不会读取其他笔记。'});
    if(this.mode==='edit'){
      const label=composer.createEl('label',{cls:'folio-note-numbers'}),check=label.createEl('input',{attr:{type:'checkbox'}});check.checked=this.preserveNumbers;check.disabled=!!this.controller;
      label.appendText('保留数字');check.onchange=()=>{this.preserveNumbers=check.checked;this.persist().catch(e=>this.report(e));};
    }else detail.appendText(' 回答不会修改原文。');
    const send=this.button(composer,this.controller?'正在处理…':this.mode==='ask'?'发送提问':'生成修改建议',()=>this.run(),'mod-cta folio-note-send');send.disabled=!!this.controller||!this.capture;
    if(!this.controller&&this.mode==='edit')this.button(composer,'暂存到审稿清单',()=>this.queueComment(),'folio-review-queue');
    if(this.controller)this.button(composer,'停止',()=>this.stop(),'folio-note-stop');
    this.statusEl=composer.createDiv({cls:'folio-note-status',attr:{role:'status','aria-live':'polite'},text:this.controller?'正在连接本机 Codex…':'留言自动暂存；修改需采用后保存。'});
    const result=this.records.find(r=>r.id===this.activeRecord);
    if(result)this.renderRecord(root,result);
    if(this.records.length){const history=root.createDiv({cls:'folio-note-history'});history.createEl('h3',{text:'留言记录'});history.createEl('small',{text:'原文唯一匹配时留言跟随；无法定位的讨论可重新关联。'});
      const page=historyPage(this.records,this.historyCount||30);
      history.createEl('small',{cls:'folio-history-count',text:`已显示 ${page.records.length} / ${page.total} 条 · 旧上新下`});
      if(page.remaining)this.button(history,`加载更早的讨论（还有 ${page.remaining} 条）`,()=>{this.historyCount=(this.historyCount||30)+30;this.render();},'folio-history-more');
      for(const record of page.records){const states={review:'待讨论',ready:'待采用',answered:'已回答',applied:'已保存',undone:'已撤销',draft:'未发送',error:'失败',cancelled:'已停止',running:'未完成',discarded:'已放弃'};
        this.button(history,`${record.review?'审':record.mode==='ask'?'问':'改'} · ${record.resolved?'已解决':states[record.state]||record.state} · ${record.message.slice(0,55)}`,()=>{this.activeRecord=record.id;this.render();},'folio-note-history-item');}
    }
  }
  renderRecord(root,record){
    const box=root.createDiv({cls:'folio-note-result'});box.createEl('h3',{text:record.mode==='ask'?'回答':'修改建议'});box.createEl('p',{cls:'folio-note-question',text:record.message});
    renderQuotedAnswer(box,record.quote);
    this.button(box,'导出讨论为笔记',()=>new ExportDiscussionModal(this.plugin,record.capture.path,record.id).open(),'folio-discussion-export');
    if(record.turns?.length){const history=box.createEl('details',{cls:'folio-thread-history'});history.createEl('summary',{text:`之前的讨论 · ${record.turns.length} 轮`});for(const turn of record.turns){history.createEl('p',{text:turn.message});renderQuotedAnswer(history,turn.quote);renderAnswer(history.createDiv(),turn.result?.answer||turn.result?.replacement||turn.result?.summary||'');}}
    if(record.review){box.createEl('strong',{text:record.review.title});renderAnswer(box.createDiv({cls:'folio-review-comment'}),record.review.comment);}
    if(record.result && record.mode==='ask'){
      renderAnswer(box.createDiv({cls:'folio-note-answer'}),record.result.answer);
      const citations=box.createDiv({cls:'folio-note-citations'});
      for(const c of record.result.citations)this.button(citations,`引用 · ${labelRange(c)}`,()=>this.locate(record.capture,c));
      if(!record.result.citations.length)citations.createEl('small',{text:'此回答未提供笔记中的直接引用。'});
      this.button(box,'复制回答',()=>this.contentEl.ownerDocument.defaultView.navigator.clipboard.writeText(record.result.answer));
    }else if(typeof record.result?.replacement==='string'){
      box.createEl('p',{text:record.result.summary});
      const diff=box.createEl('pre',{cls:'folio-note-diff'});
      for(const part of diffWordsWithSpace(record.capture.expected,record.result.replacement))diff.createEl(part.added?'ins':part.removed?'del':'span',{text:part.value});
      box.createEl('small',{text:'绿色为新增，红色为删除；只替换所选范围。'});
      if(record.state==='ready'){this.button(box,'采用并保存',()=>this.apply(record),'mod-cta folio-note-apply');this.button(box,'放弃建议',async()=>{await this.saveRecord({...record,state:'discarded'});this.render();});}
      if(record.state==='applied')this.button(box,'撤销这次保存',()=>this.undo(record),'folio-note-undo');
    }else if(!record.review)box.createEl('p',{text:record.error || (record.state==='running'?'这条留言尚未完成，可以重新发送。':'这条留言尚未发送。')});
    if(!this.controller){
      this.button(box,'继续追问',()=>this.reply(record,'ask'),'folio-thread-reply');
      if(latestAnswer(record))this.button(box,'让 AI 重答',()=>this.reply(record,'ask',reanswerMessage(record)),'folio-thread-reanswer');
      this.button(box,'修改笔记原文',()=>this.reply(record,'edit',record.review?.comment||''),'folio-thread-edit');
      this.button(box,record.resolved?'重新打开讨论':'标记已解决',async()=>{await this.saveRecord({...record,resolved:!record.resolved});this.render();},'folio-thread-resolve');
      this.button(box,'关联到当前选区',()=>this.reattach(record),'folio-thread-reattach');
    }
    if(!this.controller)this.button(box,'再次编辑这条留言',()=>this.reply(record,record.mode,record.message));
  }
  dispose(){this.closed=true;this.stop();if(this.plugin.pointSelect?.session?.panel===this)this.plugin.pointSelect.stop(false);this.plugin.pointSelect?.inline.refresh(this.path);}
  async onClose(){this.dispose();await this.persist().catch(e=>new Notice(e.message));this.plugin.noteViews.delete(this);}
}
