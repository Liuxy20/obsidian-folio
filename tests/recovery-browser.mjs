import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { inspect } from '../server/documents.js';
const dataDir = await mkdtemp(path.join(tmpdir(), 'folio-recovery-test-'));
const { server, store } = await createApp({ dataDir, status: async () => ({ available: true, mode: 'test', model: '恢复测试替身', provider: '本地测试' }), generate: async ({ block }) => ({ html: block.html.replace('</h1>', '· 恢复验证</h1>'), summary: '恢复测试修改' }) });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.FOLIO_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const open = async () => { const page = await context.newPage(); await page.goto(base); await page.waitForLoadState('networkidle'); return page; };
  const list = page => page.evaluate(async () => { const { RecoveryStore } = await import('/recovery.js'); return new RecoveryStore().list(sessionStorage.getItem('folio.lastDocument')); });
  const addAndApply = async page => {
    const frame = page.frameLocator('#document-frame'); await frame.locator('h1').click(); await frame.getByRole('textbox', { name: '修改留言' }).fill('追加恢复验证');
    await frame.getByRole('button', { name: '让 AI 改这里 ↗', exact: true }).click(); await page.locator('#proposal').waitFor(); await page.locator('#accept').click();
  };
  let page = await open(); const [{ id }] = await store.list(); const original = await store.get(id);
  await addAndApply(page); await page.waitForFunction(() => document.getElementById('save-state').textContent === '草稿已自动暂存 · 未保存');
  assert.equal((await store.get(id)).source, original.source);
  const [checkpoint] = await list(page); assert.match(checkpoint.source, /恢复验证/);
  await page.close(); page = await open();
  await page.frameLocator('#document-frame').locator('h1').filter({ hasText: '恢复验证' }).waitFor();
  assert.match(await page.locator('#recovery-message').textContent(), /已恢复上次/);
  assert.equal((await store.get(id)).source, original.source);
  await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/recovered.png', fullPage: true });
  await page.locator('#undo').click(); await page.waitForFunction(() => document.getElementById('save-state').textContent === '已保存到本机');
  assert.equal((await list(page)).length, 0, 'Undo to disk version clears the recovered lineage');
  await page.locator('#redo').click(); await page.waitForFunction(() => document.getElementById('save-state').textContent === '草稿已自动暂存 · 未保存');
  await page.locator('#save').click(); await page.waitForFunction(() => document.getElementById('save-state').textContent === '已保存到本机');
  assert.equal((await list(page)).length, 0); await page.reload(); await page.waitForLoadState('networkidle'); assert.equal(await page.locator('#recovery-banner').isVisible(), false);
  const disk = await store.get(id);
  // Two independently edited windows must not replace one another's checkpoints.
  const sourceA = disk.source.replace('恢复验证', '窗口甲修改'), sourceB = disk.source.replace('恢复验证', '窗口乙修改');
  const record = (key, source, title, time) => ({ key, revision: key + '-revision', documentId: id, baseVersion: disk.version, source, version: inspect(source).version, title, name: 'report.html', notes: [], composerDrafts: [], undo: [], redo: [], ancestors: [], updatedAt: time });
  const a = record('test-A', sourceA, '窗口 A', Date.now()), b = record('test-B', sourceB, '窗口 B', Date.now() + 1);
  await page.evaluate(async records => { const { RecoveryStore } = await import('/recovery.js'); const s = new RecoveryStore(); for (const r of records) await s.put(r); }, [a,b]);
  await page.reload(); await page.locator('#recovery-dialog').waitFor();
  await page.locator('.recovery-record').filter({ hasText: '窗口 A' }).getByRole('button', { name: '恢复此草稿', exact: true }).click();
  await page.frameLocator('#document-frame').locator('h1').filter({ hasText: '窗口甲修改' }).waitFor();
  const second = await open(); await second.locator('#recovery-dialog').waitFor();
  await second.locator('.recovery-record').filter({ hasText: '窗口 B' }).getByRole('button', { name: '恢复此草稿', exact: true }).click();
  await second.frameLocator('#document-frame').locator('h1').filter({ hasText: '窗口乙修改' }).waitFor();
  await page.locator('#save').click(); await page.waitForFunction(() => document.getElementById('save-state').textContent === '已保存到本机');
  assert.equal((await store.get(id)).source, sourceA);
  assert.ok((await list(second)).some(r => r.source === sourceB), 'Saving A must retain B');
  await second.close(); const conflict = await open(); await conflict.locator('#recovery-dialog').waitFor();
  assert.match(await conflict.locator('#recovery-explanation').textContent(), /原文件已有新版本/);
  assert.equal(await conflict.getByRole('button', { name: '恢复此草稿', exact: true }).count(), 0);
  assert.equal((await store.get(id)).source, sourceA);
  await conflict.getByRole('button', { name: '恢复为新文档', exact: true }).first().click();
  await conflict.frameLocator('#document-frame').locator('h1').filter({ hasText: '窗口乙修改' }).waitFor();
  assert.equal((await store.get(id)).source, sourceA); assert.equal((await store.list()).length, 2);
  const copyId = await conflict.evaluate(() => sessionStorage.getItem('folio.lastDocument')); assert.notEqual(copyId, id);
  await conflict.reload(); await conflict.waitForLoadState('networkidle');
  assert.equal(await conflict.evaluate(() => sessionStorage.getItem('folio.lastDocument')), copyId, 'Reload stays on the current document');
  // Revision-conditional cleanup cannot erase another page's later revision.
  await conflict.evaluate(async () => {
    const { RecoveryStore } = await import('/recovery.js'); const s = new RecoveryStore();
    await s.put({ key: 'cas', revision: 'new', documentId: 'test', source: 'new' }); await s.remove([{ key: 'cas', revision: 'old' }]);
    if ((await s.list('test')).length !== 1) throw new Error('Newer revision was deleted');
  });
  // Quota/storage failure is visible; the draft remains on screen, disk unchanged.
  const faultContext = await browser.newContext();
  await faultContext.addInitScript(() => { IDBObjectStore.prototype.put = function () { throw new DOMException('Test quota failure', 'QuotaExceededError'); }; });
  const fault = await faultContext.newPage(); await fault.goto(base); await fault.waitForLoadState('networkidle');
  const faultId = await fault.evaluate(() => sessionStorage.getItem('folio.lastDocument')); const faultDisk = await store.get(faultId);
  await addAndApply(fault); await fault.waitForFunction(() => document.getElementById('save-state').textContent === '自动暂存失败 · 请保存');
  assert.match(await fault.locator('#recovery-message').textContent(), /自动暂存失败/); assert.equal((await store.get(faultId)).source, faultDisk.source);
  assert.match(await fault.frameLocator('#document-frame').locator('h1').textContent(), /恢复验证/);
  await faultContext.close();
  console.log('恢复测试通过：关页重开、原文件不变、撤销/重做、保存清理、多窗口独立草稿、外部版本冲突、新文档恢复、当前文档记忆、条件清理与存储失败提示。');
} finally { await browser?.close(); await new Promise(r => server.close(r)); await rm(dataDir, { recursive: true, force: true }); }
