import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.env.FOLIO_REVIEW_TEST_ROOT||'/private/tmp/folio-review-native';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9236');
const page=browser.contexts()[0].pages().find(p=>p.url().startsWith('app://obsidian.md/'));
const notePath='审稿测试.md',source='# 合成方案\n\n第一段需要精简。\n\n第二段需要补充说明。\n';
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
  assert.ok(page,'Native Obsidian page required');
  assert.equal(await page.evaluate(()=>app.vault.adapter.getBasePath()),root+'/.test-vault');
  await mkdir(root+'/test-results',{recursive:true});
  await page.evaluate(async()=>{document.querySelector('.modal-header-button')?.click();await app.plugins.unloadPlugin('folio-codex');await app.plugins.enablePluginAndSave('folio-codex');await app.plugins.plugins['folio-codex'].ready;});
  await page.evaluate(async({notePath,source})=>{
    const p=app.plugins.plugins['folio-codex'];await p.pointSelect.stop(false);for(const v of [...p.noteViews])v.leaf.detach();
    const file=app.vault.getAbstractFileByPath(notePath);if(file)await app.vault.modify(file,source);else await app.vault.create(notePath,source);
    await p.state.mutate(d=>{d.notes={};});
    window.reviewCalls=[];
    p.noteReview=async()=>({issues:[{quote:'第一段需要精简。',startLine:3,endLine:3,title:'精简第一段',comment:'删去重复说明，让第一段更简洁。',category:'clarity'},{quote:'第二段需要补充说明。',startLine:5,endLine:5,title:'补充第二段',comment:'补充具体说明。',category:'evidence'}]});
    p.noteGenerate=async args=>{window.reviewCalls.push({mode:args.mode,history:args.history});return args.mode==='ask'?{answer:args.history?.length?'这是结合上一轮的**追问回答**。':'这是第一次**解释**。',citations:[]}:{replacement:args.capture.expected.includes('第一段')?'第一段。':'第二段的具体说明。',summary:'按审稿意见调整。'};};
    await p.openNote(app.vault.getAbstractFileByPath(notePath));
  },{notePath,source});
  const panel=page.locator('.folio-note-panel');
  await page.locator('.folio-note-panel-toggle').click();
  await panel.locator('.folio-review-request-button').click();
  await page.locator('.folio-review-request').getByText(/当前笔记全文/).waitFor();
  await page.locator('.folio-review-start').click();
  await page.locator('.folio-inline-card').nth(1).waitFor();
  assert.equal(await readFile(root+'/.test-vault/'+notePath,'utf8'),source);
  const first=page.locator('.folio-inline-card').filter({hasText:'精简第一段'});
  await first.locator('summary').click();await first.locator('.folio-inline-reply').click();
  await page.locator('.folio-card-composer textarea').fill('为什么要精简？');await page.locator('.folio-card-send').click();
  await panel.locator('.folio-note-answer').filter({hasText:'第一次'}).waitFor();
  await panel.locator('.folio-thread-reply').click();
  await page.locator('.folio-inline-composer textarea').fill('结合上一轮，再解释一下。');await page.locator('.folio-inline-send').click();
  await panel.locator('.folio-note-answer').filter({hasText:'追问回答'}).waitFor();
  assert.equal(await page.evaluate(()=>window.reviewCalls.at(-1).history.length),1);
  await page.screenshot({path:root+'/test-results/review-thread.png'});
  // Queue this thread for an edit, then generate both review suggestions.
  await panel.locator('.folio-thread-edit').click();
  await page.locator('.folio-inline-composer textarea').fill('精简第一段，保留原意。');await page.locator('.folio-inline-send').click();
  await panel.locator('.folio-note-apply').waitFor();
  await panel.locator('.folio-review-generate').click();
  await page.waitForFunction(()=>{const p=app.plugins.plugins['folio-codex'];return p.state.data.notes['审稿测试.md'].records.filter(r=>r.state==='ready').length===2&&!p.noteViews.values().next().value.controller;});
  await panel.locator('.folio-review-preview').click();
  await page.locator('.folio-revision-save:enabled').waitFor();
  assert.ok(await page.locator('.folio-revision-final').innerText().then(t=>t.includes('第一段。')&&t.includes('第二段的具体说明。')));
  await page.screenshot({path:root+'/test-results/review-revisions.png'});
  // Accept only the first paragraph, preserve the second proposal, then accept it.
  const second=page.locator('.folio-revision-choices label').filter({hasText:'补充具体说明。'});
  await second.locator('input').uncheck();await page.locator('.folio-revision-save:enabled').waitFor();
  await page.locator('.folio-revision-save').click();await page.locator('.folio-revision-modal').waitFor({state:'detached'});
  assert.equal(await readFile(root+'/.test-vault/'+notePath,'utf8'),source.replace('第一段需要精简。','第一段。'));
  await panel.locator('.folio-review-preview').click();await page.locator('.folio-revision-save:enabled').waitFor();await page.locator('.folio-revision-save').click();await page.locator('.folio-revision-modal').waitFor({state:'detached'});
  assert.match(await readFile(root+'/.test-vault/'+notePath,'utf8'),/第二段的具体说明/);
  await panel.locator('.folio-review-undo').click();
  await page.waitForFunction(()=>app.plugins.plugins['folio-codex'].state.data.notes['审稿测试.md'].records.some(r=>r.state==='undone'));
  assert.equal(await readFile(root+'/.test-vault/'+notePath,'utf8'),source.replace('第一段需要精简。','第一段。'));
  // Unrelated text additions preserve anchored discussion; rename keeps history.
  await page.evaluate(async notePath=>{const f=app.vault.getAbstractFileByPath(notePath);await app.vault.modify(f,'前言。\n\n'+await app.vault.read(f));},notePath);
  await page.locator('.folio-inline-card').first().waitFor();
  await page.evaluate(async notePath=>{const next='审稿测试-改名.md',old=app.vault.getAbstractFileByPath(next);if(old)await app.vault.delete(old);await app.fileManager.renameFile(app.vault.getAbstractFileByPath(notePath),next);await app.plugins.plugins['folio-codex'].renameQueue;},notePath);
  await panel.locator('.folio-note-path').filter({hasText:'审稿测试-改名.md'}).waitFor();
  await page.evaluate(async()=>{const p=app.plugins.plugins['folio-codex'];for(const v of [...p.noteViews])v.leaf.detach();await p.openNote(app.vault.getAbstractFileByPath('审稿测试-改名.md'));});
  assert.ok(await panel.locator('.folio-note-history-item').count()>=2);
  await page.screenshot({path:root+'/test-results/review-restored.png'});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({review:true,inlineFollowUp:true,historyScoped:true,batchPreview:true,partialAccept:true,undo:true,rename:true,reopen:true,pageErrors:errors.length}));
} catch(error){await page?.screenshot({path:root+'/test-results/review-failure.png'});console.error(error.message);throw error;}
finally{await browser.close();}
