import { Notice } from 'obsidian';
import { recordCapture } from './review.js';
import { renderSourcePreview } from './source-preview.js';
import { latestAnswer, reanswerMessage } from './reanswer.js';
import { createAnswerQuote, validateAnswerQuote, inlineDraft, renderQuotedAnswer } from './answer-quote.js';

// One visible composer; drafts belong to discussions, not the shared sidebar.
export class InlineReply {
  constructor(plugin) {
    this.plugin=plugin;this.answers=new WeakMap();this.documents=new Set();
    plugin.register(()=>{this.close(false);this.hideQuoteTool();});
  }
  registerAnswer(element,record,index){
    element.dataset.folioAnswerIndex=String(index);this.answers.set(element,{record,index});
    const doc=element.ownerDocument;if(this.documents.has(doc))return;this.documents.add(doc);
    const selection=()=>this.selectionChanged(doc),scroll=()=>this.hideQuoteTool();
    doc.addEventListener('selectionchange',selection);doc.addEventListener('scroll',scroll,true);
    this.plugin.register(()=>{doc.removeEventListener('selectionchange',selection);doc.removeEventListener('scroll',scroll,true);});
  }
  hideQuoteTool(){this.quoteTool?.remove();this.quoteTool=null;}
  selectionChanged(doc){
    this.hideQuoteTool();if(this.submitting||this.plugin.unloading)return;
    const selection=doc.getSelection();if(!selection?.rangeCount||selection.isCollapsed)return;
    const range=selection.getRangeAt(0),node=range.startContainer;
    const answer=(node.nodeType===1?node:node.parentElement)?.closest('[data-folio-answer-index]');
    const meta=this.answers.get(answer);if(!meta||!answer.isConnected||!answer.contains(range.endContainer))return;
    let quote;try{quote=createAnswerQuote(meta.record,meta.index,selection.toString());}catch{return;}
    const body=answer.closest('.folio-inline-body'),rect=range.getBoundingClientRect();if(!body||!rect.height)return;
    const button=this.quoteTool=doc.body.createEl('button',{text:'引用追问',cls:'folio-answer-quote-tool',attr:{'data-folio-note-ui':'true','aria-label':'引用选中的 AI 回答继续追问'}});
    const win=doc.defaultView;
    button.style.left=Math.max(8,Math.min(rect.left,win.innerWidth-button.offsetWidth-8))+'px';
    button.style.top=Math.max(8,Math.min(rect.bottom+6,win.innerHeight-button.offsetHeight-8))+'px';
    button.onmousedown=event=>event.preventDefault();
    button.onclick=()=>{this.hideQuoteTool();this.open(meta.record,body,body.querySelector('.folio-inline-reply'),quote);this.active?.box.scrollIntoView({block:'nearest'});selection.removeAllRanges();};
  }
  mount(path,id,body,record){
    const editor=this.active;
    if(editor?.path===path&&editor.id===id&&body.closest('.markdown-reading-view')===editor.reading){body.append(editor.box);editor.trigger=body.querySelector('.folio-inline-reply');if(record)editor.record=record;}
  }
  close(focus=true){
    const editor=this.active;if(!editor)return;editor.box.remove();this.active=null;
    if(focus)editor.trigger?.focus({preventScroll:true});
  }
  async persist(editor){
    const draft={text:editor.input.value,mode:editor.mode,quote:editor.quote,preserveNumbers:editor.numbers.checked};
    await this.plugin.state.mutate(data=>{
      const thread=data.notes?.[editor.path];if(!thread?.records.some(r=>r.id===editor.id))return;
      const drafts=thread.inlineDrafts||={};
      if(draft.text||draft.quote||draft.mode!=='ask'||!draft.preserveNumbers)drafts[editor.id]=draft;else delete drafts[editor.id];
      for(const id of Object.keys(drafts))if(!thread.records.some(r=>r.id===id))delete drafts[id];
    });
  }
  update(editor){
    for(const button of editor.modeButtons){button.disabled=editor.busy||(button.dataset.mode==='reanswer'&&!latestAnswer(editor.record));button.setAttribute('aria-pressed',String(button.dataset.mode===editor.mode));button.classList.toggle('is-active',button.dataset.mode===editor.mode);}
    editor.send.textContent=editor.mode==='edit'?'生成原文修改建议':editor.mode==='reanswer'?'重新生成回答':'发送追问';
    editor.input.placeholder=editor.mode==='edit'?'希望怎样修改原笔记的这段内容？':editor.mode==='reanswer'?'希望怎样调整回答？例如：更简洁、给个例子（可不填）':'接着问问，或请 AI 进一步解释…';
    editor.input.setAttribute('aria-label',editor.mode==='edit'?'原文修改要求':editor.mode==='reanswer'?'回答调整要求':'继续追问');
    editor.intent.setText(editor.mode==='edit'?'对象：关联笔记原文 · 预览确认后才保存':editor.mode==='reanswer'?'对象：上一份 AI 回答 · 旧回答保留，笔记不变':'继续讨论 · 回答不会修改笔记');
    editor.target.hidden=editor.mode!=='edit';editor.numberLabel.hidden=editor.mode!=='edit';editor.numbers.disabled=editor.busy;
    editor.quoted.empty();
    if(editor.quote){renderQuotedAnswer(editor.quoted,editor.quote);const remove=editor.quoted.createEl('button',{text:'取消引用',cls:'folio-cancel-quote'});remove.disabled=editor.busy;remove.onclick=()=>{editor.quote=null;this.update(editor);this.persist(editor).catch(()=>editor.status.setText('草稿保存失败'));};}
  }
  open(record,body,trigger,quote=null){
    if(this.submitting){new Notice('请先等待或停止当前生成，再继续讨论。');return;}
    if(this.active?.id===record.id&&this.active.path===record.capture.path){
      if(quote){this.active.quote=quote;this.active.mode='ask';this.update(this.active);this.persist(this.active).catch(()=>this.active?.status.setText('草稿保存失败'));}
      this.active.input.focus({preventScroll:true});return;
    }
    this.close(false);this.plugin.pointSelect.clearSelection();
    const draft=inlineDraft(this.plugin.state.data.notes?.[record.capture.path]?.inlineDrafts?.[record.id]);
    const box=body.createDiv({cls:'folio-card-composer',attr:{'data-folio-note-ui':'true'}});
    const header=box.createDiv({cls:'folio-card-composer-header'});header.createEl('strong',{text:'继续这条讨论'});
    const close=header.createEl('button',{text:'收起',attr:{'aria-label':'收起追问，保留草稿'}});
    const tabs=box.createDiv({cls:'folio-card-modes',attr:{'aria-label':'讨论模式'}});
    const modeButtons=[['ask','继续提问'],['reanswer','让 AI 重答'],['edit','修改笔记原文']].map(([mode,text])=>tabs.createEl('button',{text,attr:{'data-mode':mode}}));
    const intent=box.createDiv({cls:'folio-card-intent',attr:{role:'status'}});
    const quoted=box.createDiv({cls:'folio-card-quote'});
    const target=renderSourcePreview(box,(record.anchor||record.capture).expected,{title:'修改原笔记的关联段落'});
    const input=box.createEl('textarea',{attr:{rows:'3',maxlength:'2000','aria-label':'继续追问'}});input.value=draft.text;
    const numberLabel=box.createEl('label',{cls:'folio-note-numbers'}),numbers=numberLabel.createEl('input',{attr:{type:'checkbox'}});numberLabel.appendText('保留数字');numbers.checked=draft.preserveNumbers;
    const footer=box.createDiv({cls:'folio-card-composer-footer'}),status=footer.createSpan({text:'草稿自动保存 · ⌘ / Ctrl + Enter 发送',attr:{role:'status'}});
    const send=footer.createEl('button',{cls:'mod-cta folio-card-send'});
    const editor=this.active={record,path:record.capture.path,id:record.id,box,input,status,send,trigger,reading:body.closest('.markdown-reading-view'),busy:false,mode:quote?'ask':draft.mode,quote:quote||draft.quote,modeButtons,intent,quoted,target,numberLabel,numbers};
    this.update(editor);close.onclick=()=>this.close();
    const save=()=>this.persist(editor).catch(()=>status.setText('草稿保存失败，请保留输入后重试。'));
    for(const button of modeButtons)button.onclick=()=>{editor.mode=button.dataset.mode;this.update(editor);save();};
    numbers.onchange=input.oninput=save;
    input.onkeydown=event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();this.close();}
      if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)&&!event.isComposing){event.preventDefault();this.submit(editor);}
    };
    send.onclick=()=>this.submit(editor);if(quote)save();input.focus({preventScroll:true});
  }
  async submit(editor){
    if(editor.busy)return;
    if(this.submitting){editor.status.setText('请先等待或停止当前生成。');return;}
    if(!editor.input.value.trim()&&editor.mode!=='reanswer'){editor.status.setText('请写下问题或修改要求。');return;}
    this.hideQuoteTool();this.submitting=editor;editor.busy=true;editor.send.disabled=true;editor.input.disabled=true;this.update(editor);
    try{
      await this.persist(editor);
      const file=this.plugin.noteStore.file(editor.path),panel=await this.plugin.notePanel(file,{reveal:false});
      if(panel.controller||panel.task)throw new Error('请先等待或停止当前生成。');
      const record=panel.records.find(r=>r.id===editor.id);
      if(!record||record.resolved)throw new Error('这条讨论已更新，请重新打开后操作。');
      const quote=validateAnswerQuote(record,editor.quote),capture=recordCapture(record,await this.plugin.app.vault.read(file));panel.checkCurrent(capture);
      const mode=editor.mode==='edit'?'edit':'ask',message=editor.mode==='reanswer'?reanswerMessage(record,editor.input.value):editor.input.value;
      await panel.useCapture(capture,mode,{replyId:editor.id,focus:false,quote});
      if(this.plugin.unloading||panel.closed||panel.path!==editor.path)throw new Error('笔记已关闭或切换，输入已保留。');
      panel.message=message;panel.preserveNumbers=editor.numbers.checked;panel.inlineSubmission=true;
      editor.status.setText(editor.mode==='edit'?'正在生成修改，原文尚未保存…':'正在回答，可在卡片中停止…');
      try{await panel.run();}finally{panel.inlineSubmission=false;}
      const result=panel.records.find(r=>r.id===editor.id);
      if(result)editor.record=result;
      if(result?.state===(editor.mode==='edit'?'ready':'answered')){
        editor.input.value='';editor.quote=null;await this.persist(editor);editor.status.setText(editor.mode==='edit'?'建议已生成 · 点击卡片“预览并保存”后决定是否采用':'可以继续追问 · 回答不会修改原文');
      }else editor.status.setText(result?.error||'未完成，输入已保留，可以重试。');
    }catch(error){editor.status.setText(error.message);}
    finally{if(this.submitting===editor)this.submitting=null;editor.busy=false;editor.send.disabled=false;editor.input.disabled=false;this.update(editor);}
  }
  stop(path){const panel=[...this.plugin.noteViews].find(v=>v.path===path&&v.controller);if(panel)panel.stop();else new Notice('当前没有正在生成的回答。');}
}
