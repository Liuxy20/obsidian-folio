import test from 'node:test';
import assert from 'node:assert/strict';
import { VaultStore, PluginState } from '../obsidian/vault-store.js';
import { WorkspaceService } from '../obsidian/service.js';
import { inspect, hash, createStaticHTML } from '../server/documents.js';

const sample = '<!doctype html><html><head><title>测试</title></head><body><h1>原文</h1><p>保留此处</p></body></html>';
function fixture() {
  const files = new Map(), bodies = new Map(), writes = [];
  const adapter = { mkdir: async () => {}, exists: async p => bodies.has(p) || [...bodies.keys()].some(n => n.startsWith(p + '/')), read: async p => { if (!bodies.has(p)) throw new Error('missing'); return bodies.get(p); }, write: async (p, s) => { bodies.set(p, s); writes.push(p); }, list: async dir => ({ files: [...bodies.keys()].filter(p => p.startsWith(dir + '/')), folders: [] }) };
  const vault = {
    adapter, getFiles: () => [...files.values()].filter(f => f.extension), getAbstractFileByPath: p => files.get(p),
    createFolder: async p => files.set(p, { path: p }),
    create: async (p, s) => { assert.ok(!files.has(p)); const f = { path: p, name: p.split('/').pop(), extension: p.split('.').pop() }; files.set(p, f); bodies.set(p, s); return f; },
    read: async f => adapter.read(f.path),
    process: async (f, fn) => { const content = fn(await adapter.read(f.path)); await adapter.write(f.path, content); return content; }
  };
  return { vault, bodies, writes, store: new VaultStore(vault, '.obsidian/plugins/folio') };
}
test('Obsidian 文件读写：直接库内保存、备份、并发冲突、导入不覆盖、路径限制', async () => {
  const { vault, store, bodies } = fixture(); await vault.create('资料/中文 页面.html', sample); await vault.create('笔记.md', '# 私人笔记');
  const list = await store.list(); assert.equal(list.length, 1);
  const doc = await store.get(list[0].id), next = sample.replace('原文', '修改');
  await store.save(doc.id, doc.version, next); assert.equal(bodies.get('资料/中文 页面.html'), next);
  const [backup] = await store.versions(doc.id); assert.equal((await store.restore(doc.id, backup.id)).source, sample);
  await assert.rejects(store.save(doc.id, doc.version, sample), /其他操作修改/);
  const latest = await store.get(doc.id);
  vault.process = async (f, fn) => { bodies.set(f.path, '外部修改'); fn('外部修改'); };
  await assert.rejects(store.save(doc.id, latest.version, sample), /外部修改/); assert.equal(bodies.get('资料/中文 页面.html'), '外部修改');
  const one = await store.import('x.html', sample), two = await store.import('x.html', sample); assert.notEqual(one.id, two.id);
  for (const p of ['../secret.html', '/secret.html', '.obsidian/secret.html', '笔记.md']) assert.throws(() => store.file(Buffer.from(p).toString('base64url')));
  await assert.rejects(store.import('bad.html', '<script>bad()</script>'));
});
test('Obsidian 草稿：跨实例恢复、条件删除与失败写入不确认', async () => {
  const { vault } = fixture(); const dir = '.obsidian/plugins/folio';
  const state = new PluginState(vault.adapter, dir); await state.init();
  const record = { key: 'window-a', revision: 'new', documentId: 'doc', source: sample, updatedAt: 1 };
  await Promise.all([state.request('recovery/put', record), state.request('storage/set', { key: 'folio.notes.doc', value: '留言' })]);
  await state.request('recovery/remove', [{ key: 'window-a', revision: 'old' }]);
  const reopened = new PluginState(vault.adapter, dir); await reopened.init();
  assert.equal((await reopened.request('recovery/list', { documentId: 'doc' })).length, 1);
  assert.equal((await reopened.request('storage/get'))['folio.notes.doc'], '留言');
  const write = vault.adapter.write; vault.adapter.write = async () => { throw new Error('disk full'); };
  await assert.rejects(state.request('recovery/put', { ...record, key: 'window-b' }));
  assert.equal((await state.request('recovery/list', { documentId: 'doc' })).length, 1);
  vault.adapter.write = write;
  await state.request('recovery/remove', [{ key: 'window-a', revision: 'new' }]); assert.deepEqual(await state.request('recovery/list', { documentId: 'doc' }), []);
});
test('插件服务：预览隔离、重叠预检、修改只生成建议、关闭后取消', async () => {
  const { vault, store } = fixture(); const doc = await store.import('test.html', sample);
  const state = new PluginState(vault.adapter, '.obsidian/plugins/folio'); await state.init();
  let calls = 0, stopped = false;
  const service = new WorkspaceService({ store, state, bridge: '', version: '0.2.0', status: async () => ({ available: true }), generate: async ({ block, signal }) => { calls++; signal.addEventListener('abort', () => { stopped = true; }); return { html: block.html.replace('原文', '新文'), summary: '测试' }; } });
  const preview = await service.request('preview', { source: sample }); assert.match(preview.html, /connect-src 'none'/);
  const h1 = inspect(sample).elements.find(e => e.tag === 'h1');
  const note = { id: 'n', targetId: h1.id, expected: h1.html, version: hash(sample), comment: '换文字' };
  await assert.rejects(service.request('proposals', { source: sample, annotations: [note, note] })); assert.equal(calls, 0);
  const { id } = await service.request('proposals', { source: sample, annotations: [note] });
  await new Promise(r => setImmediate(r));
  const result = await service.request('proposals/' + id); assert.equal(result.state, 'done'); assert.match(result.changes[0].html, /新文/);
  assert.equal((await store.get(doc.id)).source, sample);
  service.close(); assert.equal(stopped, true); await assert.rejects(service.request('documents'), /已关闭/);
});
test('网页缓存分类与静态副本：移除主动内容、原文件不变、副本可编辑保存', async () => {
  const webpage = '<!doctype html><html><head><title>缓存</title><link rel="stylesheet" href="https://example.com/a.css"><style>h1{color:green}</style><script>window.pwned=1</script></head><body onload="evil()"><h1>网页标题</h1><form action="https://example.com"><p>正文</p><input></form><svg><script>evil()</script></svg><iframe srcdoc="bad"></iframe><img src="https://example.com/x.png" alt="插图"></body></html>';
  const converted = createStaticHTML(webpage);
  assert.doesNotMatch(converted.source, /<script|<svg|<iframe|<link|<form|onload=|https:\/\//);
  assert.match(converted.source, /网页标题/); assert.match(converted.source, /h1\{color:green\}/); assert.match(converted.source, /图片：插图/);
  assert.throws(() => createStaticHTML('<script>document.body.innerHTML="dynamic"</script>'), /没有可转换的静态正文/);
  const { vault, store, bodies } = fixture(); await vault.create('缓存/网页.html', webpage.replace('<img src="https://example.com/x.png" alt="插图">', '')); await vault.create('测试.html', sample);
  const list = await store.list(); assert.equal(list[0].supported, true); assert.equal(list[1].supported, false); assert.match(list[1].reason, /script|link/);
  const copy = await store.staticCopy(list[1].id); assert.match(copy.name, /静态副本/);
  assert.equal(bodies.get('缓存/网页.html'), webpage.replace('<img src="https://example.com/x.png" alt="插图">', ''));
  await store.save(copy.id, copy.version, copy.source.replace('网页标题', '改后标题'));
  assert.match((await store.get(copy.id)).source, /改后标题/); assert.equal(bodies.get('缓存/网页.html'), webpage.replace('<img src="https://example.com/x.png" alt="插图">', ''));
});
