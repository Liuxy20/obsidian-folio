import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const root=process.env.FOLIO_REVIEW_TEST_ROOT||'/private/tmp/folio-review-native';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9236');
const page=browser.contexts()[0].pages().find(p=>p.url().startsWith('app://obsidian.md/'));
const path='引用与修改测试.md',source='方案需要说明，成本为 12 元。',replacement='方案需要补充使用说明，成本为 12 元。';
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const read=()=>page.evaluate(path=>app.vault.read(app.vault.getAbstractFileByPath(path)),path);
const mock=()=>page.evaluate(replacement=>{app.plugins.plugins['folio-codex'].noteGenerate=async args=>{window.quoteCalls.push({mode:args.mode,instruction:args.instruction,quote:args.quotedAnswer,capture:args.capture,history:args.history,preserveNumbers:args.preserveNumbers});return args.mode==='edit'?{replacement,summary:'补充使用说明'}:{answer:'建议采用 **方案 A**，先验证。\n\n这是另一句解释。',citations:[]};};},replacement);
const selectFirst=async()=>{await page.locator('[data-folio-answer-index="0"] p').first().evaluate(el=>{const selection=el.ownerDocument.getSelection(),range=el.ownerDocument.createRange();range.selectNodeContents(el);selection.removeAllRanges();selection.addRange(range);});await page.locator('.folio-answer-quote-tool').waitFor();};
try{
 assert.equal(await page.evaluate(()=>app.vault.adapter.getBasePath()),root+'/.test-vault');
 await mkdir(root+'/test-results',{recursive:true});
 await page.evaluate(async({path,source})=>{
  await app.plugins.unloadPlugin('folio-codex');await app.plugins.loadPlugin('folio-codex');const p=app.plugins.plugins['folio-codex'];await p.ready;
  for(const v of [...p.noteViews])v.leaf.detach();const file=app.vault.getAbstractFileByPath(path);if(file)await app.vault.modify(file,source);else await app.vault.create(path,source);
  await p.state.mutate(d=>{delete d.notes?.[path];});window.quoteCalls=[];app.workspace.rightSplit.collapse();await p.openNote(app.vault.getAbstractFileByPath(path));
 },{path,source});await mock();
 await page.locator('.folio-note-point-mode p').filter({hasText:source}).click();await page.locator('[data-note-action="ask"]').click();
 await page.locator('.folio-inline-composer textarea').fill('应该怎么处理？');await page.locator('.folio-inline-send').click();
 const card=page.locator('.folio-inline-card');await card.waitFor();await page.waitForFunction(()=>app.plugins.plugins['folio-codex'].state.data.notes['引用与修改测试.md']?.records[0]?.state==='answered');
 if(!await card.evaluate(e=>e.open))await card.locator(':scope > summary').click();
 await selectFirst();await page.screenshot({path:root+'/test-results/quote-selection.png'});await page.locator('.folio-answer-quote-tool').click();
 const composer=page.locator('.folio-card-composer'),input=composer.locator('textarea');await composer.waitFor();
 assert.match(await composer.locator('.folio-card-quote').textContent(),/引用第 1 轮 AI 回答/);assert.match(await composer.locator('.folio-card-quote').textContent(),/方案 A/);
 await input.fill('为什么选择这个方案？');await composer.locator('[data-mode="edit"]').click();
 assert.match(await composer.locator('.folio-card-edit-target').textContent(),/修改原笔记.*成本为 12 元/);
 await page.evaluate(async()=>{await app.plugins.plugins['folio-codex'].state.queue;await app.plugins.unloadPlugin('folio-codex');await app.plugins.loadPlugin('folio-codex');await app.plugins.plugins['folio-codex'].ready;});
 await page.evaluate(path=>app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path===path).view.previewMode.rerender(true),path);
 await card.waitFor();if(!await card.evaluate(e=>e.open))await card.locator(':scope > summary').click();await card.locator('.folio-inline-reply').click();
 assert.equal(await input.inputValue(),'为什么选择这个方案？');assert.equal(await composer.locator('[data-mode="edit"]').getAttribute('aria-pressed'),'true');assert.match(await composer.locator('.folio-card-quote').textContent(),/第 1 轮/);
 await mock();await composer.locator('[data-mode="ask"]').click();await composer.locator('.folio-card-send').click();
 await page.waitForFunction(()=>document.querySelector('.folio-card-composer textarea')?.disabled===false);
 assert.equal(await read(),source);const call=await page.evaluate(()=>window.quoteCalls.at(-1));assert.equal(call.mode,'ask');assert.deepEqual(call.quote,{round:1,text:'建议采用 方案 A，先验证。'});assert.equal(call.instruction,'为什么选择这个方案？');
 assert.match(await card.locator('.folio-inline-body > .folio-quoted-answer').textContent(),/第 1 轮/);
 // The first answer has moved to history; selecting it still targets round 1.
 await selectFirst();await page.locator('.folio-answer-quote-tool').click();await composer.locator('[data-mode="edit"]').click();await input.fill('按这条建议补充原文，保留成本。');
 await page.screenshot({path:root+'/test-results/quote-edit-composer.png'});
 await page.evaluate(()=>{app.plugins.plugins['folio-codex'].noteGenerate=args=>new Promise((resolve,reject)=>{args.signal.addEventListener('abort',()=>reject(Error('stopped')),{once:true});});});
 await composer.locator('.folio-card-send').click();await card.locator('.folio-card-stop').click();await page.waitForFunction(()=>document.querySelector('.folio-card-composer textarea')?.disabled===false);
 assert.equal(await input.inputValue(),'按这条建议补充原文，保留成本。');assert.match(await composer.locator('.folio-card-quote').textContent(),/第 1 轮/);
 await mock();await composer.locator('.folio-card-send').click();await page.waitForFunction(()=>document.querySelector('.folio-card-composer textarea')?.disabled===false);
 const edit=await page.evaluate(()=>window.quoteCalls.at(-1));assert.equal(edit.mode,'edit');assert.equal(edit.capture.expected,source);assert.equal(edit.quote.round,1);assert.equal(edit.preserveNumbers,true);assert.equal(await read(),source);
 await card.getByRole('button',{name:'预览并保存',exact:true}).click();await page.locator('.folio-revision-modal').waitFor();assert.equal(await read(),source);
 assert.match(await page.locator('.folio-revision-change').textContent(),/补充使用说明/);await page.screenshot({path:root+'/test-results/quote-edit-preview.png'});
 await page.locator('.folio-revision-save').click();await page.locator('.folio-revision-modal').waitFor({state:'hidden'});assert.equal(await read(),replacement);
 assert.equal(await page.evaluate(()=>app.workspace.rightSplit.collapsed),true);
 await page.evaluate(async path=>{const p=app.plugins.plugins['folio-codex'];await p.noteStore.undoBatch(path);await [...p.noteViews].find(v=>v.path===path).reloadRecords();p.pointSelect.inline.refresh(path);},path);assert.equal(await read(),source);
 await card.locator('.folio-inline-reply').click();await selectFirst();await page.locator('.folio-answer-quote-tool').click();await composer.locator('.folio-cancel-quote').click();assert.equal(await composer.locator('.folio-quoted-answer').count(),0);
 // Reject ranges crossing two different answers instead of misattributing text.
 await page.locator('[data-folio-answer-index]').first().evaluate(el=>{const end=el.closest('.folio-inline-card').querySelectorAll('[data-folio-answer-index]')[1];const s=el.ownerDocument.getSelection(),r=el.ownerDocument.createRange();r.setStart(el,0);r.setEnd(end,end.childNodes.length);s.removeAllRanges();s.addRange(r);});
 await page.waitForFunction(()=>!document.querySelector('.folio-answer-quote-tool'));
 assert.deepEqual(errors,[]);const result={quoteSelection:true,historyRoundStable:true,draftModeAndQuoteReload:true,askDoesNotEdit:true,editTargetIsOriginal:true,previewBeforeSave:true,undo:true,stopRetry:true,cancelQuote:true,crossAnswerSelectionRejected:true,sidebarRemainsClosed:true,pageErrors:0};
 await writeFile(root+'/test-results/quote-edit-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){await page.screenshot({path:root+'/test-results/quote-edit-failure.png'});throw error;}finally{await browser.close();}
