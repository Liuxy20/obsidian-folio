import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createApp} from '../server/index.js';
const dataDir=await mkdtemp(path.join(tmpdir(),'folio-browser-test-'));
const {server,store}=await createApp({dataDir,status:async()=>({available:true,mode:'test',model:'确定性测试替身',provider:'不连接模型'}),generate:async({block})=>{
 await new Promise(r=>setTimeout(r,220));
 let html=block.html;if(block.tag==='h1')html=html.replace('<h1>','<h1 style="font-size:30px;color:#286353">');else if(block.tag==='h2')html=html.replace('本周概览','本周重点');else if(block.tag==='td')html=html.replace('首次体验','新手体验');
 return {html,summary:block.tag==='h1'?'调整标题字号与颜色。':'根据留言修改文字。'};
}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.FOLIO_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});const errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForLoadState('networkidle');
 const frame=page.frameLocator('#document-frame');await frame.locator('[data-folio-ui]').waitFor({state:'attached'});
 await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/workspace.png',fullPage:true});
 const [{id}]=await store.list();const original=await store.get(id);assert.equal(original.source.includes('data-folio-block'),false);
 // Click exact heading, not its surrounding section; popup is inside document next to it.
 await frame.locator('h1').click();await frame.getByRole('textbox',{name:'修改留言'}).fill('字号调小为30px，改成深绿色');
 await page.screenshot({path:'test-results/annotation.png',fullPage:true});
 // Unsubmitted feedback survives closing, switching targets, and refreshing.
 await frame.getByRole('button',{name:'关闭留言',exact:true}).click();
 await frame.getByRole('heading',{name:'本周概览',exact:true}).click();
 await frame.getByRole('textbox',{name:'修改留言'}).fill('另一条未提交留言');
 await frame.getByRole('button',{name:'关闭留言',exact:true}).click();
 await frame.locator('h1').click();assert.equal(await frame.getByRole('textbox',{name:'修改留言'}).inputValue(),'字号调小为30px，改成深绿色');
 await page.reload();await page.waitForLoadState('networkidle');await frame.locator('h1').click();
 assert.equal(await frame.getByRole('textbox',{name:'修改留言'}).inputValue(),'字号调小为30px，改成深绿色');
 await frame.getByRole('button',{name:'加入留言',exact:true}).click();await page.locator('.note-card').first().waitFor();
 await frame.getByRole('heading',{name:'本周概览',exact:true}).click();await frame.getByRole('textbox',{name:'修改留言'}).fill('标题改成“本周重点”');await frame.getByRole('button',{name:'加入留言',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.note-card').length===2);
 assert.equal(await frame.locator('.pin').count(),2);
 // Reload retains pending comments; source has not been edited by annotation.
 await page.reload();await page.waitForLoadState('networkidle');await page.locator('.note-card').nth(1).waitFor();assert.equal((await store.get(id)).source,original.source);
 await page.locator('#generate').click();await page.locator('#proposal').waitFor();assert.equal((await store.get(id)).source,original.source);
 await page.locator('#preview-proposal').click();await page.frameLocator('#after-frame').locator('h1[style]').waitFor();await page.waitForTimeout(350);
 assert.equal(await page.locator('#review-change option').count(),2);
 await page.locator('#review-next').click();assert.equal(await page.locator('#review-position').textContent(),'2 / 2');
 const afterHandle=await page.locator('#after-frame').elementHandle(),afterFrame=await afterHandle.contentFrame();
 await page.waitForFunction(()=>document.getElementById('review-change').value==='1');
 await page.waitForTimeout(100);
 const selection=await afterFrame.evaluate(()=>document.querySelector('[data-folio-ui]').shadowRoot.getElementById('selection').getBoundingClientRect().top);
 const headingTop=await afterFrame.locator('h2').first().evaluate(e=>e.getBoundingClientRect().top);
 assert.ok(Math.abs(selection-(headingTop-3))<2,'Second review must highlight the second target');
 await page.locator('#review-prev').click();
 await page.screenshot({path:'test-results/compare.png',fullPage:true});await page.locator('[data-close="preview-dialog"]').click();
 // A rejected annotation keeps the composer open and preserves its text.
 await frame.locator('blockquote').click();await frame.getByRole('textbox',{name:'修改留言'}).fill('拒绝后也要保留这条留言');
 await frame.getByRole('button',{name:'加入留言',exact:true}).click();
 await frame.locator('#status').filter({hasText:'先采用或舍弃'}).waitFor();
 assert.equal(await frame.getByRole('textbox',{name:'修改留言'}).inputValue(),'拒绝后也要保留这条留言');
 await frame.getByRole('button',{name:'关闭留言',exact:true}).click();
 await page.locator('#accept').click();await frame.locator('h1[style]').waitFor();await frame.getByRole('heading',{name:'本周重点',exact:true}).waitFor();
 assert.equal((await store.get(id)).source,original.source,'Accept only changes draft');
 await page.waitForFunction(()=>document.getElementById('save-state').textContent==='草稿已自动暂存 · 未保存');
 await page.reload();await page.waitForLoadState('networkidle');await frame.locator('h1[style]').waitFor();
 assert.match(await page.locator('#recovery-message').textContent(),/已恢复上次/);
 assert.equal((await store.get(id)).source,original.source,'Reload recovery must not save the file');
 await page.locator('#undo').click();await frame.getByRole('heading',{name:'本周概览',exact:true}).waitFor();assert.equal(await frame.locator('h1').getAttribute('style'),null);
 assert.equal(await page.locator('.note-state.pending').count(),2,'Undo restores actionable notes');
 await page.locator('#redo').click();await frame.locator('h1[style]').waitFor();
 assert.equal(await page.locator('.note-state.applied').count(),2,'Redo restores applied state');
 await page.locator('#save').click();await page.waitForFunction(()=>document.getElementById('save-state').textContent==='已保存到本机');
 assert.match((await store.get(id)).source,/font-size:30px/);
 // Table cell targeting + one-click execute from the inline composer.
 await frame.getByRole('cell',{name:'首次体验',exact:true}).click();await frame.getByRole('textbox',{name:'修改留言'}).fill('改为新手体验');await frame.getByRole('button',{name:'让 AI 改这里 ↗',exact:true}).click();await page.locator('#proposal').waitFor();
 await page.locator('#accept').click();await frame.getByRole('cell',{name:'新手体验',exact:true}).waitFor();
 await page.locator('#save').click();await page.waitForFunction(()=>document.getElementById('save-state').textContent==='已保存到本机');
 // Restore requires save; no accidental disk writes.
 await page.locator('#history').click();await page.locator('#versions button').first().click();await frame.getByRole('cell',{name:'首次体验',exact:true}).waitFor();assert.match((await store.get(id)).source,/新手体验/);
 await page.locator('#save').click();await page.waitForFunction(()=>document.getElementById('save-state').textContent==='已保存到本机');
 const handle=await page.locator('#document-frame').elementHandle(),isolated=await handle.contentFrame();assert.equal(await isolated.evaluate(()=>{try{return !!parent.document;}catch{return false;}}),false);
 // Parent selection is available, but plain click selected only the h1.
 await frame.locator('h1').click();await frame.getByRole('button',{name:'↑ 选择上一级，修改更大范围'}).click();assert.match(await frame.locator('#quote').textContent(),/容器/);await frame.getByRole('button',{name:'关闭留言',exact:true}).click();
 const downloadPromise=page.waitForEvent('download');await page.locator('#export').click();const download=await downloadPromise;await download.saveAs('test-results/export.html');
 const exported=await readFile('test-results/export.html','utf8');assert.equal(/contenteditable|FOLIO_CHANNEL|data-folio-node|data-folio-ui/.test(exported),false);
 // Import a second ordinary HTML without any marker, with a static button and raster image.
 await page.locator('#file').setInputFiles({name:'plain.html',mimeType:'text/html',buffer:Buffer.from('<!doctype html><html><head><title>普通页面</title></head><body><h1>无需预设模块</h1><button>继续</button><img alt="像素图" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhskAAAAASUVORK5CYII="></body></html>')});
 await frame.getByRole('heading',{name:'无需预设模块'}).waitFor();await frame.getByRole('button',{name:'继续',exact:true}).click();await frame.getByRole('textbox',{name:'修改留言'}).waitFor();assert.match(await frame.locator('#quote').textContent(),/按钮/);
 await frame.getByRole('button',{name:'关闭留言',exact:true}).click();await frame.getByRole('img',{name:'像素图'}).click();assert.match(await frame.locator('#quote').textContent(),/图片/);
 assert.deepEqual(errors.filter(e=>!e.includes('404 (Not Found)')),[]);
 console.log('浏览器通过：未提交留言关闭/切换/刷新恢复、提交失败保留输入、批量逐条定位、撤销状态恢复；无标记导入、元素点选、就地留言、父级选择、批注持久化、批量AI、CSS与文字预览、表格、采用、撤销/重做、保存恢复、导出与隔离。');
}finally{await browser?.close();await new Promise(r=>server.close(r));await rm(dataDir,{recursive:true,force:true});}
