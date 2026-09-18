import { MarkdownRenderChild, Notice } from 'obsidian';
import { hash } from '../server/documents.js';
import { renderAnswer } from './answer-markdown.js';

const states={running:'正在回答…',answered:'已回答',ready:'待审阅',applied:'已保存',undone:'已撤销',draft:'未发送',error:'生成失败',cancelled:'已停止',discarded:'已放弃'};

// Render children belong to Obsidian's section lifecycle, including virtualized
// sections. No observers, source edits, or text-search anchors are needed.
export class InlineNotes {
  constructor(plugin){this.plugin=plugin;this.children=new Set();this.byElement=new WeakMap();this.closed=false;plugin.register(()=>{this.closed=true;for(const child of this.children)child.unload();this.children.clear();});}
  register(el,ctx){
    this.byElement.get(el)?.unload();
    const owner=this;
    class Thread extends MarkdownRenderChild {
      onload(){this.path=ctx.sourcePath;owner.children.add(this);this.refresh().catch(error=>new Notice(error.message));}
      onunload(){owner.children.delete(this);this.box?.remove();this.box=null;++this.request;}
      async refresh(){
        const request=this.request=(this.request||0)+1;
        await owner.plugin.ready;
        if(owner.closed || !owner.children.has(this) || request!==this.request)return;
        const info=ctx.getSectionInfo(el);
        const records=owner.plugin.state.data.notes?.[ctx.sourcePath]?.records||[];
        const reading=el.closest('.markdown-reading-view');
        if(!info || !reading || el.closest('.markdown-embed')){this.box?.remove();this.box=null;return;}
        const candidates=records.filter(r=>r.capture.startLine-1>=info.lineStart && r.capture.startLine-1<=info.lineEnd);
        if(!candidates.length){this.box?.remove();this.box=null;return;}
        const file=owner.plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
        if(!file)return;
        let source;try{source=await owner.plugin.app.vault.read(file);}catch{return;}
        if(owner.closed || !owner.children.has(this) || request!==this.request)return;
        const version=hash(source);
        const matching=info.text.replace(/\r\n/g,'\n')===source.replace(/\r\n/g,'\n') ? candidates.filter(r=>r.capture.version===version):[];
        const opened=new Set([...this.box?.querySelectorAll('details[open]')||[]].map(e=>e.dataset.record));
        this.box?.remove();this.box=null;
        if(!matching.length)return;
        const box=this.box=el.createDiv({cls:'folio-inline-thread',attr:{'data-folio-note-ui':'true','aria-label':'这段的留言'}});
        for(const record of matching){
          const card=box.createEl('details',{cls:'folio-inline-card',attr:{'data-record':record.id}});card.open=opened.has(record.id);
          const summary=card.createEl('summary');
          const running=[...owner.plugin.noteViews].some(v=>v.path===ctx.sourcePath && v.controller && !v.closed);
          const state=record.state==='running'?running?(record.mode==='edit'?'正在生成…':'正在回答…'):'未完成，可重新发送':states[record.state]||record.state;
          summary.createSpan({cls:'folio-inline-meta',text:`${record.mode==='ask'?'提问':'修改'} · ${state}`});
          summary.createSpan({cls:'folio-inline-question',text:record.message});
          const body=card.createDiv({cls:'folio-inline-body'});
          if(record.mode==='ask' && record.result)renderAnswer(body.createDiv({cls:'folio-inline-answer'}),record.result.answer);
          else body.createDiv({text:record.error || record.result?.summary || (record.state==='running'?'留言已保存，正在等待 AI。':'这条留言尚未发送。')});
          const button=body.createEl('button',{text:record.mode==='edit'&&record.result?'审阅修改':record.state==='error'||record.state==='cancelled'||record.state==='draft'?'查看 / 重新编辑':'查看详情与引用'});
          button.onclick=async()=>{try{const panel=await owner.plugin.notePanel(owner.plugin.noteStore.file(ctx.sourcePath));panel.activeRecord=record.id;panel.render();await owner.plugin.app.workspace.revealLeaf(panel.leaf);}catch(error){new Notice(error.message);}};
        }
      }
    }
    const child=new Thread(el);this.byElement.set(el,child);ctx.addChild(child);
  }
  refresh(path){for(const child of this.children){if(child.path!==path || !child.containerEl.isConnected)continue;child.refresh().catch(error=>new Notice(error.message));}}
}
