import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const root=process.env.FOLIO_REVIEW_TEST_ROOT||'/private/tmp/folio-review-native';
const path='侧栏与重答测试.md';
const source=['| 技能 | 用途 | 来源 | 说明 | 补充 |','| --- | --- | --- | --- | --- |',...Array.from({length:18},(_,i)=>`| **技能 ${i+1}** | 写需求与分析资料 | 官方文档 | ${'长列内容'.repeat(12)} | \`sample-${i+1}\` |`)].join('\n');
const browser=await chromium.connectOverCDP('http://127.0.0.1:9236');
const page=browser.contexts()[0].pages().find(p=>p.url().startsWith('app://obsidian.md/'));
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const read=()=>page.evaluate(path=>app.vault.read(app.vault.getAbstractFileByPath(path)),path);
const mock=()=>page.evaluate(()=>{app.plugins.plugins['folio-codex'].noteGenerate=async args=>{window.actionCalls.push({mode:args.mode,instruction:args.instruction,history:args.history});return {answer:`第 ${window.actionCalls.length} 份回答：用一个具体例子说明。`,citations:[]};};});
const settled=()=>page.waitForFunction(()=>document.querySelector('.folio-card-composer textarea')?.disabled===false);
try{
 assert.equal(await page.evaluate(()=>app.vault.adapter.getBasePath()),root+'/.test-vault');
 await mkdir(root+'/test-results',{recursive:true});
 await page.evaluate(async({path,source})=>{
  await app.plugins.unloadPlugin('folio-codex');await app.plugins.loadPlugin('folio-codex');const p=app.plugins.plugins['folio-codex'];await p.ready;
  for(const v of [...p.noteViews])v.leaf.detach();const f=app.vault.getAbstractFileByPath(path);if(f)await app.vault.modify(f,source);else await app.vault.create(path,source);
  await p.state.mutate(d=>{delete d.notes?.[path];});window.actionCalls=[];app.workspace.rightSplit.collapse();await p.openNote(app.vault.getAbstractFileByPath(path));
 },{path,source});await mock();
 await page.locator('.folio-note-point-mode table').first().click({position:{x:35,y:40}});await page.locator('[data-note-action="ask"]').click();
 await page.locator('.folio-inline-composer textarea').fill('解释这张表');await page.locator('.folio-inline-send').click();
 await page.waitForFunction(path=>app.plugins.plugins['folio-codex'].state.data.notes[path]?.records[0]?.state==='answered',path);
 await page.evaluate(async path=>{const p=app.plugins.plugins['folio-codex'];await p.notePanel(p.noteStore.file(path),{reveal:true});},path);
 const sidebar=page.locator('.folio-note-panel'),preview=sidebar.locator('.folio-sidebar-source .folio-card-target-preview');await preview.waitFor();
 assert.equal(await preview.locator('tbody tr').count(),18);assert.equal(await preview.locator('code').last().textContent(),'sample-18');
 await preview.evaluate(e=>e.scrollIntoView({block:'center'}));await preview.hover();await page.mouse.wheel(0,300);await page.waitForFunction(()=>document.querySelector('.folio-sidebar-source .folio-card-target-preview').scrollTop>0);
 await page.mouse.wheel(300,0);await page.waitForFunction(()=>document.querySelector('.folio-sidebar-source .folio-card-target-preview').scrollLeft>0);
 await preview.evaluate(async e=>{e.scrollTop=0;e.scrollLeft=0;e.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
 const before=await preview.evaluate(e=>e.clientHeight),rect=await preview.boundingBox();await page.mouse.move(rect.x+rect.width-3,rect.y+rect.height-3);await page.mouse.down();await page.mouse.move(rect.x+rect.width-3,rect.y+rect.height+80,{steps:10});await page.mouse.up();assert.ok(await preview.evaluate(e=>e.clientHeight)>before+40);
 await page.screenshot({path:root+'/test-results/sidebar-source.png'});
 await sidebar.locator('.folio-note-link').first().click();await page.waitForFunction(()=>!!document.querySelector('.folio-note-point-selected'));assert.equal(await read(),source);
 await page.evaluate(()=>app.workspace.rightSplit.collapse());
 const card=page.locator('.folio-inline-card');if(!await card.evaluate(e=>e.open))await card.locator(':scope > summary').click();await card.locator('.folio-inline-reply').click();
 const composer=page.locator('.folio-card-composer'),input=composer.locator('textarea');
 assert.equal(await composer.getByRole('button',{name:'修改笔记原文',exact:true}).count(),1);
 await composer.locator('[data-mode="reanswer"]').click();assert.match(await composer.locator('.folio-card-intent').textContent(),/旧回答保留，笔记不变/);assert.equal(await composer.locator('.folio-card-edit-target').isVisible(),false);
 await input.fill('更简洁，给一个例子。');
 await page.evaluate(async()=>{const p=app.plugins.plugins['folio-codex'];await p.state.queue;await app.plugins.unloadPlugin('folio-codex');await app.plugins.loadPlugin('folio-codex');await app.plugins.plugins['folio-codex'].ready;});
 await page.evaluate(path=>app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path===path).view.previewMode.rerender(true),path);
 await card.waitFor();if(!await card.evaluate(e=>e.open))await card.locator(':scope > summary').click();await card.locator('.folio-inline-reply').click();
 assert.equal(await input.inputValue(),'更简洁，给一个例子。');assert.equal(await composer.locator('[data-mode="reanswer"]').getAttribute('aria-pressed'),'true');await mock();
 await page.screenshot({path:root+'/test-results/reanswer-composer.png'});
 await composer.locator('.folio-card-send').click();await settled();
 let calls=await page.evaluate(()=>window.actionCalls);assert.equal(calls.length,2);assert.equal(calls.at(-1).mode,'ask');assert.match(calls.at(-1).instruction,/重新回答.*\n调整要求：更简洁，给一个例子。/);assert.equal(calls.at(-1).history.at(-1).response,'第 1 份回答：用一个具体例子说明。');
 assert.match(await card.locator('.folio-card-history').textContent(),/第 1 份回答/);assert.match(await card.locator('.folio-inline-answer').textContent(),/第 2 份回答/);assert.equal(await read(),source);
 // Empty adjustment still sends a new ask and keeps the reanswer mode as a draft.
 assert.equal(await input.inputValue(),'');await composer.locator('.folio-card-send').click();await settled();assert.equal(await page.evaluate(()=>window.actionCalls.length),3);
 const draft=await page.evaluate(path=>{const t=app.plugins.plugins['folio-codex'].state.data.notes[path];return t.inlineDrafts[t.records[0].id];},path);assert.equal(draft.mode,'reanswer');
 await page.evaluate(()=>{app.plugins.plugins['folio-codex'].noteGenerate=args=>new Promise((resolve,reject)=>args.signal.addEventListener('abort',()=>reject(Error('stopped')),{once:true}));});
 await input.fill('补充一个例子');await composer.locator('.folio-card-send').click();await card.locator('.folio-card-stop').click();await settled();assert.equal(await input.inputValue(),'补充一个例子');assert.equal(await composer.locator('[data-mode="reanswer"]').getAttribute('aria-pressed'),'true');
 await mock();await composer.locator('.folio-card-send').click();await settled();assert.equal(await read(),source);
 // Sidebar shortcut prepares an ask; it never sends without the user's submit.
 await page.evaluate(async path=>{const p=app.plugins.plugins['folio-codex'],v=await p.notePanel(p.noteStore.file(path),{reveal:true});v.activeRecord=v.records[0].id;v.render();},path);
 const count=await page.evaluate(()=>window.actionCalls.length);await sidebar.locator('.folio-thread-reanswer').click();await page.locator('.folio-inline-composer').waitFor();assert.match(await page.locator('.folio-inline-composer textarea').inputValue(),/请重新回答/);assert.equal(await page.evaluate(()=>window.actionCalls.length),count);assert.equal(await read(),source);
 assert.deepEqual(errors,[]);const result={sidebarFullTable:18,sidebarVerticalWheel:true,sidebarHorizontalWheel:true,sidebarDragResize:true,locateOriginal:true,clearEditLabel:true,reanswerDraftReload:true,reanswerUsesAsk:true,previousAnswersKept:true,emptyAdjustment:true,stopRetry:true,sidebarPreparesWithoutSending:true,noteUnchanged:true,pageErrors:0};
 await writeFile(root+'/test-results/clear-actions-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){await page.screenshot({path:root+'/test-results/clear-actions-failure.png'});throw error;}finally{await browser.close();}
