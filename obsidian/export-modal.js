import { Modal, FuzzySuggestModal, TFolder, Notice } from 'obsidian';
import { defaultExportPath, exportPath, checkExportTarget } from './export-path.js';

class ExportFolderPicker extends FuzzySuggestModal {
  constructor(app,choose){super(app);this.choose=choose;this.setPlaceholder('选择笔记库中的目录');}
  getItems(){return this.app.vault.getAllLoadedFiles().filter(f=>f instanceof TFolder);}
  getItemText(folder){return folder.isRoot()?'笔记库根目录':folder.path;}
  onChooseItem(folder){this.choose(folder.isRoot()?'':folder.path);}
}

export class ExportDiscussionModal extends Modal {
  constructor(plugin,path,id){super(plugin.app);Object.assign(this,{plugin,path,id});plugin.register(()=>this.close());}
  onOpen(){
    this.closed=false;this.setTitle('导出讨论');this.modalEl.addClass('folio-export-modal');
    const root=this.contentEl,initial=defaultExportPath(this.app.vault,this.path).split('/'),name=initial.pop();
    root.createEl('p',{cls:'folio-export-hint',text:'保存完整问答与原文摘录为 Markdown 笔记。默认与原笔记放在一起。'});
    const folderLabel=root.createEl('label',{cls:'folio-export-field'});folderLabel.createSpan({text:'保存目录'});
    const folderRow=folderLabel.createDiv({cls:'folio-export-folder'});
    this.folder=folderRow.createEl('input',{attr:{type:'text','aria-label':'保存目录',placeholder:'笔记库根目录'}});this.folder.value=initial.join('/');
    this.browse=folderRow.createEl('button',{text:'选择目录',attr:{type:'button'}});
    this.browse.onclick=()=>new ExportFolderPicker(this.app,folder=>{if(this.closed||this.saving)return;this.folder.value=folder;this.refresh();}).open();
    root.createEl('small',{cls:'folio-export-hint',text:'填写笔记库内路径；留空为根目录，新目录会在确认导出后创建。'});
    const nameLabel=root.createEl('label',{cls:'folio-export-field'});nameLabel.createSpan({text:'文件名'});
    this.filename=nameLabel.createEl('input',{attr:{type:'text','aria-label':'文件名'}});this.filename.value=name;
    this.preview=root.createDiv({cls:'folio-export-preview',attr:{'aria-label':'最终保存位置'}});
    this.status=root.createDiv({cls:'folio-export-status',attr:{role:'status','aria-live':'polite'}});
    const footer=root.createDiv({cls:'folio-export-footer'});
    this.cancel=footer.createEl('button',{text:'取消'});this.cancel.onclick=()=>this.close();
    this.save=footer.createEl('button',{text:'确认导出',cls:'mod-cta folio-export-confirm'});this.save.onclick=()=>this.commit();
    this.folder.oninput=this.filename.oninput=()=>this.refresh();this.refresh();
  }
  refresh(){
    if(this.saving)return;
    try{this.target=exportPath(this.folder.value,this.filename.value);this.preview.setText('保存到：'+this.target);checkExportTarget(this.app.vault,this.target);this.status.setText('');this.save.disabled=false;}
    catch(error){this.target=null;this.preview.setText('请检查保存目录和文件名');this.status.setText(error.message);this.save.disabled=true;}
  }
  async commit(){
    if(this.saving||this.closed)return;this.refresh();if(!this.target)return;
    this.saving=true;const target=this.target;
    const controls=[this.folder,this.filename,this.browse,this.save,this.cancel];controls.forEach(el=>el.disabled=true);this.status.setText('正在导出…');
    try{const file=await this.plugin.noteStore.exportDiscussion(this.path,this.id,target);this.close();new Notice(`讨论已导出：${file.path}`);}
    catch(error){this.status.setText(error.message||'导出失败，请检查保存目录。');}
    finally{this.saving=false;controls.forEach(el=>el.disabled=false);}
  }
  onClose(){this.closed=true;}
}
