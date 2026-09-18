import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { largePNG } from './image-fixtures.js';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const pluginId=JSON.parse(await readFile(root+'/manifest.json','utf8')).id;
const browser = await chromium.connectOverCDP('http://127.0.0.1:9236');
const page = browser.contexts()[0].pages().find(p => p.url().startsWith('app://obsidian.md/'));
const mode = process.argv[2] || 'test';
async function nested(name, expression) {
  const workbench = await (await page.locator('.folio-workbench').elementHandle()).contentFrame();
  const session = await page.context().newCDPSession(workbench);
  const contexts = new Map();
  session.on('Runtime.executionContextCreated', ({context}) => { if (context.auxData?.isDefault) contexts.set(context.auxData.frameId, context.id); });
  try {
    await session.send('Runtime.enable'); await session.send('Page.enable');
    const { frameTree } = await session.send('Page.getFrameTree');
    const frame = frameTree.childFrames?.find(f => f.frame.name === name)?.frame;
    assert.ok(frame, `Missing native frame ${name}`);
    const result = await session.send('Runtime.evaluate', { expression, contextId: contexts.get(frame.id), returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ' ' + result.exceptionDetails.exception?.description);
    return result.result.value;
  } finally { await session.detach(); }
}
async function until(fn) { for(let i=0;i<60;i++){ if(await fn()) return; await new Promise(r=>setTimeout(r,100)); } throw new Error('Native frame assertion timeout'); }
page.on('pageerror', error => console.log('PAGE ERROR:', error.message));
page.on('console', message => { if (message.type() === 'error') console.log('CONSOLE:', message.text()); });
try {
  assert.equal(await page.evaluate(()=>app.vault.adapter.getBasePath()),root+'/.test-vault');
  await page.evaluate(id=>{window.folioTestPluginId=id;},pluginId);
  if (mode === 'reload' || mode === 'images' || mode === 'notes' || mode === 'point' || mode === 'inline' || mode === 'follow' || mode === 'entry') {
    await page.evaluate(async () => { await app.plugins.unloadPlugin(window.folioTestPluginId); await app.plugins.loadPlugin(window.folioTestPluginId); });
  }
  const status = await page.evaluate(async () => {
    const plugin = app.plugins.plugins[window.folioTestPluginId]; await plugin?.ready;
    return { vault: app.vault.adapter.getBasePath(), loaded: !!plugin, commands: Object.keys(app.commands.commands).filter(k => k.startsWith(window.folioTestPluginId+':')), leaves: app.workspace.getLeavesOfType('folio-workbench').length };
  });
  console.log(JSON.stringify(status));
  assert.equal(status.vault, root + '/.test-vault'); assert.equal(status.loaded, true);
  if (mode === 'shutdown') {
    await page.evaluate(() => app.plugins.unloadPlugin(window.folioTestPluginId));
    assert.equal(await page.locator('.folio-workbench').count(), 0);
    console.log('插件停用后工作台已清理；关闭独立测试实例。');
    const session = await browser.newBrowserCDPSession();
    await Promise.race([session.send('Browser.close').catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]);
  } else if (mode === 'entry') {
    const notePath='统一入口测试.md',htmlPath='统一入口测试.html';
    await page.evaluate(async({notePath,htmlPath})=>{
      const p=app.plugins.plugins[window.folioTestPluginId];await p.pointSelect.stop(false);
      for(const leaf of app.workspace.getLeavesOfType('folio-note-comments'))leaf.detach();
      for(const leaf of app.workspace.getLeavesOfType('folio-workbench'))leaf.detach();
      for(const [name,source]of [[notePath,'# 当前文档\n\n直接在这里提问。\n'],[htmlPath,'<html><body><h1>统一 HTML 入口</h1></body></html>']]){const f=app.vault.getAbstractFileByPath(name);if(f)await app.vault.modify(f,source);else await app.vault.create(name,source);}
      const leaf=app.workspace.getLeaf('tab');await leaf.setViewState({type:'markdown',active:true,state:{file:notePath,mode:'preview'}});await app.workspace.revealLeaf(leaf);
    },{notePath,htmlPath});
    const entry=page.locator('[data-folio-entry]');assert.equal(await entry.count(),1);
    assert.equal(await page.locator('.side-dock-ribbon-action[aria-label="页间：对当前笔记修改 / 提问"],.side-dock-ribbon-action[aria-label="页间：HTML 点选留言"]').count(),0);
    await entry.click();await page.locator('.folio-note-point-mode p').filter({hasText:'直接在这里'}).click();
    await page.locator('.folio-note-panel textarea').fill('统一入口草稿');await entry.click();
    assert.equal(await page.locator('.folio-note-panel textarea').inputValue(),'统一入口草稿');
    assert.equal(await page.locator('.prompt-input').count(),0);assert.equal(await page.locator('.folio-workbench').count(),0);
    await page.evaluate(async()=>{const leaf=app.workspace.getLeaf('tab');await leaf.setViewState({type:'empty',active:true});await app.workspace.revealLeaf(leaf);});
    await entry.click();const outer=page.frameLocator('.folio-workbench');await outer.locator('#document-welcome').waitFor();
    await outer.locator('#choose-note-document').click();await page.locator('.prompt-input').fill(notePath);
    await page.locator('.suggestion-item').filter({hasText:notePath}).first().click();await page.locator('.folio-note-point-mode p').filter({hasText:'直接在这里'}).waitFor();
    // A generic HTML file view exercises routing from outside Folio.
    await page.evaluate(async htmlPath=>{
      const p=app.plugins.plugins[window.folioTestPluginId],ItemView=Object.getPrototypeOf(app.workspace.getLeavesOfType('folio-note-comments')[0].view.constructor.prototype).constructor;
      for(const leaf of app.workspace.getLeavesOfType('folio-workbench'))leaf.detach();
      p.registerView('folio-entry-html-test',leaf=>new class extends ItemView{getViewType(){return 'folio-entry-html-test';}getDisplayText(){return 'HTML 入口测试';}async onOpen(){this.file=app.vault.getAbstractFileByPath(htmlPath);}}(leaf));
      const leaf=app.workspace.getLeaf('tab');await leaf.setViewState({type:'folio-entry-html-test',active:true});await app.workspace.revealLeaf(leaf);
    },htmlPath);
    await entry.click();await until(()=>nested('document-frame','document.querySelector("h1")?.textContent==="统一 HTML 入口"').catch(()=>false));
    const state=await page.evaluate(()=>{const p=app.plugins.plugins[window.folioTestPluginId],leaf=p.currentNoteLeaf();window.entryFrame=leaf.view.frame;return {id:leaf.view.initialId,count:app.workspace.getLeavesOfType('folio-workbench').length};});
    assert.equal(state.id,Buffer.from(htmlPath).toString('base64url'));
    await entry.click();await page.evaluate(()=>app.commands.executeCommandById(window.folioTestPluginId+':open'));await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>app.plugins.plugins[window.folioTestPluginId].currentNoteLeaf().view.frame===window.entryFrame),true);
    assert.equal(await page.evaluate(()=>app.workspace.getLeavesOfType('folio-workbench').length),state.count);
    await page.evaluate(async()=>{const leaf=app.workspace.getLeavesOfType('folio-entry-html-test')[0];await app.workspace.revealLeaf(leaf);});await entry.click();
    assert.equal(await page.evaluate(()=>app.workspace.getLeavesOfType('folio-workbench').length),state.count);
    await page.screenshot({path:root+'/test-results/obsidian-unified-entry.png'});
    await page.evaluate(()=>{for(const leaf of app.workspace.getLeavesOfType('folio-entry-html-test'))leaf.detach();});
    console.log('统一入口通过：唯一图标、当前笔记直接批注、重复点击保留草稿、空白页选择首页、首页打开笔记、HTML 文件路由、已有工作台和通用命令复用。');
  } else if (mode === 'picker') {
    const landing = async () => {
      await page.evaluate(() => { for (const leaf of app.workspace.getLeavesOfType('folio-workbench')) leaf.detach(); });
      await page.locator('.folio-workbench').waitFor({state:'detached'}); await page.waitForTimeout(100);
      await page.evaluate(() => app.plugins.plugins[window.folioTestPluginId].open());
    };
    await landing();
    const outer = page.frameLocator('.folio-workbench');
    await outer.locator('#document-welcome').waitFor();
    assert.equal(await outer.locator('#document-frame').isVisible(),false);
    await page.screenshot({path:root+'/test-results/obsidian-picker.png'});
    await outer.locator('#choose-vault-document').click();
    await outer.locator('#document-search').fill('试用页面.html');
    await outer.locator('#documents button[title="试用页面.html"]').click();
    await until(()=>nested('document-frame','!!document.querySelector("h1")'));
    assert.equal(await outer.locator('#document-welcome').isVisible(),false);
    await landing(); await outer.locator('#document-welcome').waitFor();
    await outer.locator('#file').setInputFiles({name:'首页导入测试.html',mimeType:'text/html',buffer:Buffer.from('<!doctype html><html><head><title>首页导入</title></head><body><h1>来自选择首页的文件</h1><a href="../本地说明.html">相对链接</a><a href="file:///tmp/example.html">本地文件</a></body></html>')});
    await until(()=>nested('document-frame','document.querySelector("h1")?.textContent === "来自选择首页的文件"'));
    assert.equal(await outer.locator('#document-welcome').isVisible(),false);
    assert.ok(await page.evaluate(()=>app.vault.getFiles().some(f=>f.path.startsWith('Folio/首页导入测试'))));
    assert.equal(await nested('document-frame','document.querySelectorAll("a[href]").length'),0);
    assert.ok(await page.evaluate(async()=>{const p=app.plugins.plugins[window.folioTestPluginId];const id=app.workspace.getLeavesOfType('folio-workbench')[0].view.initialId;return (await p.store.get(id)).source.includes('file:///tmp/example.html')}));
    await landing(); await outer.locator('#document-welcome').waitFor();
    await outer.locator('#file').setInputFiles({name:'导入脚本页.html',mimeType:'text/html',buffer:Buffer.from('<html><body><h1>导入转换成功</h1><script>window.pwned=true</script></body></html>')});
    await outer.locator('#incompatible-dialog').waitFor();
    await outer.locator('#static-copy').click();
    await outer.locator('#notice-text').filter({hasText:'已创建静态副本'}).waitFor();
    await until(()=>nested('document-frame','document.querySelector("h1")?.textContent === "导入转换成功"'));
    assert.equal(await nested('document-frame','window.pwned === true'),false);
    console.log('本地链接保留、预览不跳转、脚本页导入转换通过。');
    console.log('选择首页实测通过：新开不自动选文档、库内搜索选择、已有记录不跳过首页、导入按钮连接文件选择、文件导入并保存副本。');
  } else if(mode==='follow-debug') {
    console.log(await page.evaluate(()=>{const p=app.plugins.plugins[window.folioTestPluginId];return {status:document.querySelector('.folio-note-status')?.textContent,request:p.followRequest,unloading:p.unloading,recent:p.currentNoteLeaf()?.view?.file?.path,active:app.workspace.activeLeaf?.view?.file?.path,panel:[...p.noteViews].map(v=>({path:v.path,closed:v.closed,connected:v.containerEl.isConnected,current:v.leaf.view===v,busy:!!v.controller})),session:p.pointSelect.session?.path,leaves:app.workspace.getLeavesOfType('markdown').map(l=>({path:l.view.file?.path,mode:l.view.getMode?.()}))};}));
  } else if(mode==='point-debug') {
    console.log(await page.evaluate(()=>{const p=app.plugins.plugins[window.folioTestPluginId].pointSelect;return {session:!!p.session,mode:p.session?.view.getMode(),root:p.session?.root.outerHTML.slice(0,600),previewRoot:p.session?.view.previewMode.containerEl?.outerHTML.slice(0,400),previewKeys:p.session?Object.keys(p.session.view.previewMode):[],text:document.body.innerText.slice(-2500),sections:p.session?[...p.session.root.querySelectorAll('*')].filter(e=>p.sections.has(e)).map(e=>{const c=p.sections.get(e),i=c.getSectionInfo(e);return {tag:e.tagName,cls:e.className,path:c.sourcePath,start:i?.lineStart,end:i?.lineEnd,length:i?.text?.length,text:e.textContent.slice(0,60),documentText:i?.text};}):[]};}));
    await page.screenshot({path:root+'/test-results/point-debug.png'});
  } else if (mode === 'point') {
    const notePath='正文点选测试.md';
    const source='---\ntags: [folio-test]\n---\n\n# 点中内容，就能留言\n\n重复的句子。\n\n第二段，说明当前进度。\n\n重复的句子。\n\n- 列表第一项\n- 列表第二项\n\n| 项目 | 状态 |\n| --- | --- |\n| A | 已完成 |\n\n> [!note] 提示\n> 这是一条说明。\n\n![[嵌入测试]]\n';
    await page.evaluate(async({notePath,source})=>{
      const plugin=app.plugins.plugins[window.folioTestPluginId];await plugin.pointSelect.stop(false);
      for(const leaf of app.workspace.getLeavesOfType('folio-note-comments'))leaf.detach();
      for(const [name,text]of [[notePath,source],['嵌入测试.md','不应选中的嵌入内容。']]){const file=app.vault.getAbstractFileByPath(name);if(file)await app.vault.modify(file,text);else await app.vault.create(name,text);}
      await plugin.state.mutate(data=>{data.notes||={};delete data.notes[notePath];});
      await plugin.openNote(app.vault.getAbstractFileByPath(notePath));
    },{notePath,source});
    const rootEl=page.locator('.folio-note-point-mode'),panel=page.locator('.folio-note-panel');
    const repeat=rootEl.locator('p').filter({hasText:/^重复的句子。$/});await repeat.nth(1).waitFor();
    await repeat.nth(1).hover();await page.locator('.folio-note-point-hover').waitFor();
    await repeat.nth(1).click();await page.locator('.folio-note-point-tools').waitFor();
    assert.match(await page.locator('.folio-note-point-label').textContent(),/第 11 行/);
    assert.equal(await page.evaluate(()=>app.plugins.plugins[window.folioTestPluginId].pointSelect.capture.start),source.lastIndexOf('重复的句子。'));
    await page.locator('[data-note-action="ask"]').click();
    assert.equal(await panel.locator('[data-mode="ask"]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('.folio-inline-composer textarea').evaluate(e=>e===e.ownerDocument.activeElement),true);
    await page.locator('.folio-inline-composer textarea').fill('这段是什么意思？');
    await page.keyboard.press('Escape');assert.equal(await rootEl.count(),1);
    assert.equal(await readFile(root+'/.test-vault/'+notePath,'utf8'),source);
    await rootEl.locator('li').filter({hasText:'列表第一项'}).click();await until(async()=>await panel.locator('.folio-note-selection-summary').textContent()==='- 列表第一项\n- 列表第二项');
    await rootEl.locator('td').filter({hasText:'已完成'}).click();await until(async()=> (await panel.locator('.folio-note-selection-summary').textContent()).startsWith('| 项目 |'));
    await rootEl.locator('.callout').click();await until(async()=> (await panel.locator('.folio-note-selection-summary').textContent()).startsWith('> [!note]'));
    await rootEl.locator('.markdown-embed').scrollIntoViewIfNeeded();await rootEl.locator('.markdown-embed').hover();assert.equal(await page.locator('.folio-note-point-hover').count(),0);
    await rootEl.locator('h1').click();await page.locator('.folio-note-point-tools').waitFor();
    await page.screenshot({path:root+'/test-results/obsidian-point-select.png'});
    await page.keyboard.press('Escape');await page.locator('.folio-note-point-tools').waitFor({state:'detached'});assert.equal(await page.locator('.folio-note-point-mode').count(),0);
    assert.equal(await readFile(root+'/.test-vault/'+notePath,'utf8'),source);
    await panel.locator('.folio-note-point-toggle').click();await rootEl.locator('h1').click();
    await page.evaluate(async notePath=>{const file=app.vault.getAbstractFileByPath(notePath);await app.vault.modify(file,(await app.vault.read(file))+'\n新的段落。\n');},notePath);
    await page.locator('.folio-note-point-tools').waitFor({state:'detached'});
    await rootEl.locator('p').filter({hasText:/^新的段落。$/}).click();await page.locator('.folio-note-point-tools').waitFor();
    assert.equal(await page.evaluate(()=>app.plugins.plugins[window.folioTestPluginId].pointSelect.capture.expected),'新的段落。');
    await page.evaluate(()=>app.workspace.getLeavesOfType('folio-note-comments')[0].detach());
    await page.locator('.folio-note-point-tools').waitFor({state:'detached'});assert.equal(await page.locator('.folio-note-point-mode').count(),0);
    console.log('正文点选通过：悬停描边、重复文字准确定位、浮动修改/提问、列表/表格/callout、嵌入隔离、Esc/关闭清理、文件更新后重新定位、源码无标记。');
  } else if (mode === 'inline') {
    const notePath='原地批注测试.md',source='# 在正文旁，问清楚\n\n同一句话。\n\n本周完成了 12 项改进，接下来继续验证。\n\n同一句话。\n';
    await page.evaluate(async({notePath,source})=>{
      const p=app.plugins.plugins[window.folioTestPluginId];await p.pointSelect.stop(false);
      for(const leaf of app.workspace.getLeavesOfType('folio-note-comments'))leaf.detach();
      const file=app.vault.getAbstractFileByPath(notePath);if(file)await app.vault.modify(file,source);else await app.vault.create(notePath,source);
      await p.state.mutate(data=>{data.notes||={};delete data.notes[notePath];});
      p.noteGenerate=()=>new Promise(resolve=>{window.finishInline=resolve;});
      await p.openNote(app.vault.getAbstractFileByPath(notePath));
    },{notePath,source});
    const rootEl=page.locator('.folio-note-point-mode'),popup=page.locator('.folio-inline-composer'),cards=page.locator('.markdown-reading-view .folio-inline-card');
    const repeat=rootEl.locator('p').filter({hasText:/^同一句话。$/});
    await repeat.nth(1).click();await page.locator('[data-note-action="ask"]').click();
    await popup.locator('.folio-inline-send').click();await popup.getByRole('status').filter({hasText:'请输入'}).waitFor();
    await popup.locator('textarea').fill('这个说法的依据是什么？');
    await page.keyboard.press('Escape');await popup.waitFor({state:'detached'});
    await page.locator('[data-note-action="ask"]').click();assert.equal(await popup.locator('textarea').inputValue(),'这个说法的依据是什么？');
    await page.screenshot({path:root+'/test-results/obsidian-inline-input.png'});
    await popup.locator('.folio-inline-send').click();await popup.waitFor({state:'detached'});
    await cards.filter({hasText:'正在回答'}).waitFor();
    assert.equal(await cards.count(),1);
    const anchor=await cards.evaluateAll(elements=>elements.map(el=>{let block=el.parentElement.parentElement;const p=app.plugins.plugins[window.folioTestPluginId].pointSelect;return p.sections.get(block)?.getSectionInfo(block)?.lineStart;}));
    assert.deepEqual(anchor,[6]);
    await cards.locator('summary').click();
    await page.evaluate(()=>window.finishInline({answer:'这是 **两项技能** 的说明。\n\n1. **搜索**：查资料。\n2. **管理**：使用 `notion` 管理文档。\n\n| 技能 | 用途 |\n| --- | --- |\n| search | 检索 |\n\n```js\nconst count = 12;\n```\n\n<img src=x onerror="window.folioInjected=true">',citations:[]}));
    await cards.locator('.folio-inline-answer').waitFor();assert.equal(await cards.locator('img').count(),0);
    for(const selector of ['strong','ol li','table','pre code'])assert.ok(await cards.locator('.folio-inline-answer '+selector).count());
    for(const selector of ['strong','ol li','table','pre code'])await page.locator('.folio-note-answer '+selector).first().waitFor({state:'attached'});
    assert.equal(await page.evaluate(()=>!!window.folioInjected),false);
    assert.equal(await readFile(root+'/.test-vault/'+notePath,'utf8'),source);
    await page.screenshot({path:root+'/test-results/obsidian-inline-answer.png'});
    // Panel closure and a full renderer rebuild retain cards without point mode.
    await page.evaluate(()=>app.workspace.getLeavesOfType('folio-note-comments')[0].detach());
    await page.locator('.folio-note-panel').waitFor({state:'detached'});
    await page.evaluate(notePath=>app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path===notePath).view.previewMode.rerender(true),notePath);
    await cards.waitFor();assert.equal(await page.locator('.folio-note-point-mode').count(),0);
    await cards.locator('summary').click();await cards.locator('button').click();await page.locator('.folio-note-answer').waitFor();
    // Reload tests persisted state and postprocessor startup, not merely in-memory UI.
    await page.evaluate(async()=>{await app.plugins.unloadPlugin(window.folioTestPluginId);await app.plugins.loadPlugin(window.folioTestPluginId);await app.plugins.plugins[window.folioTestPluginId].ready;});
    await page.evaluate(notePath=>app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path===notePath).view.previewMode.rerender(true),notePath);
    await cards.waitFor();assert.equal(await cards.count(),1);
    await page.evaluate(async notePath=>{const p=app.plugins.plugins[window.folioTestPluginId];await p.openNote(app.vault.getAbstractFileByPath(notePath));p.noteGenerate=async()=>{throw Error('fixture failure');};},notePath);
    await rootEl.locator('p').filter({hasText:/^本周完成了/}).click();await page.locator('[data-note-action="ask"]').click();
    await popup.locator('textarea').fill('失败时也保留这个问题');await popup.locator('.folio-inline-send').click();
    await cards.filter({hasText:'生成失败'}).waitFor();assert.equal(await cards.count(),2);
    assert.equal(await readFile(root+'/.test-vault/'+notePath,'utf8'),source);
    await page.evaluate(()=>{app.plugins.plugins[window.folioTestPluginId].noteGenerate=async()=>({replacement:'同一句说明。',summary:'将话改为说明。'});});
    await repeat.first().click();await page.locator('[data-note-action="edit"]').click();
    await popup.locator('textarea').fill('把话改为说明');await popup.locator('.folio-inline-send').click();
    const editCard=cards.filter({hasText:'待审阅'});await editCard.waitFor();await editCard.locator('summary').click();await editCard.getByRole('button',{name:'审阅修改'}).click();
    await page.locator('.folio-note-apply').waitFor();assert.equal(await readFile(root+'/.test-vault/'+notePath,'utf8'),source);
    await page.evaluate(async({notePath,source})=>app.vault.modify(app.vault.getAbstractFileByPath(notePath),'新增内容。\n\n'+source),{notePath,source});
    await until(async()=>await cards.count()===0);
    assert.equal(await page.locator('.folio-note-history-item').count(),3);
    await page.evaluate(()=>app.plugins.unloadPlugin(window.folioTestPluginId));
    assert.equal(await page.locator('.folio-inline-thread,.folio-inline-composer').count(),0);
    await page.evaluate(async()=>{await app.plugins.loadPlugin(window.folioTestPluginId);});
    console.log('原地批注通过：输入/草稿、即时问题卡片、重复段落精确挂靠、答案展开、文本安全、关闭与重载恢复、失败保留、版本变化取消挂靠、卸载清理、源码无标记。');
  } else if (mode === 'follow') {
    const names=['跟随甲.md','跟随乙.md','画布测试.excalidraw.md'];
    await page.evaluate(async names=>{
      const p=app.plugins.plugins[window.folioTestPluginId];await p.pointSelect.stop(false);
      for(const leaf of app.workspace.getLeavesOfType('folio-note-comments'))leaf.detach();
      for(const [i,name]of names.entries()){const source=i===2?'---\nexcalidraw-plugin: parsed\n---\n画布数据。':'# '+name+'\n\n这是'+(i===0?'甲':'乙')+'的正文。\n';const file=app.vault.getAbstractFileByPath(name);if(file)await app.vault.modify(file,source);else await app.vault.create(name,source);}
      await p.state.mutate(data=>{data.notes||={};for(const name of names)delete data.notes[name];});
      const leaf=app.workspace.getLeaf('tab');await leaf.setViewState({type:'markdown',active:true,state:{file:names[0],mode:'preview'}});await app.workspace.revealLeaf(leaf);
      app.commands.executeCommandById(window.folioTestPluginId+':note-open');
    },names);
    const panel=page.locator('.folio-note-panel');
    const target=async name=>until(async()=>await page.evaluate(name=>app.workspace.getLeavesOfType('folio-note-comments')[0]?.view.path===name,name));
    await target(names[0]);assert.equal(await page.locator('.prompt-input').count(),0);
    await page.locator('.folio-note-point-mode p').filter({hasText:'这是甲'}).click();
    await page.locator('[data-note-action="ask"]').click();await page.locator('.folio-inline-composer textarea').fill('甲的草稿');await page.keyboard.press('Escape');
    const switchTo=async(name,mode='preview',newTab=false)=>page.evaluate(async({name,mode,newTab})=>{
      const leaf=newTab?app.workspace.getLeaf('tab'):app.workspace.getMostRecentLeaf();
      await leaf.setViewState({type:'markdown',active:true,state:{file:name,mode}});await app.workspace.revealLeaf(leaf);
    },{name,mode,newTab});
    await switchTo(names[1],'preview',true);await target(names[1]);
    await page.locator('.folio-note-point-mode p').filter({hasText:'这是乙'}).waitFor();
    assert.equal(await panel.locator('textarea').inputValue(),'');
    await page.locator('.folio-note-point-mode p').filter({hasText:'这是乙'}).click();await panel.locator('textarea').fill('乙的草稿');
    await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>app.plugins.plugins[window.folioTestPluginId].currentNoteLeaf().view.file.path),names[1]);
    await switchTo(names[0]);await target(names[0]);assert.equal(await panel.locator('textarea').inputValue(),'甲的草稿');
    await switchTo(names[1],'source');await target(names[1]);assert.equal(await panel.locator('textarea').inputValue(),'乙的草稿');
    assert.equal(await page.evaluate(()=>app.plugins.plugins[window.folioTestPluginId].currentNoteLeaf().view.getMode()),'source');
    // Rapid same-tab navigation keeps the final target and doesn't reopen old files.
    await switchTo(names[0]);await switchTo(names[1]);await switchTo(names[0]);await target(names[0]);await page.waitForTimeout(150);
    assert.equal(await page.evaluate(()=>app.plugins.plugins[window.folioTestPluginId].currentNoteLeaf().view.file.path),names[0]);
    await page.evaluate(()=>{app.plugins.plugins[window.folioTestPluginId].noteGenerate=({signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));});
    await panel.locator('.folio-note-send').click();await panel.locator('.folio-note-stop').waitFor();
    await switchTo(names[1]);await target(names[1]);
    const cancelled=await page.evaluate(async name=>(await app.plugins.plugins[window.folioTestPluginId].noteStore.thread(name)).records[0].state,names[0]);assert.equal(cancelled,'cancelled');
    await page.screenshot({path:root+'/test-results/obsidian-follow-current.png'});
    await switchTo(names[2]);await target(null);await panel.getByText('当前文档暂不支持正文批注。',{exact:false}).waitFor();assert.equal(await panel.locator('textarea').count(),0);
    assert.equal(await page.evaluate(()=>app.plugins.plugins[window.folioTestPluginId].currentNoteLeaf().view.file.path),names[2]);
    await page.evaluate(()=>app.commands.executeCommandById(window.folioTestPluginId+':note-open'));await page.waitForTimeout(100);assert.equal(await page.locator('.prompt-input').count(),0);
    await switchTo(names[1]);await target(names[1]);
    await page.evaluate(()=>app.workspace.getLeavesOfType('folio-note-comments')[0].detach());await switchTo(names[0]);await page.waitForTimeout(100);assert.equal(await panel.count(),0);
    console.log('当前笔记跟随通过：直接入口无选择器、标签/同标签/快速切换、独立草稿、侧栏焦点稳定、编辑模式保留、生成取消后跟随、画布不误用旧笔记、关闭不重开。');
  } else if (mode === 'notes') {
    const notePath='Markdown 留言测试.md';
    const source='---\ntags: [folio-test]\n---\n\n# 计划\n\n本周完成了 12 项改进。\n\n> [!note] 说明\n> 关联 [[另一篇笔记]]，原文保留。\n';
    await page.evaluate(async({notePath,source})=>{
      const plugin=app.plugins.plugins[window.folioTestPluginId];
      for(const leaf of app.workspace.getLeavesOfType('folio-note-comments'))leaf.detach();
      for(const leaf of app.workspace.getLeavesOfType('markdown'))if(leaf.getViewState().state?.file===notePath)leaf.detach();
      const file=app.vault.getAbstractFileByPath(notePath);if(file)await app.vault.modify(file,source);else await app.vault.create(notePath,source);
      await plugin.state.mutate(data=>{data.notes||={};delete data.notes[notePath];});
      plugin.noteGenerate=async({capture,mode})=>mode==='ask'?{answer:'笔记写明本周完成了 12 项改进。',citations:[{startLine:7,endLine:7}]}:{replacement:'本周已完成 12 项改进。',summary:'精简表达，保留数字。'};
      const leaf=app.workspace.getLeaf('tab');await leaf.setViewState({type:'markdown',active:true,state:{file:notePath,mode:'source'}});
      await app.workspace.revealLeaf(leaf);
    },{notePath,source});
    const select=async(mode='edit')=>{
      await page.evaluate(async({notePath,mode})=>{
        const leaf=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path===notePath);await leaf.setViewState({type:'markdown',state:{...leaf.view.getState(),mode:'source'}});app.workspace.setActiveLeaf(leaf,{focus:true});
        const editor=leaf.view.editor,s=editor.getValue(),start=s.indexOf('本周');editor.setSelection(editor.offsetToPos(start),editor.offsetToPos(s.indexOf('\n',start)));
        app.commands.executeCommandById(window.folioTestPluginId+':note-'+mode);
      },{notePath,mode});
      await page.locator('.folio-note-panel textarea').waitFor();
    };
    await page.evaluate(()=>app.commands.executeCommandById(window.folioTestPluginId+':note-open'));
    assert.equal(await page.locator('.prompt-input').count(),0);
    const panel=page.locator('.folio-note-panel');await panel.locator('.folio-note-point-toggle').waitFor();await select();
    await panel.locator('textarea').fill('把这句话写得更简洁。');await panel.locator('.folio-note-send').click();
    await panel.locator('.folio-note-apply').waitFor();
    assert.equal(await readFile(root+'/.test-vault/'+notePath,'utf8'),source);
    assert.ok((await panel.locator('.folio-note-diff').innerText()).includes('已完成'));
    await panel.locator('.folio-note-apply').click();await panel.locator('.folio-note-undo').waitFor();
    await until(async()=>await readFile(root+'/.test-vault/'+notePath,'utf8')===source.replace('本周完成了','本周已完成'));
    await page.waitForTimeout(300);await panel.locator('.folio-note-undo').click();
    await until(async()=>await readFile(root+'/.test-vault/'+notePath,'utf8')===source);
    await page.waitForTimeout(300);await select('ask');await panel.locator('textarea').fill('完成了多少项？');await panel.locator('.folio-note-send').click();
    await panel.locator('.folio-note-answer').filter({hasText:'12 项'}).waitFor();
    assert.equal(await readFile(root+'/.test-vault/'+notePath,'utf8'),source);assert.equal(await panel.locator('.folio-note-apply').count(),0);
    await panel.locator('.folio-note-citations button').click();
    await page.locator('.folio-note-point-selected').filter({hasText:'本周完成了 12 项改进。'}).waitFor();
    await panel.locator('textarea').fill('这个结论有哪些依据？');
    await page.evaluate(async()=>{const view=app.workspace.getLeavesOfType('folio-note-comments')[0].view;await view.persist();view.leaf.detach();});
    await page.locator('.folio-note-panel').waitFor({state:'detached'});
    await page.evaluate(async notePath=>{await app.plugins.plugins[window.folioTestPluginId].openNote(app.vault.getAbstractFileByPath(notePath));},notePath);
    await until(async()=>await panel.locator('textarea').inputValue()==='这个结论有哪些依据？');
    assert.ok(await panel.locator('.folio-note-answer').count());
    await page.screenshot({path:root+'/test-results/obsidian-markdown.png'});
    await select('edit');await panel.locator('textarea').fill('精简');await panel.locator('.folio-note-send').click();await panel.locator('.folio-note-apply').waitFor();
    await page.evaluate(async({notePath,source})=>app.vault.modify(app.vault.getAbstractFileByPath(notePath),source+'\n外部新增内容。\n'),{notePath,source});
    await panel.locator('.folio-note-apply').click();await panel.locator('.folio-note-status').filter({hasText:'笔记已改变'}).waitFor();
    assert.match(await readFile(root+'/.test-vault/'+notePath,'utf8'),/外部新增内容/);
    await select('ask');await page.evaluate(()=>{app.plugins.plugins[window.folioTestPluginId].noteGenerate=({signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));});
    await panel.locator('textarea').fill('取消测试');await panel.locator('.folio-note-send').click();await panel.locator('.folio-note-stop').click();
    await panel.locator('.folio-note-history-item').filter({hasText:'已停止'}).waitFor();
    console.log('Markdown 原生实测通过：编辑器选区命令、修改对比、采用保存/备份撤销、提问不写笔记、引用定位、输入和回答恢复、外部冲突拦截、取消。');
  } else if (mode === 'images') {
    const folder = root + '/test-results/image-fixture'; await mkdir(folder + '/assets', {recursive:true});
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
    const imagePath = folder + '/assets/中文 图片.png'; await writeFile(imagePath,png);
    const server = http.createServer((req,res)=>{res.setHeader('Content-Type','image/png');res.end(png);});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
      const source = '<html><head><title>图片导入实测</title><style>body{font-family:sans-serif;padding:40px}img{width:120px;height:100px;border:8px solid #6d9773;margin:12px}figure{display:inline-block;margin:0}h1{color:#315e46}</style></head><body><h1>本地和网络图片导入测试</h1><p>相对路径、绝对路径、file URL 和网络图片均复制到笔记库。</p>' +
        ['assets/中文%20图片.png',imagePath,pathToFileURL(imagePath).href,`http://127.0.0.1:${server.address().port}/image.png`].map((src,i)=>`<figure><img src="${src}" alt="图片 ${i+1}"><figcaption>图片 ${i+1}</figcaption></figure>`).join('') + '</body></html>';
      const file = folder + '/图片导入实测.html'; await writeFile(file,source);
      await page.evaluate(()=>{for(const leaf of app.workspace.getLeavesOfType('folio-workbench'))leaf.detach();});
      await page.locator('.folio-workbench').waitFor({state:'detached'});
      await page.evaluate(()=>app.plugins.plugins[window.folioTestPluginId].open());
      const outer=page.frameLocator('.folio-workbench'); await outer.locator('#import-welcome').waitFor();
      const choose = async (file, button) => {
        if (button==='#import' && !await outer.locator(button).isVisible()) await outer.getByRole('button',{name:'显示文档与保存历史'}).click();
        const chooser = page.waitForEvent('filechooser'); await outer.locator(button).click();
        await chooser;
        const session=await page.context().newCDPSession(page);
        try {
          const {root:dom}=await session.send('DOM.getDocument');
          const {nodeId}=await session.send('DOM.querySelector',{nodeId:dom.nodeId,selector:'[data-folio-import]'});
          await session.send('DOM.setFileInputFiles',{nodeId,files:[file]});
        } finally { await session.detach(); }
      };
      await choose(file,'#import-welcome');
      await until(()=>nested('document-frame','document.querySelectorAll("img").length===4 && [...document.images].every(i=>i.complete && i.naturalWidth===1)'));
      assert.equal(await page.locator('[data-folio-import]').count(),0);
      const result = await page.evaluate(async()=>{
        const view=app.workspace.getLeavesOfType('folio-workbench')[0].view;
        const doc=await app.plugins.plugins[window.folioTestPluginId].store.get(view.initialId);
        return {source:doc.source,id:doc.id,version:doc.version,webUtils:typeof require('electron').webUtils?.getPathForFile};
      });
      assert.equal(result.webUtils,'function'); assert.doesNotMatch(result.source,/data:image|file:\/\/|http:\/\//); assert.ok(result.source.length<2000);
      await page.screenshot({path:root+'/test-results/obsidian-images.png'});
      await outer.locator('#export').click(); await outer.locator('#notice-text').filter({hasText:'已另存到笔记库'}).waitFor();
      await page.evaluate(async({id,version,source})=>{ const plugin=app.plugins.plugins[window.folioTestPluginId]; await plugin.store.save(id,version,source.replace('本地和网络图片导入测试','图片保存后重开测试')); await app.workspace.getLeavesOfType('folio-workbench')[0].view.mount(); },result);
      await outer.locator('#connection-title').filter({hasText:/已发现|不可用/}).waitFor();
      await until(()=>nested('document-frame','document.querySelector("h1")?.textContent==="图片保存后重开测试" && [...document.images].every(i=>i.complete && i.naturalWidth===1)').catch(()=>false));
      const bad=folder+'/缺图.html'; await writeFile(bad,'<html><body><h1>缺图</h1><img src="assets/missing.png"></body></html>');
      await choose(bad,'#import'); await outer.locator('#notice-text').filter({hasText:'找不到或无法读取图片'}).waitFor();
      assert.equal(await page.evaluate(()=>app.vault.getFiles().some(f=>f.path==='Folio/缺图.html')),false);
      const scripted=folder+'/脚本含图.html'; await writeFile(scripted,source.replace('</body>','<script>window.pwned=true</script></body>'));
      await choose(scripted,'#import'); await outer.locator('#incompatible-dialog').waitFor(); await outer.locator('#static-copy').click();
      await until(()=>nested('document-frame','document.querySelector("h1")?.textContent==="本地和网络图片导入测试" && document.images.length===4 && [...document.images].every(i=>i.complete && i.naturalWidth===1)'));
      assert.equal(await nested('document-frame','window.pwned===true'),false);
      if (!await outer.locator('#import').isVisible()) await outer.getByRole('button',{name:'显示文档与保存历史'}).click();
      const bigData='data:image/png;base64,'+largePNG().toString('base64');
      const bigSource='<html><head><style>img{width:300px}</style></head><body><h1>大文件导入成功</h1><a href="'+bigData+'"><img src="'+bigData+'"></a></body></html>';
      const bigFile=folder+'/内嵌大图.html';await writeFile(bigFile,bigSource);
      assert.ok(Buffer.byteLength(bigSource)>600_000);
      await choose(bigFile,'#import');
      await until(()=>nested('document-frame','document.querySelector("h1")?.textContent==="大文件导入成功" && document.images[0]?.naturalWidth===600'));
      assert.equal(await outer.locator('#incompatible-dialog').isVisible(),false);
      const bigResult=await page.evaluate(async()=>{const view=app.workspace.getLeavesOfType('folio-workbench')[0].view;return app.plugins.plugins[window.folioTestPluginId].store.get(view.initialId);});
      assert.ok(bigResult.source.length<500);assert.doesNotMatch(bigResult.source,/data:image/);assert.match(bigResult.source,/<a href="attachments\//);
      assert.equal(await nested('document-frame','document.querySelectorAll("a[href]").length'),0);
      await page.evaluate(async doc=>{const plugin=app.plugins.plugins[window.folioTestPluginId];await plugin.store.save(doc.id,doc.version,doc.source.replace('大文件导入成功','大图保存重开成功'));await app.workspace.getLeavesOfType('folio-workbench')[0].view.mount();},bigResult);
      await outer.locator('#connection-title').filter({hasText:/已发现|不可用/}).waitFor();
      await until(()=>nested('document-frame','document.querySelector("h1")?.textContent==="大图保存重开成功" && document.images[0]?.naturalWidth===600').catch(()=>false));
      const oversized=folder+'/正文超限.html';await writeFile(oversized,'<html><body><p>'+'x'.repeat(5_000_001)+'</p></body></html>');
      await choose(oversized,'#import');await outer.locator('#notice-text').filter({hasText:'正文不能超过 5 MB'}).waitFor();assert.equal(await outer.locator('#incompatible-dialog').isVisible(),false);
      console.log('大文件实测通过：超过 600 KB 内嵌 PNG 与大图链接直接导入、附件去重、保存重开、超限不误导转换。');
      const chooser=page.waitForEvent('filechooser'); await outer.locator('#import').click(); await chooser;
      await page.locator('[data-folio-import]').dispatchEvent('cancel'); await until(async()=>await page.locator('[data-folio-import]').count()===0);
      console.log('图片原生实测通过：Electron 实际路径、相对/绝对/file/HTTP 图片解码、短源码、另存、保存重开、缺图无文档、静态转换保图、取消清理。');
    } finally { await new Promise(resolve=>server.close(resolve)); }
  } else if (mode === 'inspect') {
    console.log((await page.locator('body').innerText()).slice(-2000));
    for (const frame of page.frames()) console.log(JSON.stringify({url:frame.url(),text:(await frame.locator('body').innerText().catch(() => '')).slice(0,3000)}));
    await page.screenshot({path:root+'/test-results/obsidian-debug.png'});
    const session = await page.context().newCDPSession(page);
    console.log('TREE', JSON.stringify(await session.send('Page.getFrameTree')));
    console.log('TARGETS', JSON.stringify(await session.send('Target.getTargets')));
    console.log('WORKBENCH', await page.frameLocator('.folio-workbench').locator('#document-frame').evaluate(e => ({length:e.srcdoc.length,nonce:e.srcdoc.match(/nonce="([^"]+)/)?.[1],rect:e.getBoundingClientRect().toJSON()})));
    const childSession = await page.context().newCDPSession(await (await page.locator('.folio-workbench').elementHandle()).contentFrame());
    childSession.on('Runtime.executionContextCreated', e => console.log('CONTEXT', JSON.stringify(e.context)));
    await childSession.send('Runtime.enable'); await childSession.send('Page.enable');
    console.log('CHILD TREE', JSON.stringify(await childSession.send('Page.getFrameTree')));
  } else {
    const original = await readFile(root + '/examples/weekly-review.html', 'utf8');
    await page.evaluate(() => { for (const leaf of app.workspace.getLeavesOfType('folio-workbench')) leaf.detach(); });
    await page.locator('.folio-workbench').waitFor({state:'detached'});
    await page.waitForTimeout(100);
    await page.evaluate(async original => {
      const plugin = app.plugins.plugins[window.folioTestPluginId];
      await app.vault.modify(app.vault.getAbstractFileByPath('试用页面.html'), original);
      await plugin.state.mutate(data => { data.local = {}; data.drafts = {}; });
      await plugin.open(Buffer.from('试用页面.html').toString('base64url'));
    }, original);
    const outer = page.frameLocator('.folio-workbench');
    await outer.locator('#connection-title').filter({ hasText: /已发现|不可用/ }).waitFor({ timeout: 20000 });
    await until(() => nested('document-frame', '!!document.querySelector("[data-folio-ui]")'));
    console.log('插件工作台和隔离文档已加载');
    if (mode === 'compat') {
      const cache = '<!doctype html><html><head><title>缓存网页</title><script>window.pwned=true</script></head><body><h1>缓存标题</h1><p>保留的正文</p></body></html>';
      await page.evaluate(async cache => {
        const f = app.vault.getAbstractFileByPath('网页缓存.html');
        if (f) await app.vault.modify(f, cache); else await app.vault.create('网页缓存.html', cache);
        await app.workspace.getLeavesOfType('folio-workbench')[0].view.mount();
      }, cache);
      await outer.locator('#compatibility-count').filter({hasText:'（1）'}).waitFor({state:'attached'});
      if (!await outer.locator('#document-search').isVisible()) await outer.getByRole('button',{name:'显示文档与保存历史'}).click();
      assert.equal(await outer.locator('#documents button').filter({hasText:'网页缓存.html'}).count(),0);
      await outer.locator('#show-incompatible').check();
      await outer.locator('#document-search').fill('网页缓存');
      await outer.locator('#documents button').filter({hasText:'网页缓存.html'}).click();
      await outer.locator('#incompatible-dialog').waitFor();
      assert.match(await outer.locator('#incompatible-reason').textContent(),/script/);
      await outer.locator('#static-copy').click();
      await outer.locator('#notice-text').filter({hasText:'已创建静态副本'}).waitFor();
      await until(()=>nested('document-frame','document.querySelector("h1")?.textContent === "缓存标题"'));
      assert.equal(await readFile(root+'/.test-vault/网页缓存.html','utf8'),cache);
      assert.equal(await nested('document-frame','window.pwned === true'),false);
      assert.equal(await page.evaluate(()=>app.workspace.getLeavesOfType('folio-workbench')[0].view.initialId),Buffer.from('Folio/网页缓存-静态副本.html').toString('base64url'));
      await page.screenshot({path:root+'/test-results/obsidian-compatibility.png'});
      console.log('兼容性实测通过：默认过滤、搜索、转换提示、新建副本打开、原文不变、脚本不执行。');
    } else if (mode === 'smoke') {
      console.log('Codex 状态：' + await outer.locator('#connection-title').textContent());
    } else {
      if (mode !== 'real') await page.evaluate(() => {
        const service = app.workspace.getLeavesOfType('folio-workbench')[0].view.service;
        service.generate = async ({block}) => ({html:block.html.replace('<h1>', '<h1 style="font-size:30px;color:#286353">'), summary:'插件测试：标题改为 30px 深绿色'});
      });
      if (mode !== 'real') await outer.locator('#connection-title').evaluate(e => { e.textContent = '测试替身 · 非真实 AI'; });
      await nested('document-frame', 'document.querySelector("h1").click()');
      await nested('document-frame', `(() => { const root = document.querySelector('[data-folio-ui]').shadowRoot; const input = root.querySelector('textarea'); input.value='字号改为30px，改成深绿色，文字保留'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
      await mkdir(root + '/test-results', { recursive: true });
      await page.screenshot({ path: root + '/test-results/obsidian-annotation.png' });
      await nested('document-frame', `Array.from(document.querySelector('[data-folio-ui]').shadowRoot.querySelectorAll('button')).find(b=>b.textContent.includes('让 AI 改这里')).click()`);
      await outer.locator('#proposal').waitFor({ timeout: mode === 'real' ? 150000 : 15000 });
      await outer.locator('#preview-proposal').click();
      await until(() => nested('after-frame', '!!document.querySelector("h1[style]")'));
      await outer.locator('[data-close="preview-dialog"]').click();
      await outer.locator('#accept').click();
      await outer.locator('#save-state').filter({ hasText: '草稿已自动暂存' }).waitFor({state:'attached'});
      assert.equal(await readFile(root + '/.test-vault/试用页面.html', 'utf8'), original);
      await page.evaluate(() => app.workspace.getLeavesOfType('folio-workbench')[0].detach());
      await page.locator('.folio-workbench').waitFor({state:'detached'});
      await page.waitForTimeout(100);
      await page.evaluate(() => app.plugins.plugins[window.folioTestPluginId].open(Buffer.from('试用页面.html').toString('base64url')));
      await until(() => nested('document-frame', '!!document.querySelector("h1[style]")'));
      assert.match(await outer.locator('#recovery-message').textContent(), /已恢复上次/);
      await outer.locator('#save').click();
      await outer.locator('#save-state').filter({ hasText: '已保存到本机' }).waitFor({state:'attached'});
      assert.match(await readFile(root + '/.test-vault/试用页面.html', 'utf8'), /font-size:\s*30px/);
      if (!await outer.locator('#history').isVisible()) await outer.getByRole('button', {name:'显示文档与保存历史'}).click();
      await outer.locator('#history').click();
      assert.ok(await outer.locator('#versions button').count());
      await outer.locator('[data-close="history-dialog"]').click();
      if (await outer.getByRole('button', {name:'显示文档与保存历史'}).isVisible()) await outer.getByRole('button', {name:'显示文档与保存历史'}).click();
      await outer.locator('#export').click();
      await outer.locator('#notice-text').filter({ hasText: '已另存到笔记库' }).waitFor();
      const isolation = await page.evaluate(async () => {
        const view = app.workspace.getLeavesOfType('folio-workbench')[0].view;
        return { serviceClosed: view.service.closed, copies: app.vault.getFiles().filter(f => f.path.startsWith('Folio/')).length, local: await app.plugins.plugins[window.folioTestPluginId].state.request('storage/get') };
      });
      assert.equal(isolation.serviceClosed, false); assert.ok(isolation.copies > 0);
      const frameHandle = await page.locator('.folio-workbench').elementHandle();
      const workbench = await frameHandle.contentFrame();
      assert.equal(await workbench.evaluate(() => { try { return !!parent.document; } catch { return false; } }), false);
      assert.equal(await workbench.evaluate(() => typeof require), 'undefined');
      assert.equal(await nested('document-frame', 'typeof require'), 'undefined');
      const bridgeChannel = await page.evaluate(() => app.workspace.getLeavesOfType('folio-workbench')[0].view.frame.srcdoc.match(/"channel":"([^"]+)"/)[1]);
      await nested('document-frame', `top.postMessage(${JSON.stringify({folio:bridgeChannel,id:999999,route:'export',data:{name:'forged.html',source:original}})}, '*')`);
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => app.vault.getFiles().filter(f=>f.path.startsWith('Folio/')).length), isolation.copies, 'Nested HTML cannot invoke the privileged bridge even with the channel');
      await page.screenshot({path:root+'/test-results/obsidian-saved.png'});
      console.log('Obsidian 实测通过：插件加载、点选留言、修改对照、采用不写原文、关页草稿恢复、Vault 保存、备份、另存与父页面隔离。' + (mode === 'real' ? '已使用真实本机 Codex。' : '模型使用测试替身。'));
    }
  }
} finally { if (browser.isConnected()) await browser.close(); }
