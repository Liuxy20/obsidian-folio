import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { inspect, replaceElements, validateReplacement, DocumentStore, buildPreview } from '../server/documents.js';
const sample = await readFile(new URL('../examples/weekly-review.html', import.meta.url), 'utf8');
const patch = (e, html) => ({ targetId: e.id, expected: e.html, html });

test('普通 HTML 无需标记：识别实际嵌套元素，原文保持不变', () => {
  assert.equal(sample.includes('data-folio-block'), false);
  const doc = inspect(sample); assert.equal(doc.source, sample);
  const h1 = doc.elements.find(e => e.tag === 'h1'); assert.ok(h1);
  assert.equal(doc.elements.find(e => e.id === h1.parentId).tag, 'header');
  assert.ok(doc.elements.some(e => e.tag === 'td')); assert.ok(doc.elements.some(e => e.tag === 'strong'));
});
test('点击两个独立元素修改，未选中源码字节完全不变', () => {
  const doc = inspect(sample), a = doc.elements.find(e => e.tag === 'h1'), b = doc.elements.find(e => e.tag === 'h2');
  const ah = a.html.replace('好的想法', '新的想法'), bh = b.html.replace('本周概览', '本周重点');
  const result = replaceElements(sample, [patch(a, ah), patch(b, bh)], doc.version);
  assert.equal(result.source, sample.slice(0,a.start) + ah + sample.slice(a.end,b.start) + bh + sample.slice(b.end));
});
test('同位置陈旧快照和父子重叠批注被拒绝', () => {
  const doc = inspect(sample), a = doc.elements.find(e => e.tag === 'h1'), parent = doc.elements.find(e => e.id === a.parentId);
  const changed = replaceElements(sample, [patch(a,a.html.replace('好的想法','新的想法'))]);
  assert.throws(() => replaceElements(changed.source,[patch(a,a.html)],doc.version), {status:409});
  assert.throws(() => replaceElements(sample,[patch(a,a.html),patch(parent,parent.html)]), {status:409});
  assert.throws(() => replaceElements(sample,[patch(a,a.html),patch(a,a.html)]), {status:409});
});
test('真实 DOM 上下文支持表格单元格；删除一个元素不动其他源码', () => {
  const doc=inspect(sample), cell=doc.elements.find(e=>e.tag==='td');
  const result=replaceElements(sample,[patch(cell,cell.html.replace('首次体验','新手体验'))]); assert.match(result.source,/新手体验/);
  const a=doc.elements.find(e=>e.tag==='blockquote'); assert.equal(replaceElements(sample,[patch(a,'')]).source,sample.slice(0,a.start)+sample.slice(a.end));
});
test('数字保护检查可见内容，不限制 CSS 中的数字', () => {
  const e=inspect(sample).elements.find(e=>e.tag==='strong' && e.text==='68%');
  assert.throws(()=>validateReplacement(e.html.replace('68%','78%'),e,true), {status:422});
  assert.throws(()=>validateReplacement('',e,true), {status:422});
  assert.match(validateReplacement(e.html.replace('<strong>','<strong style="font-size:48px">'),e,true),/48px/);
});
test('普通 HTML 的可省略结束标签可定位并改成显式标签', () => {
  const source='<html><body><ul><li>甲<li>乙</ul></body></html>';
  const doc=inspect(source), item=doc.elements.find(e=>e.tag==='li');
  assert.equal(replaceElements(source,[patch(item,item.html)]).source,source);
  assert.match(replaceElements(source,[patch(item,'<li>新甲</li>')]).source,/<li>新甲<\/li><li>乙/);
});
test('拒绝主动内容、伪造预览标记、全局样式和越界替换', () => {
  for (const code of ['<script>alert(1)</script>','<iframe></iframe>','<svg></svg>','<form></form>','<style>@import "https://example.com";</style>','<img src="javascript:alert(1)">','<p data-folio-node="spoof">x</p>']) assert.throws(()=>inspect(sample.replace('</main>',code+'</main>')));
  assert.throws(()=>inspect(sample.replace('class="lead"','class="lead" onclick="alert(1)"')));
  const e=inspect(sample).elements.find(e=>e.tag==='section');
  for (const html of [e.html+'</main>',e.html+'<p>越界</p>',e.html.replace('</section>','<style>body{display:none}</style></section>')]) assert.throws(()=>validateReplacement(html,e));
});
test('预览注入临时节点，保存源文无注入；支持内嵌栅格图与静态按钮', () => {
  const source='<html><body><button>提交</button><img alt="示例" src="data:image/png;base64,aGVsbG8="></body></html>';
  const doc=inspect(source); assert.equal(doc.elements.length,2);
  const preview=buildPreview(source,'testnonce','/* trusted */');
  assert.match(preview,/data-folio-node/); assert.match(preview,/script-src 'nonce-testnonce'/); assert.match(preview,/img-src data:/);
  assert.equal(doc.source,source); assert.equal(doc.source.includes('data-folio-node'),false);
});
test('保存并发检测、备份、重开、恢复与外部改动保护',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'folio-store-test-'));
  try {
    const store=new DocumentStore(dir); await store.init(sample); const [{id}]=await store.list(); const doc=await store.get(id);
    const changed=sample.replace('好的想法','新的想法');
    const results=await Promise.allSettled([store.save(id,doc.version,changed),store.save(id,doc.version,sample.replace('好的想法','另一个想法'))]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1); assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
    const reopened=await new DocumentStore(dir).get(id); assert.equal(reopened.source,changed);
    const versions=await store.versions(id); assert.equal(versions.length,1); assert.equal((await store.restore(id,versions[0].id)).source,sample); assert.equal((await store.get(id)).source,changed);
    await writeFile(path.join(dir,'documents',id+'.html'),sample.replace('好的想法','外部修改'));
    await assert.rejects(store.save(id,reopened.version,changed),{status:409}); await assert.rejects(store.get('../../secret'),{status:404}); await assert.rejects(store.restore(id,'../secret'),{status:404});
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('本地链接原样保留，预览不导航，危险协议仍拒绝', () => {
  for (const href of ['./页面.html', '../notes/a.md', '/Users/example/a.html', 'file:///Users/example/a.html', 'C:\\docs\\a.html', '#标题', 'mailto:user@example.com']) {
    const source = `<html><body><a href="${href}" target="_blank" download>本地资料</a></body></html>`;
    const doc = inspect(source); assert.equal(doc.source, source);
    const preview = buildPreview(source, 'test', ''); assert.doesNotMatch(preview, /href=|target=|download/);
    const target = doc.elements[0];
    assert.match(replaceElements(source, [patch(target, target.html.replace('本地资料', '资料链接'))]).source, /href=/);
  }
  for (const href of ['javascript:alert(1)', 'java&#10;script:alert(1)', 'data:text/html,bad', 'vbscript:bad']) assert.throws(() => inspect(`<a href="${href}">链接</a>`));
});
