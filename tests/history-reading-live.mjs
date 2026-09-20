import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const root=process.env.FOLIO_REVIEW_TEST_ROOT||'/private/tmp/folio-review-native';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9236');
const page=browser.contexts()[0].pages().find(p=>p.url().startsWith('app://obsidian.md/'));
const path='历史与阅读测试.md',source='# 讨论完整保留\n\n这是供讨论的合成原文。\n\n第二段内容保持原样。\n';
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 assert.equal(await page.evaluate(()=>app.vault.adapter.getBasePath()),root+'/.test-vault');
 const reset=await page.context().newCDPSession(page);await reset.send('Emulation.clearDeviceMetricsOverride');await reset.detach();
 await mkdir(root+'/test-results',{recursive:true});
 await page.evaluate(async({path,source})=>{
  await app.plugins.unloadPlugin('folio-codex');await app.plugins.loadPlugin('folio-codex');
  const p=app.plugins.plugins['folio-codex'];await p.ready;for(const v of [...p.noteViews])v.leaf.detach();
  const f=app.vault.getAbstractFileByPath(path);if(f)await app.vault.modify(f,source);else await app.vault.create(path,source);
  await p.state.mutate(d=>{delete d.notes?.[path];});app.workspace.rightSplit.collapse();window.historyCalls=[];
  p.noteGenerate=async args=>{window.historyCalls.push(args.history);return {answer:'**长回答示例**\n\n'+Array.from({length:14},(_,i)=>`第 ${i+1} 点：回答跟随页面阅读，不需要在卡片里单独滚动。`).join('\n\n')+'\n\n```text\n'+('wide code '.repeat(25))+'\n```\n\n| 项目 | 说明 |\n|---|---|\n| 宽内容 | '+('很长的表格内容'.repeat(25))+' |',citations:[]};};
  await p.openNote(app.vault.getAbstractFileByPath(path));
 },{path,source});
 await page.locator('.folio-note-point-mode p').filter({hasText:/^这是供讨论/}).click();
 await page.locator('[data-note-action="ask"]').click();await page.locator('.folio-inline-composer textarea').fill('第 1 轮问题');await page.locator('.folio-inline-send').click();
 await page.waitForFunction(()=>app.plugins.plugins['folio-codex'].state.data.notes['历史与阅读测试.md']?.records[0]?.state==='answered');
 await page.evaluate(async path=>{
  const p=app.plugins.plugins['folio-codex'],v=[...p.noteViews].find(v=>v.path===path);
  if(v.task)await v.task;
  for(let i=2;i<=12;i++){
   const r=p.state.data.notes[path].records[0];await v.useCapture(r.capture,'ask',{replyId:r.id,focus:false});v.message=`第 ${i} 轮问题`;await v.run();
  }
  const r=p.state.data.notes[path].records[0];window.historyId=r.id;
  for(let i=1;i<=34;i++)await p.noteStore.record(path,{id:'synthetic-'+i,capture:r.capture,mode:'ask',message:'独立讨论 '+i,result:{answer:'合成回答',citations:[]},state:'answered',date:Date.now()+i,resolved:true});
  await v.reloadRecords();p.pointSelect.inline.refresh(path);
 },path);
 const card=page.locator('.folio-inline-card');await card.waitFor();if(!await card.evaluate(e=>e.open))await card.locator(':scope > summary').click();
 const history=card.locator('.folio-card-history');assert.equal(await history.evaluate(e=>e.open),true);
 assert.equal(await history.locator('.folio-conversation-turn').count(),11);
 const disk=await page.evaluate(async path=>{const p=app.plugins.plugins['folio-codex'];await p.state.queue;const d=JSON.parse(await app.vault.adapter.read(p.state.directory+'/state.json'));const r=d.notes[path].records.find(r=>r.id===window.historyId);return {records:d.notes[path].records.length,turns:r.turns.length,first:r.turns[0].message,maxContext:Math.max(...window.historyCalls.map(h=>h.length))};},path);
 assert.deepEqual({...disk,maxContext:undefined},{records:35,turns:11,first:'第 1 轮问题',maxContext:undefined});assert.ok(disk.maxContext>0&&disk.maxContext<=8);
 await history.locator(':scope > summary').click();await page.waitForFunction(()=>app.plugins.plugins['folio-codex'].state.data.notes['历史与阅读测试.md'].display[window.historyId]?.historyOpen===false);
 const layout=await card.locator('.folio-inline-answer').evaluate(e=>({maxHeight:getComputedStyle(e).maxHeight,overflow:getComputedStyle(e).overflowY,height:e.clientHeight,scroll:e.scrollHeight}));
 assert.equal(layout.maxHeight,'none');assert.equal(layout.overflow,'visible');assert.ok(layout.height>300);assert.ok(layout.scroll<=layout.height+1);
 const selection=await page.evaluate(()=>{const e=document.querySelector('.folio-note-point-selected');return {section:getComputedStyle(e).outlineStyle,paragraph:getComputedStyle(e.querySelector('p')).outlineStyle,thread:getComputedStyle(e.querySelector('.folio-inline-thread')).outlineStyle};});
 assert.deepEqual(selection,{section:'none',paragraph:'solid',thread:'none'});
 await card.locator(':scope > summary').scrollIntoViewIfNeeded();await page.screenshot({path:root+'/test-results/history-reading-desktop.png'});
 await page.evaluate(path=>app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path===path).view.previewMode.rerender(true),path);
 await history.waitFor({state:'attached'});assert.equal(await history.evaluate(e=>e.open),false);assert.equal(await card.evaluate(e=>e.open),true);
 await page.locator('.folio-note-panel-toggle').click();await page.locator('.folio-history-count').waitFor();
 assert.match(await page.locator('.folio-history-count').textContent(),/30 \/ 35/);
 await page.locator('.folio-history-more').click();assert.match(await page.locator('.folio-history-count').textContent(),/35 \/ 35/);assert.equal(await page.locator('.folio-note-history-item').count(),35);
 await page.locator('.folio-note-collapse').click();
 await card.locator('.folio-discussion-export').click();await page.locator('.folio-export-confirm').click();
 await page.waitForFunction(()=>app.vault.getMarkdownFiles().some(f=>f.path.startsWith('历史与阅读测试-讨论-')));
 await page.evaluate(async()=>{await app.plugins.plugins['folio-codex'].state.queue;await app.plugins.unloadPlugin('folio-codex');await app.plugins.loadPlugin('folio-codex');await app.plugins.plugins['folio-codex'].ready;});
 await page.evaluate(path=>app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path===path).view.previewMode.rerender(true),path);
 await history.waitFor({state:'attached'});assert.equal(await history.evaluate(e=>e.open),false);assert.equal(await card.evaluate(e=>e.open),true);
 const reloaded=await page.evaluate(async({path,source})=>{const p=app.plugins.plugins['folio-codex'],r=p.state.data.notes[path].records.find(r=>r.id===window.historyId);return {records:p.state.data.notes[path].records.length,turns:r.turns.length,unchanged:(await app.vault.read(app.vault.getAbstractFileByPath(path)))===source};},{path,source});
 assert.deepEqual(reloaded,{records:35,turns:11,unchanged:true});
 await page.evaluate(()=>app.workspace.leftSplit.collapse());
 const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setDeviceMetricsOverride',{width:480,height:900,deviceScaleFactor:1,mobile:false});
 await card.locator(':scope > summary').evaluate(e=>e.scrollIntoView({block:'start'}));await page.screenshot({path:root+'/test-results/history-reading-narrow.png'});
 const narrow=await card.evaluate(e=>({width:e.clientWidth,scroll:e.scrollWidth}));assert.ok(narrow.scroll<=narrow.width+1);await cdp.send('Emulation.clearDeviceMetricsOverride');await cdp.detach();await page.evaluate(()=>app.workspace.leftSplit.expand());
 assert.deepEqual(errors,[]);const result={...disk,layout,selection,narrow,reloaded,preferencesSurviveReload:true,paging:true,export:true,pageErrors:0};
 await writeFile(root+'/test-results/history-reading-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){await page.screenshot({path:root+'/test-results/history-reading-failure.png'});throw error;}finally{await browser.close();}
