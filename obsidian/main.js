import { Plugin, ItemView, PluginSettingTab, Setting, Notice, TFile, MarkdownView } from 'obsidian';
import { randomBytes } from 'node:crypto';
import { VaultStore, PluginState } from './vault-store.js';
import { WorkspaceService } from './service.js';
import { installClient } from './client.js';
import { codexStatus, generateWithCodex, generateNoteWithCodex, generateReviewWithCodex } from '../server/codex.js';
import { captureNote } from './notes.js';
import { ReviewStore } from './review-store.js';
import { NoteView, NotePicker, NOTE_VIEW } from './note-view.js';
import { NotePointSelect } from './point-select.js';
import { UserError, inspect, MAX_IMPORT_BYTES } from '../server/documents.js';
import { extractEmbeddedImages } from './images.js';
import { webUtils } from 'electron';
import assets from 'folio-assets';

const VIEW = 'folio-workbench';
const safeScript = text => text.replace(/<\/script/gi, '<\\/script');

class FolioView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW; }
  getDisplayText() { return this.initialId?'页间 · HTML 批注':'页间'; }
  getIcon() { return 'message-square-text'; }
  getState() { return { file: this.initialId || null }; }
  async setState(state, result) {
    if (state?.file && state.file !== this.initialId) { this.initialId = state.file; if (this.frame) await this.mount(); }
    await super.setState(state, result);
  }
  async onOpen() { this.plugin.views.add(this); await this.mount(); }
  dispose() {
    this.cancelPicker?.(); this.pendingImport = null;
    this.generation = (this.generation || 0) + 1;
    this.service?.close(); this.removeListener?.(); this.removeListener = null;
    this.frame?.remove(); this.frame = null;
  }
  async chooseImport() {
    const generation = this.generation;
    this.cancelPicker?.(); this.pendingImport = null;
    const file = await new Promise(resolve => {
      const input = this.contentEl.createEl('input', { attr: { type: 'file', accept: '.html,.htm', 'data-folio-import': 'true' } });
      input.style.display = 'none';
      const finish = value => { clearTimeout(timer); input.remove(); this.cancelPicker = null; resolve(value); };
      const timer = setTimeout(() => finish(null), 240_000);
      this.cancelPicker = () => finish(null);
      input.onchange = () => finish(input.files?.[0] || null);
      input.addEventListener('cancel', () => finish(null), { once: true }); input.click();
    });
    if (!file) return null;
    if (file.size > MAX_IMPORT_BYTES) throw new UserError('请选择不超过 25 MB 的 HTML 文件。', 413);
    const sourcePath = webUtils?.getPathForFile ? webUtils.getPathForFile(file) : file.path;
    const source = await file.text();
    if (generation !== this.generation || this.service.closed) throw new UserError('工作台已关闭。');
    const extracted = extractEmbeddedImages(source);
    try { inspect(extracted.source); }
    catch (error) {
      if (error.status === 413) throw error;
      const token = randomBytes(24).toString('hex');
      this.pendingImport = { token, name: file.name, source, sourcePath };
      return { candidate: token, name: file.name, reason: error.message };
    }
    return this.plugin.store.import(file.name, source, { sourcePath });
  }
  async mount() {
    this.dispose(); const generation = this.generation;
    this.contentEl.empty(); this.contentEl.addClass('folio-view');
    try {
      await this.plugin.ready;
      const local = await this.plugin.state.request('storage/get');
      if (generation !== this.generation) return;
      const channel = randomBytes(24).toString('hex'), nonce = randomBytes(24).toString('hex');
      const service = this.service = new WorkspaceService({ store: this.plugin.store, state: this.plugin.state, bridge: assets.frame, nonce, version: this.plugin.manifest.version, status: () => codexStatus(this.plugin.options()), generate: args => generateWithCodex({ ...args, codexOptions: this.plugin.options() }) });
      const frame = this.frame = this.contentEl.createEl('iframe', { cls: 'folio-workbench', attr: { title: '页间 HTML 工作台', sandbox: 'allow-scripts allow-modals allow-downloads' } });
      const win = this.contentEl.ownerDocument.defaultView;
      const onMessage = async event => {
        if (event.source !== frame.contentWindow || event.data?.folio !== channel || !Number.isSafeInteger(event.data.id)) return;
        const { id, route, data } = event.data;
        try {
          if (service.closed) throw new UserError('工作台已关闭。');
          let value;
          if (route === 'active-document') { this.plugin.store.file(data.id); this.initialId = data.id; service.activeId = data.id; service.imageCache = new Map(); this.app.workspace.requestSaveLayout(); }
          else if (route === 'import/file') value = await this.chooseImport();
          else if (route === 'notes/open') new NotePicker(this.app,this.plugin).open();
          else if (route === 'import/convert') {
            const pending = this.pendingImport;
            if (!pending || data.token !== pending.token) throw new UserError('导入已过期，请重新选择文件。');
            value = await this.plugin.store.importStatic(pending.name, pending.source, { sourcePath: pending.sourcePath }); this.pendingImport = null;
          }
          else if (route === 'export') { const copy = await this.plugin.store.export(this.initialId, data.name, data.source); new Notice(`已另存到笔记库 Folio/${copy.name}`); value = copy.name; }
          else if (route === 'clipboard') { if (typeof data?.text !== 'string' || data.text.length > 2000) throw new UserError('复制内容无效。'); await win.navigator.clipboard.writeText(data.text); }
          else value = await service.request(route, data);
          frame.contentWindow?.postMessage({ folio: channel, id, value }, '*');
        } catch (error) {
          const message = error instanceof UserError ? error.message : /^(storage|recovery)\//.test(route) ? '自动暂存失败，请保存文档；检查笔记库可写空间。' : '操作失败，请检查文件权限或重新打开工作台。';
          frame.contentWindow?.postMessage({ folio: channel, id, error: message, status: error instanceof UserError ? error.status : 500 }, '*');
        }
      };
      win.addEventListener('message', onMessage); this.removeListener = () => win.removeEventListener('message', onMessage);
      const prelude = `(${installClient.toString()})(${JSON.stringify({ channel, local, initialId: this.initialId })});`;
      const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; frame-src about: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'`;
      frame.srcdoc = assets.html
        .replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`)
        .replace('<link rel="stylesheet" href="/style.css">', `<style>${assets.css}</style>`)
        .replace('<script type="module" src="/app.js"></script>', '')
        .replace('href="/"', 'href="#"')
        .replace('导出 HTML ↗', '另存 HTML ↗')
        .replace('</body>', `<script nonce="${nonce}">${safeScript(prelude + '\n' + assets.app)}</script></body>`);
    } catch { this.contentEl.createEl('p', { text: '页间无法读取插件数据。请检查笔记库权限，并备份插件目录中的 state.json 后再排查。' }); }
  }
  async onClose() { this.dispose(); this.plugin.views.delete(this); }
}

class FolioSettings extends PluginSettingTab {
  display() {
    this.containerEl.empty(); this.containerEl.createEl('h2', { text: '页间 · 本机 Codex' });
    this.containerEl.createEl('p', { text: '沿用你自己的 Codex 登录和模型配置。设置后重新打开工作台生效。不会把 Key 保存到插件设置。' });
    new Setting(this.containerEl).setName('Codex 可执行文件').setDesc('留空自动查找；找不到时填写 codex 的完整路径。').addText(text => text.setPlaceholder('/完整路径/codex').setValue(this.plugin.settings.executable).onChange(async value => { this.plugin.settings.executable = value.trim(); await this.plugin.saveData(this.plugin.settings); }));
    new Setting(this.containerEl).setName('Codex 配置目录（可选）').setDesc('留空使用默认 ~/.codex；需要时填写独立 CODEX_HOME 的完整路径。').addText(text => text.setValue(this.plugin.settings.home).onChange(async value => { this.plugin.settings.home = value.trim(); await this.plugin.saveData(this.plugin.settings); }));
    new Setting(this.containerEl).setName('检查 Codex').setDesc('只检查可执行文件和配置；不发送模型请求。').addButton(button => button.setButtonText('检查连接配置').onClick(async () => { const status = await codexStatus(this.plugin.options()); new Notice(status.available ? `${status.version} · ${status.model} · ${status.provider}` : status.message); }));
  }
}

export default class FolioPlugin extends Plugin {
  options() { return { executable: this.settings.executable, home: this.settings.home }; }
  async onload() {
    this.views = new Set(); this.noteViews=new Set(); this.followRequest=0;this.settings = { executable: '', home: '', ...await this.loadData() };
    const directory = this.manifest.dir || `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    this.store = new VaultStore(this.app.vault, directory);
    this.state = new PluginState(this.app.vault.adapter, directory);
    this.noteStore=new ReviewStore(this.app.vault,this.state,directory);
    this.noteReview=args=>generateReviewWithCodex({...args,codexOptions:this.options()});
    this.noteGenerate=args=>generateNoteWithCodex({...args,codexOptions:this.options()});
    this.ready = this.state.init(); this.ready.catch(() => new Notice('页间草稿存储无法打开，请检查插件数据。'));
    this.registerView(VIEW, leaf => new FolioView(leaf, this));
    this.registerView(NOTE_VIEW,leaf=>new NoteView(leaf,this));
    this.pointSelect=new NotePointSelect(this);
    this.registerEvent(this.app.workspace.on('active-leaf-change',leaf=>{if(leaf?.view instanceof MarkdownView)this.lastNoteEditor=leaf.view;this.scheduleNoteFollow();}));
    this.registerEvent(this.app.workspace.on('file-open',()=>this.scheduleNoteFollow()));
    this.registerEvent(this.app.vault.on('rename',(file,oldPath)=>{this.renameQueue=(this.renameQueue||Promise.resolve()).catch(()=>{}).then(()=>this.renameNotes(file,oldPath));this.renameQueue.catch(e=>new Notice(e.message));}));
    this.app.workspace.onLayoutReady(()=>this.scheduleNoteFollow());
    const entry=this.addRibbonIcon('message-square-text','页间：批注当前文档',()=>this.openUnified().catch(e=>new Notice(e.message)));entry.dataset.folioEntry='true';
    this.addCommand({id:'open',name:'批注当前文档',callback:()=>this.openUnified().catch(e=>new Notice(e.message))});
    this.addCommand({id:'html-open',name:'打开文档选择与 HTML 导入',callback:()=>this.open().catch(e=>new Notice(e.message))});
    this.addCommand({id:'note-open',name:'对当前笔记留言',callback:()=>this.openCurrentNote().catch(e=>new Notice(e.message))});
    this.addCommand({id:'note-pick',name:'浏览其他 Markdown 笔记',callback:()=>new NotePicker(this.app,this).open()});
    for(const [mode,label] of [['edit','修改'],['ask','提问']])this.addCommand({id:`note-${mode}`,name:`对选中文字${label}`,editorCallback:(editor,ctx)=>this.openNoteSelection(editor,ctx,mode).catch(e=>new Notice(e.message))});
    this.registerEvent(this.app.workspace.on('editor-menu',(menu,editor,ctx)=>{
      if(ctx.file?.extension!=='md')return;
      for(const [mode,label] of [['edit','修改'],['ask','提问']])menu.addItem(item=>item.setTitle(`页间：${label}`).setIcon(mode==='ask'?'message-circle-question':'pencil').onClick(()=>this.openNoteSelection(editor,ctx,mode).catch(e=>new Notice(e.message))));
    }));
    this.addCommand({ id: 'sample', name: '创建 HTML 示例并开始批注', callback: async () => { try { const doc = await this.store.import('页间示例.html', assets.sample); await this.open(doc.id); } catch { new Notice('无法创建示例，请检查笔记库权限。'); } } });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => { if (file instanceof TFile && /^(html|htm)$/i.test(file.extension)) menu.addItem(item => item.setTitle('用页间打开并批注').setIcon('message-square-text').onClick(() => this.open(Buffer.from(file.path).toString('base64url')))); if(file instanceof TFile && file.extension==='md')menu.addItem(item=>item.setTitle('用页间修改 / 提问').setIcon('notebook-pen').onClick(()=>this.openNote(file).catch(e=>new Notice(e.message)))); }));
    this.addSettingTab(new FolioSettings(this.app, this));
  }
  async open(id) {
    let leaf;
    try { leaf = this.app.workspace.getLeaf('tab'); }
    catch { leaf = this.app.workspace.getLeaf(false); }
    await leaf.setViewState({ type: VIEW, active: true, state: { file: id || null } });
    this.app.workspace.revealLeaf(leaf);
  }
  openUnified(){
    if(this.openingEntry)return this.openingEntry;
    const task=this.openForCurrentDocument();this.openingEntry=task;
    task.finally(()=>{if(this.openingEntry===task)this.openingEntry=null;}).catch(()=>{});return task;
  }
  async openForCurrentDocument(){
    const leaf=this.currentNoteLeaf(),view=leaf?.view;
    if(view instanceof FolioView){await this.app.workspace.revealLeaf(leaf);return;}
    const file=view?.file;
    if(file && /^(html|htm)$/i.test(file.extension)){
      const id=Buffer.from(file.path).toString('base64url');
      const existing=this.app.workspace.getLeavesOfType(VIEW).find(l=>(l.view.initialId||l.getViewState().state?.file)===id);
      if(existing)await this.app.workspace.revealLeaf(existing);else await this.open(id);
      return;
    }
    if(file)return this.openCurrentNote();
    const landing=this.app.workspace.getLeavesOfType(VIEW).find(l=>!l.view.initialId&&!l.getViewState().state?.file);
    if(landing)await this.app.workspace.revealLeaf(landing);else await this.open();
  }
  async notePanel(file,{reveal=true}={}){
    await this.ready;if(file)this.noteStore.file(file.path);
    const leaf=this.app.workspace.getLeavesOfType(NOTE_VIEW)[0]||this.app.workspace.getRightLeaf(false);
    if(!leaf)throw new UserError('无法打开右侧面板。');
    if(leaf.view instanceof NoteView && leaf.view.controller && leaf.view.path!==file?.path){leaf.view.stop();await leaf.view.task;}
    await leaf.setViewState({type:NOTE_VIEW,active:reveal,state:{file:file?.path||null}});
    await leaf.loadIfDeferred?.();
    if(reveal)await this.app.workspace.revealLeaf(leaf);return leaf.view;
  }
  isNoteFile(file){return file?.extension==='md' && !file.path.endsWith('.excalidraw.md') && !this.app.metadataCache.getFileCache(file)?.frontmatter?.['excalidraw-plugin'];}
  currentNoteLeaf(){return this.app.workspace.getMostRecentLeaf();}
  async openCurrentNote(){
    const leaf=this.currentNoteLeaf(),file=leaf?.view?.file;
    if(this.isNoteFile(file) && leaf.view instanceof MarkdownView){const panel=await this.notePanel(file,{reveal:false});await this.pointSelect.enable(panel,file.path,{leaf});return panel;}
    const panel=await this.notePanel(null);panel.render();return panel;
  }
  scheduleNoteFollow(){
    ++this.followRequest;clearTimeout(this.followTimer);
    this.followTimer=setTimeout(()=>{this.followQueue=(this.followQueue||Promise.resolve()).catch(()=>{}).then(()=>this.followCurrentNote());this.followQueue.catch(e=>new Notice(e.message));},50);
  }
  async followCurrentNote(){
    await this.renameQueue;
    const request=this.followRequest,leaf=this.currentNoteLeaf(),view=leaf?.view;
    const panel=this.app.workspace.getLeavesOfType(NOTE_VIEW).map(l=>l.view).find(v=>v instanceof NoteView && !v.closed);if(!panel || this.unloading)return;
    const file=view instanceof MarkdownView && this.isNoteFile(view.file)?view.file:null,path=file?.path||null;
    const changed=(panel.path||null)!==path;
    const moved=this.followLeaf!==leaf;
    if(!changed){this.followLeaf=leaf;if(moved && this.pointSelect.session?.leaf!==leaf){await this.pointSelect.stop(false);if(file && view.getMode()==='preview')await this.pointSelect.enable(panel,path,{leaf,passive:true});}return;}
    if(panel.controller){panel.stop();await panel.task;}
    if(request!==this.followRequest || panel.closed || panel.leaf.view!==panel || this.unloading)return;
    await this.pointSelect.stop(false);
    await panel.setState({file:path},{});
    if(request!==this.followRequest || panel.closed || panel.leaf.view!==panel || this.unloading)return;
    if(file && view.getMode()==='preview')await this.pointSelect.enable(panel,path,{leaf,passive:true});
    this.followLeaf=leaf;
  }
  async renameNotes(file,oldPath){
    await this.ready;
    const paths=Object.keys(this.state.data.notes||{}).filter(p=>p===oldPath||p.startsWith(oldPath+'/'));
    for(const old of paths){
      const next=file.path+old.slice(oldPath.length);
      const panels=[...this.noteViews].filter(p=>p.path===old);
      for(const p of panels){p.stop();await p.task?.catch(()=>{});}
      await this.pointSelect.stop(false);
      await this.noteStore.rename(old,next);
      for(const p of panels){p.path=next;if(p.capture)p.capture.path=next;await p.reloadRecords();await p.persist();}
    }
    this.scheduleNoteFollow();
  }
  async openNote(file){
    if(!this.isNoteFile(file))throw new UserError('当前类型暂不支持正文批注，请打开 Markdown 笔记。');
    const existing=this.app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path===file.path);
    const leaf=existing||this.app.workspace.getLeaf('tab');await leaf.openFile(file);await this.app.workspace.revealLeaf(leaf);
    const panel=await this.notePanel(file,{reveal:false});await this.pointSelect.enable(panel,file.path);return panel;
  }
  async openNoteSelection(editor,ctx,mode){
    if(!this.isNoteFile(ctx.file))throw new UserError('请先打开 Markdown 笔记。');
    const capture=captureNote(ctx.file.path,editor.getValue(),editor.posToOffset(editor.getCursor('from')),editor.posToOffset(editor.getCursor('to')));
    const view=await this.notePanel(ctx.file);await view.useCapture(capture,mode);
  }
  onunload() { this.unloading=true;clearTimeout(this.followTimer);this.pointSelect?.stop(false);for (const view of this.views || []) view.dispose(); for(const view of this.noteViews||[])view.dispose(); }
}
