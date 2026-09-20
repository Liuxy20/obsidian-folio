import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
const root=process.env.FOLIO_REVIEW_TEST_ROOT||'/private/tmp/folio-review-native';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9236');
const page=browser.contexts()[0].pages().find(p=>p.url().startsWith('app://obsidian.md/'));
const notePath='卡片追问测试.md',source='# 直接在这里继续讨论\n\n方案还需要补充使用说明。\n\n下一步是邀请读者试用。\n';
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const sidebarClosed=()=>page.evaluate(()=>app.workspace.rightSplit.collapsed);
try{
  assert.equal(await page.evaluate(()=>app.vault.adapter.getBasePath()),root+'/.test-vault');
  await mkdir(root+'/test-results',{recursive:true});
  await page.evaluate(async({notePath,source})=>{
    document.querySelector('.modal-header-button')?.click();
    await app.plugins.unloadPlugin('folio-codex');await app.plugins.loadPlugin('folio-codex');
    const p=app.plugins.plugins['folio-codex'];await p.ready;
    for(const v of [...p.noteViews])v.leaf.detach();
    const file=app.vault.getAbstractFileByPath(notePath);if(file)await app.vault.modify(file,source);else await app.vault.create(notePath,source);
    await p.state.mutate(d=>{delete d.notes?.[notePath];});
    app.workspace.rightSplit.collapse();window.cardCalls=[];
    p.noteGenerate=async args=>{window.cardCalls.push({instruction:args.instruction,history:args.history});return {answer:'建议补充 **安装步骤** 和一个简单的使用示例。',citations:[]};};
    await p.openNote(app.vault.getAbstractFileByPath(notePath));
  },{notePath,source});
  assert.equal(await sidebarClosed(),true);
  await page.locator('.folio-note-point-mode p').filter({hasText:/^方案还需要/}).click();
  await page.locator('[data-note-action="ask"]').click();
  await page.locator('.folio-inline-composer textarea').fill('需要补充哪些说明？');await page.locator('.folio-inline-send').click();
  let card=page.locator('.folio-inline-card').filter({hasText:'需要补充哪些说明？'});
  await card.locator('summary').click();await card.locator('.folio-inline-answer').waitFor();
  assert.equal(await sidebarClosed(),true);
  // Reproduce an upgraded 0.3.5 sidebar with the already-sent text still in draft.
  await page.evaluate(async notePath=>{const p=app.plugins.plugins['folio-codex'],v=[...p.noteViews][0],r=p.state.data.notes[notePath].records[0];window.originalCardId=r.id;v.capture=r.capture;v.message=r.message;v.mode=r.mode;v.replyId=null;await v.persist();},notePath);
  const location=await card.boundingBox();
  await card.locator('.folio-inline-reply').click();
  const composer=page.locator('.folio-card-composer');await composer.waitFor();
  assert.equal(await composer.evaluate(el=>!!el.closest('.folio-inline-card')),true);
  assert.ok(Math.abs((await card.boundingBox()).y-location.y)<3,'Opening a reply must not locate/scroll the paragraph');
  assert.equal(await page.locator('.folio-inline-composer').count(),0);
  await composer.locator('textarea').fill('给第一次使用的人举个例子。');
  await composer.getByRole('button',{name:'收起追问，保留草稿'}).click();
  await card.locator('.folio-inline-reply').click();assert.equal(await composer.locator('textarea').inputValue(),'给第一次使用的人举个例子。');
  await page.evaluate(notePath=>app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path===notePath).view.previewMode.rerender(true),notePath);
  await composer.waitFor();assert.equal(await composer.locator('textarea').inputValue(),'给第一次使用的人举个例子。');
  await page.screenshot({path:root+'/test-results/card-reply-draft.png'});
  await page.evaluate(()=>{app.plugins.plugins['folio-codex'].noteGenerate=args=>{window.cardCalls.push({instruction:args.instruction,history:args.history});return new Promise((resolve,reject)=>{window.finishCard=resolve;args.signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});});};});
  await composer.locator('.folio-card-send').click();
  await page.locator('.folio-card-stop').waitFor();assert.equal(await sidebarClosed(),true);
  await page.evaluate(()=>window.finishCard({answer:'例如：**打开笔记 → 点击段落 → 留下问题**，再查看 AI 的回答。',citations:[]}));
  await page.locator('.folio-inline-answer').filter({hasText:'打开笔记'}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.folio-card-composer textarea')?.disabled===false);
  assert.equal(await composer.locator('textarea').inputValue(),'');
  assert.equal(await page.evaluate(()=>window.cardCalls.at(-1).history.length),1);
  assert.equal(await page.evaluate(notePath=>app.plugins.plugins['folio-codex'].state.data.notes[notePath].records.length,notePath),1,'Sent legacy input must not create a phantom draft');
  const turns=await page.locator('.folio-inline-card .folio-card-history-question').allTextContents();
  assert.deepEqual(turns,['需要补充哪些说明？','给第一次使用的人举个例子。']);
  assert.equal(await page.locator('.folio-conversation-turn').getByText(/安装步骤/).isVisible(),true);
  assert.equal(await sidebarClosed(),true);
  await composer.locator('textarea').fill('这条先不发完');await composer.locator('.folio-card-send').click();
  await page.locator('.folio-card-stop').click();
  await page.waitForFunction(()=>document.querySelector('.folio-card-composer textarea')?.disabled===false);
  assert.equal(await composer.locator('textarea').inputValue(),'这条先不发完');
  assert.equal(await sidebarClosed(),true);
  // A failed/cancelled request can be retried here without changing the note.
  await composer.locator('textarea').fill('再给一个简短例子。');await composer.locator('.folio-card-send').click();
  await page.locator('.folio-card-stop').waitFor();
  await page.evaluate(()=>window.finishCard({answer:'在一句话下面问：“这个结论的依据是什么？”',citations:[]}));
  await page.waitForFunction(()=>document.querySelector('.folio-card-composer textarea')?.disabled===false);
  await composer.getByRole('button',{name:'收起追问，保留草稿'}).click();
  await page.locator('.folio-inline-card').getByRole('button',{name:'查看详情与引用'}).click();
  assert.equal(await sidebarClosed(),false);
  await page.locator('.folio-note-collapse').click();assert.equal(await sidebarClosed(),true);
  await page.locator('.folio-note-panel-toggle').click();assert.equal(await sidebarClosed(),false);
  await page.locator('.folio-note-collapse').click();
  await page.locator('.folio-inline-reply').click();await composer.locator('textarea').fill('重载后保留的草稿');
  await page.evaluate(async()=>{await app.plugins.plugins['folio-codex'].state.queue;await app.plugins.unloadPlugin('folio-codex');await app.plugins.loadPlugin('folio-codex');await app.plugins.plugins['folio-codex'].ready;});
  // Reload never sends automatically; a saved card can be used with no open panel.
  await page.evaluate(notePath=>app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path===notePath).view.previewMode.rerender(true),notePath);
  card=page.locator('.folio-inline-card');if(!await card.evaluate(el=>el.open))await card.locator('summary').first().click();
  await card.locator('.folio-inline-reply').click();
  assert.equal(await composer.locator('textarea').inputValue(),'重载后保留的草稿');
  assert.equal(await sidebarClosed(),true);
  await page.screenshot({path:root+'/test-results/card-reply-complete.png'});
  await composer.getByRole('button',{name:'收起追问，保留草稿'}).click();
  await page.evaluate(async notePath=>{
    const p=app.plugins.plugins['folio-codex'],r=p.state.data.notes[notePath].records[0];
    await p.noteStore.record(notePath,{id:'second-independent-thread',capture:r.capture,message:'另一条独立讨论',mode:'ask',state:'answered',result:{answer:'另一条回答',citations:[]},date:Date.now()});
    // An update to the first thread must not move it below the newer thread.
    await p.noteStore.record(notePath,{...r,date:Date.now()+100});p.pointSelect.inline.refresh(notePath);
  },notePath);
  await page.waitForFunction(()=>document.querySelectorAll('.folio-inline-card').length===2);
  assert.deepEqual(await page.locator('.folio-inline-question').allTextContents(),['需要补充哪些说明？','另一条独立讨论']);
  await page.evaluate(notePath=>app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path===notePath).view.previewMode.rerender(true),notePath);
  await page.waitForFunction(()=>document.querySelectorAll('.folio-inline-card').length===2);
  assert.deepEqual(await page.locator('.folio-inline-question').allTextContents(),['需要补充哪些说明？','另一条独立讨论']);
  assert.equal(await readFile(root+'/.test-vault/'+notePath,'utf8'),source);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({cardComposer:true,noScrollJump:true,sidebarOnDemand:true,draftReload:true,history:true,stopAndRetry:true,noPhantomDraft:true,oldestFirst:true,noteUnchanged:true,pageErrors:0}));
}catch(error){await page?.screenshot({path:root+'/test-results/card-reply-failure.png'});throw error;}
finally{await browser.close();}
