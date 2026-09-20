import { MarkdownRenderChild, Notice } from 'obsidian';
import { recordCapture } from './review.js';
import { renderAnswer } from './answer-markdown.js';
import { InlineReply } from './inline-reply.js';
import { chronologicalRecords } from './conversation.js';
import { ExportDiscussionModal } from './export-modal.js';
import { renderQuotedAnswer } from './answer-quote.js';
import { RevisionModal } from './review-ui.js';

const states={review:'审稿意见',running:'正在回答…',answered:'已回答',ready:'待审阅',applied:'已保存',undone:'已撤销',draft:'未发送',error:'生成失败',cancelled:'已停止',discarded:'已放弃'};

// Render children belong to Obsidian's section lifecycle, including virtualized
// sections. Quote anchors are resolved against the current source before rendering.
export class InlineNotes {
  constructor(plugin){this.plugin=plugin;this.reply=new InlineReply(plugin);this.children=new Set();this.byElement=new WeakMap();this.closed=false;plugin.register(()=>{this.closed=true;for(const child of this.children)child.unload();this.children.clear();});}
  remember(details,path,id,key){
    let previous=details.open;
    details.addEventListener('toggle',()=>{
      if(this.closed||!details.isConnected||details.open===previous)return;
      previous=details.open;
      this.plugin.noteStore.display(path,id,{[key]:previous}).catch(error=>new Notice(error.message));
    });
  }
  register(el,ctx){
    this.byElement.get(el)?.unload();
    const owner=this;
    class Thread extends MarkdownRenderChild {
      onload(){this.path=ctx.sourcePath;owner.children.add(this);this.refresh().catch(error=>new Notice(error.message));}
      onunload(){clearTimeout(this.retryTimer);owner.children.delete(this);this.box?.remove();this.box=null;++this.request;}
      async refresh(){
        clearTimeout(this.retryTimer);
        const request=this.request=(this.request||0)+1;
        await owner.plugin.ready;
        if(owner.closed || !owner.children.has(this) || request!==this.request)return;
        let info=ctx.getSectionInfo(el);
        const records=owner.plugin.state.data.notes?.[ctx.sourcePath]?.records||[];
        const reading=el.closest('.markdown-reading-view');
        if(!info || !reading || el.closest('.markdown-embed')){this.box?.remove();this.box=null;return;}
        const candidates=chronologicalRecords(records.filter(r=>!r.resolved));
        if(!candidates.length){this.box?.remove();this.box=null;return;}
        const file=owner.plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
        if(!file)return;
        let source;try{source=await owner.plugin.app.vault.read(file);}catch{return;}
        if(owner.closed || !owner.children.has(this) || request!==this.request)return;
        info=ctx.getSectionInfo(el);
        if(!info||info.text.replace(/\r\n/g,'\n')!==source.replace(/\r\n/g,'\n')){
          this.box?.remove();this.box=null;
          if((this.retries=(this.retries||0)+1)<=20)this.retryTimer=setTimeout(()=>this.refresh().catch(error=>new Notice(error.message)),100);
          return;
        }
        this.retries=0;
        const located=candidates.flatMap(r=>{try{return [{record:r,capture:recordCapture(r,source)}];}catch{return [];}});
        const matching=info.text.replace(/\r\n/g,'\n')===source.replace(/\r\n/g,'\n') ? located.filter(({capture})=>capture.startLine-1>=info.lineStart&&capture.startLine-1<=info.lineEnd).map(({record})=>record):[];
        const display=new Map([...this.box?.querySelectorAll('details[data-record]')||[]].map(e=>[e.dataset.record,{open:e.open,historyOpen:e.querySelector('.folio-card-history')?.open??true}]));
        const editor=owner.reply.active,focused=editor?.input===el.ownerDocument.activeElement;
        const selection=focused?[editor.input.selectionStart,editor.input.selectionEnd]:null;
        this.box?.remove();this.box=null;
        if(!matching.length)return;
        const box=this.box=el.createDiv({cls:'folio-inline-thread',attr:{'data-folio-note-ui':'true','aria-label':'这段的留言'}});
        for(const record of matching){
          const saved=display.get(record.id)||owner.plugin.state.data.notes?.[ctx.sourcePath]?.display?.[record.id]||{};
          const card=box.createEl('details',{cls:'folio-inline-card',attr:{'data-record':record.id}});card.open=saved.open??(editor?.path===ctx.sourcePath&&editor.id===record.id);
          owner.remember(card,ctx.sourcePath,record.id,'open');
          card.classList.toggle('has-history',!!record.turns?.length);
          const summary=card.createEl('summary');
          const running=[...owner.plugin.noteViews].some(v=>v.path===ctx.sourcePath && v.controller && !v.closed);
          const state=record.state==='running'?running?(record.mode==='edit'?'正在生成…':'正在回答…'):'未完成，可重新发送':states[record.state]||record.state;
          summary.createSpan({cls:'folio-inline-meta',text:`${record.review?'审稿':record.mode==='ask'?'提问':'修改'} · ${state}`});
          summary.createSpan({cls:'folio-inline-question',text:record.turns?.[0]?.message||record.message});
          const body=card.createDiv({cls:'folio-inline-body'});
          if(record.turns?.length){
            const history=body.createEl('details',{cls:'folio-card-history'});history.open=saved.historyOpen!==false;
            history.createEl('summary',{text:`之前的讨论 · ${record.turns.length} 轮`});
            owner.remember(history,ctx.sourcePath,record.id,'historyOpen');
            for(const [index,turn] of record.turns.entries()){
              const item=history.createDiv({cls:'folio-conversation-turn'});
              item.createDiv({cls:'folio-turn-meta',text:turn.mode==='ask'?'提问 · 已回答':'修改 · 已生成建议'});
              item.createEl('p',{cls:'folio-card-history-question',text:turn.message});
              renderQuotedAnswer(item,turn.quote);
              const answer=item.createDiv();renderAnswer(answer,turn.result?.answer||turn.result?.replacement||turn.result?.summary||'');
              if(turn.result?.answer)owner.reply.registerAnswer(answer,record,index);
            }
            const current=body.createDiv({cls:'folio-conversation-current'});
            current.createDiv({cls:'folio-turn-meta',text:`${record.mode==='ask'?'追问':'修改'} · ${state}`});
            current.createEl('p',{cls:'folio-card-history-question',text:record.message});
          }
          renderQuotedAnswer(body,record.quote);
          if(record.mode==='ask' && record.result){const answer=body.createDiv({cls:'folio-inline-answer'});renderAnswer(answer,record.result.answer);owner.reply.registerAnswer(answer,record,record.turns?.length||0);}
          else body.createDiv({text:record.error || record.result?.summary || record.review?.comment || (record.state==='running'?'留言已保存，正在等待 AI。':'这条留言尚未发送。')});
          const actions=body.createDiv({cls:'folio-card-actions'});
          const reply=actions.createEl('button',{text:'继续追问',cls:'folio-inline-reply'});reply.disabled=record.state==='running'&&running;
          reply.onclick=()=>owner.reply.open(record,body,reply);
          if(record.state==='running'&&running){const stop=actions.createEl('button',{text:record.mode==='edit'?'停止生成':'停止回答',cls:'folio-card-stop'});stop.onclick=()=>owner.reply.stop(ctx.sourcePath);}
          const ready=record.mode==='edit'&&record.state==='ready';
          const button=actions.createEl('button',{text:ready?'预览并保存':record.mode==='edit'&&record.result?'审阅修改':record.state==='error'||record.state==='cancelled'||record.state==='draft'?'查看 / 重新编辑':'查看详情与引用'});
          button.onclick=async()=>{try{const panel=await owner.plugin.notePanel(owner.plugin.noteStore.file(ctx.sourcePath),{reveal:!ready});panel.activeRecord=record.id;panel.render();if(ready){const latest=panel.records.find(r=>r.id===record.id);if(latest?.state!=='ready')throw new Error('建议已更新，请重新打开。');new RevisionModal(panel,[latest]).open();}else await owner.plugin.app.workspace.revealLeaf(panel.leaf);}catch(error){new Notice(error.message);}};
          const exportButton=actions.createEl('button',{text:'导出讨论',cls:'folio-discussion-export',attr:{title:'选择保存位置，导出已保存的全部轮次'}});
          exportButton.onclick=()=>new ExportDiscussionModal(owner.plugin,ctx.sourcePath,record.id).open();
          owner.reply.mount(ctx.sourcePath,record.id,body,record);
        }
        if(focused&&editor.input.isConnected){editor.input.focus({preventScroll:true});editor.input.setSelectionRange(...selection);}
      }
    }
    const child=new Thread(el);this.byElement.set(el,child);ctx.addChild(child);
  }
  refresh(path){for(const child of this.children){if(child.path!==path || !child.containerEl.isConnected)continue;child.refresh().catch(error=>new Notice(error.message));}}
}
