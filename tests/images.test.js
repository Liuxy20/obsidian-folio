import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { loadImages, rewriteImages, rasterType, extractEmbeddedImages } from '../obsidian/images.js';
import { largePNG } from './image-fixtures.js';
import { inspect, buildPreview, validateReplacement, createStaticHTML } from '../server/documents.js';
import { VaultStore } from '../obsidian/vault-store.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const html = src => `<html><body><h1>图片测试</h1><img alt="原图" src="${src}"></body></html>`;
test('大 HTML：内嵌图与大图链接提取去重，正文 5 MB 与导入 25 MB 边界', async () => {
  const bytes=largePNG(), data='data:image/png;base64,'+bytes.toString('base64');
  const original=`<html><head><style>img{width:300px}</style></head><body><a href="${data}"><img src="${data}"></a><p>保留正文</p></body></html>`;
  assert.ok(Buffer.byteLength(original)>600_000);
  const result=extractEmbeddedImages(original);
  assert.equal(result.provided.size,1);assert.ok(result.source.length<400);
  assert.doesNotMatch(result.source,/data:image/);assert.match(result.source,/<a href="attachments\/[a-f0-9]+\.png"><img src="attachments\//);
  assert.match(result.source,/<style>img\{width:300px\}<\/style>/);inspect(result.source);
  assert.equal((await loadImages(result.source,{provided:result.provided})).images.size,1);
  assert.deepEqual([...result.provided.values()][0].bytes,bytes);
  const body='<html><body><p>'+'x'.repeat(4_900_000)+'</p></body></html>';assert.equal(inspect(body).source,body);
  assert.throws(()=>inspect('x'.repeat(5_000_001)),e=>e.status===413);
  assert.throws(()=>extractEmbeddedImages('x'.repeat(25_000_001)),e=>e.status===413);
  assert.throws(()=>extractEmbeddedImages(html('data:image/png;base64,'+Buffer.alloc(8_000_001).toString('base64'))),/8 MB/);
});
test('本地图片：相对、绝对、file URL；短路径重写、预览隔离、缺图与读取边界', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'folio-images-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'assets')); const image = path.join(root, 'assets', '中文 图.png'); await writeFile(image, png);
  const sourcePath = path.join(root, 'report.html');
  for (const ref of ['assets/中文%20图.png', image, pathToFileURL(image).href]) {
    const source = html(ref); inspect(source);
    const { images } = await loadImages(source, { sourcePath });
    const compact = rewriteImages(source, images);
    assert.match(compact, /src="attachments\/[a-f0-9]{64}\.png"/); assert.ok(compact.length < 250);
    assert.doesNotMatch(buildPreview(source, 'n', ''), /src="(?:assets|file:|https?:|\/)/);
    assert.match(buildPreview(source, 'n', '', new Map([...images].map(([k,v])=>[k,v.data]))), /src="data:image\/png;base64/);
  }
  await assert.rejects(loadImages(html('assets/missing.png'), { sourcePath }), /找不到.*missing.png/);
  await assert.rejects(loadImages(html(image), { sourcePath, root: path.join(root, 'assets', 'none') }), /无法读取/);
  await mkdir(path.join(root, 'vault'));
  await assert.rejects(loadImages(html(image), { sourcePath, root: path.join(root, 'vault') }), /笔记库之外/);
  const blocked = await loadImages(html(image), { sourcePath, allowed: new Set(), strict: false }); assert.equal(blocked.images.size, 0); assert.match(blocked.warnings[0], /尚未导入/);
  await writeFile(path.join(root, 'fake.png'), '<svg><script>bad()</script></svg>');
  await assert.rejects(loadImages(html('fake.png'), { sourcePath }), /不是支持/);
  assert.throws(()=>rasterType(Buffer.from('hello')), /不是支持/);
  const original = inspect(html('assets/a.png')).elements.find(e=>e.tag==='img');
  assert.throws(()=>validateReplacement('<img src="https://example.com/leak.png">',original), /未经导入/);
  assert.match(validateReplacement('<img src="assets/a.png" alt="新说明">',original), /新说明/);
  assert.match(createStaticHTML(html('assets/a.png')+'<script>bad()</script>',{preserveImages:true}).source, /assets\/a.png/);
});
test('网络图片：重定向、无认证头、错误/伪图/容量与数量上限', async t => {
  const server = http.createServer((req,res) => {
    assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.authorization, undefined);
    if (req.url === '/redirect') { res.writeHead(302,{Location:'/image'}); res.end(); }
    else if (req.url === '/image') res.end(png);
    else if (req.url === '/large') res.end(Buffer.alloc(8_000_001));
    else if (req.url === '/fake') res.end('<html>Login</html>');
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await loadImages(html(base+'/redirect'))).images.size,1);
  await assert.rejects(loadImages(html(base+'/missing')), /HTTP 404/);
  await assert.rejects(loadImages(html(base+'/fake')), /不是支持/);
  await assert.rejects(loadImages(html(base+'/large')), /8 MB/);
  await assert.rejects(loadImages(html(base.replace('http://','http://user:password@')+'/image')), /登录凭据/);
  await assert.rejects(loadImages('<html><body>'+Array.from({length:33},(_,i)=>`<img src="${base}/${i}">`).join('')+'</body></html>'), /32 张/);
});
test('Vault 导入与另存复制附件，保存与重新打开仍能显示；缺图不创建文档', async t => {
  const root = await mkdtemp(path.join(tmpdir(),'folio-vault-images-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const vaultRoot = path.join(root,'vault'); await mkdir(vaultRoot); await writeFile(path.join(root,'image.png'),png);
  const files = new Map();
  const adapter = { getBasePath:()=>vaultRoot, exists:async p=>{try{await readFile(path.join(vaultRoot,p));return true;}catch{return files.has(p);}}, mkdir:async p=>{await mkdir(path.join(vaultRoot,p),{recursive:true}); files.set(p,{path:p});} };
  const vault = { adapter, getAbstractFileByPath:p=>files.get(p), createFolder:adapter.mkdir,
    create:async(p,s)=>{await writeFile(path.join(vaultRoot,p),s);const f={path:p,name:path.basename(p),extension:'html'};files.set(p,f);return f;},
    createBinary:async(p,b)=>writeFile(path.join(vaultRoot,p),Buffer.from(b)), read:async f=>readFile(path.join(vaultRoot,f.path),'utf8') };
  const store = new VaultStore(vault,'.obsidian/plugins/folio');
  await assert.rejects(store.import('bad.html',html('missing.png'),{sourcePath:path.join(root,'test.html')}),/找不到/); assert.equal(files.size,0);
  const doc=await store.import('report.html',html('image.png'),{sourcePath:path.join(root,'test.html')});
  assert.ok(doc.source.length<250); assert.equal((await store.previewImages(doc.id,doc.source)).images.size,1);
  const exported=await store.export(doc.id,'copy.html',doc.source); assert.equal(exported.source,doc.source); assert.equal((await store.previewImages(exported.id,exported.source)).images.size,1);
  const copy=await store.staticCopy(doc.id); assert.equal((await store.previewImages(copy.id,copy.source)).images.size,1);
  const data='data:image/png;base64,'+largePNG().toString('base64');
  const embedded=`<html><body><h1>内嵌大图</h1><a href="${data}"><img src="${data}"></a></body></html>`;
  const large=await store.import('large.html',embedded); assert.ok(large.source.length<400); assert.equal((await store.previewImages(large.id,large.source)).images.size,1);
  const staticLarge=await store.importStatic('script-large.html',embedded.replace('</body>','<script>bad()</script></body>')); assert.equal((await store.previewImages(staticLarge.id,staticLarge.source)).images.size,1);
  assert.match((await store.export(large.id,'large-copy.html',large.source)).source,/<a href="attachments\//);
  assert.equal(await readFile(path.join(root,'image.png'),'base64'),png.toString('base64'));
});
