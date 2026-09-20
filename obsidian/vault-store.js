import { randomUUID } from 'node:crypto';
import { hash, inspect, createStaticHTML, UserError } from '../server/documents.js';
import path from 'node:path';
import { loadImages, rewriteImages, imageNodes, extractEmbeddedImages } from './images.js';
import { attr } from '../server/documents.js';

const isHTML = file => file && /^(html|htm)$/i.test(file.extension) && !file.path.split('/').some(p => p.startsWith('.'));
const fileId = file => Buffer.from(file.path).toString('base64url');
export class VaultStore {
  constructor(vault, directory) { this.vault = vault; this.directory = directory; this.locks = new Map(); this.compatibility = new Map(); }
  file(id) {
    if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) throw new UserError('无效文档标识。');
    const name = Buffer.from(id, 'base64url').toString();
    if (name.startsWith('/') || name.includes('\\') || name.split('/').some(p => !p || p === '..' || p.startsWith('.'))) throw new UserError('文件路径不受支持。');
    const file = this.vault.getAbstractFileByPath(name);
    if (!isHTML(file) || fileId(file) !== id) throw new UserError('HTML 已被移动或删除，请重新打开。', 404);
    return file;
  }
  async list() {
    const result = [];
    for (const f of this.vault.getFiles().filter(isHTML)) {
      const stamp = f.stat ? `${f.stat.mtime}:${f.stat.size}` : null;
      let cached = this.compatibility.get(f.path);
      if (!cached || !stamp || cached.stamp !== stamp) {
        try { inspect(await this.vault.read(f)); cached = { stamp, supported: true }; }
        catch (error) { cached = { stamp, supported: false, convertible: error instanceof UserError && error.status !== 413, reason: error instanceof UserError ? error.message : '文件暂时无法读取。' }; }
        this.compatibility.set(f.path, cached);
      }
      result.push({ id: fileId(f), name: f.name, title: f.path, supported: cached.supported, convertible: cached.convertible, reason: cached.reason, modified: f.stat?.mtime || 0 });
    }
    return result.sort((a,b) => Number(b.supported)-Number(a.supported) || b.modified-a.modified || a.title.localeCompare(b.title));
  }
  async staticCopy(id) {
    const original = this.file(id);
    return this.importStatic(original.name, await this.vault.read(original), this.imageOptions(id));
  }
  async importStatic(name, source, options) {
    const extracted = extractEmbeddedImages(source);
    const converted = createStaticHTML(extracted.source, { preserveImages: true });
    const copy = await this.import(String(name).replace(/\.html?$/i, '') + '-静态副本.html', converted.source, { ...options, provided: extracted.provided });
    return { ...copy, conversion: '已创建静态副本并复制图片，原文件未修改。脚本和外部样式不会运行，样式与交互可能不同。' };
  }
  imageOptions(id) {
    const root = this.vault.adapter.getBasePath?.();
    return { root, sourcePath: root ? path.join(root, this.file(id).path) : undefined };
  }
  async previewImages(id, source, cache) {
    if (!id) return { images: new Map(), warnings: [] };
    const original = await this.vault.read(this.file(id));
    const allowed = new Set(imageNodes(original).map(node => attr(node, 'src')));
    return loadImages(source, { ...this.imageOptions(id), allowed, cache, strict: false });
  }
  async export(id, name, source) {
    const original = await this.vault.read(this.file(id));
    return this.import(name, source, { ...this.imageOptions(id), allowed: new Set(imageNodes(original).map(node => attr(node, 'src'))) });
  }
  async get(id) { const f = this.file(id); return { ...inspect(await this.vault.read(f)), id, name: f.name }; }
  async import(name, source, options) {
    const extracted = extractEmbeddedImages(source);
    source = extracted.source;
    inspect(source);
    const provided = new Map([...(options?.provided || []), ...extracted.provided]);
    const loaded = await loadImages(source, { ...options, provided });
    const images = new Map([...provided, ...loaded.images]);
    if (new Set([...images.values()].map(i => i.name)).size > 32 || [...new Map([...images.values()].map(i => [i.name, i])).values()].reduce((n,i) => n + i.bytes.length, 0) > 32_000_000) throw new UserError('每份文档最多 32 张图片，总大小不能超过 32 MB。', 413);
    source = rewriteImages(source, images);
    inspect(source);
    const folder = 'Folio';
    if (!this.vault.getAbstractFileByPath(folder)) await this.vault.createFolder(folder);
    if (images.size) {
      const attachments = `${folder}/attachments`;
      if (!await this.vault.adapter.exists(attachments)) await this.vault.adapter.mkdir(attachments);
      for (const image of images.values()) {
        const target = `${attachments}/${image.name}`;
        if (!await this.vault.adapter.exists(target)) await this.vault.createBinary(target, image.bytes.buffer.slice(image.bytes.byteOffset, image.bytes.byteOffset + image.bytes.byteLength));
      }
    }
    const base = String(name).split(/[\\/]/).pop().replace(/[<>:"|?*\x00-\x1f]/g, '').replace(/^\.+/, '').replace(/\.(html?|HTML?)$/, '').slice(0, 80) || '文档';
    let namePath = `${folder}/${base}.html`;
    while (this.vault.getAbstractFileByPath(namePath)) namePath = `${folder}/${base}-${randomUUID().slice(0, 8)}.html`;
    const f = await this.vault.create(namePath, source); return this.get(fileId(f));
  }
  async save(id, version, source) {
    const previous = this.locks.get(id) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      inspect(source); const file = this.file(id), originalPath = file.path;
      const current = await this.vault.read(file);
      if (hash(current) !== version) throw new UserError('原文件已被其他操作修改。请导出草稿，再重新打开文件。', 409);
      if (current === source) return this.get(id);
      const directory = `${this.directory}/history/${hash(id)}`;
      await this.vault.adapter.mkdir(directory);
      await this.vault.adapter.write(`${directory}/${Date.now()}-${randomUUID()}.html`, current);
      await this.vault.process(file, latest => {
        if (file.path !== originalPath || hash(latest) !== version) throw new UserError('保存时检测到外部修改，未覆盖文件。', 409);
        return source;
      });
      return this.get(id);
    });
    this.locks.set(id, operation);
    try { return await operation; } finally { if (this.locks.get(id) === operation) this.locks.delete(id); }
  }
  async versions(id) {
    this.file(id); const dir = `${this.directory}/history/${hash(id)}`;
    if (!await this.vault.adapter.exists(dir)) return [];
    const { files } = await this.vault.adapter.list(dir);
    return files.map(f => f.split('/').pop()).filter(n => /^\d+-[a-f\d-]+\.html$/.test(n)).sort().reverse().slice(0, 30).map(id => ({ id, date: Number(id.split('-')[0]) }));
  }
  async restore(id, backup) {
    if (!(await this.versions(id)).some(v => v.id === backup)) throw new UserError('备份不存在。');
    return inspect(await this.vault.adapter.read(`${this.directory}/history/${hash(id)}/${backup}`));
  }
}

// Serialize durable state mutations. A failed write must not acknowledge a checkpoint.
export class PluginState {
  constructor(adapter, directory) { this.adapter = adapter; this.directory = directory; this.data = { local: {}, drafts: {} }; this.queue = Promise.resolve(); }
  async init() {
    await this.adapter.mkdir(this.directory);
    const file = `${this.directory}/state.json`;
    if (await this.adapter.exists(file)) {
      const parse = text => {const data=JSON.parse(text);if(!data||typeof data.local!=='object'||typeof data.drafts!=='object')throw new Error('页间草稿文件格式错误，请先备份插件 state.json。');return data;};
      try { this.data=parse(await this.adapter.read(file)); }
      catch(error){
        const previous=`${this.directory}/state.previous.json`;
        if(!await this.adapter.exists(previous))throw error;
        this.data=parse(await this.adapter.read(previous));this.recovered=true;
      }
    }
  }
  async mutate(fn) {
    const task = this.queue.catch(() => {}).then(async () => {
      const next = structuredClone(this.data); fn(next);
      const file = `${this.directory}/state.json`;
      // Obsidian's adapter.write owns its write behavior; retain the previous
      // complete snapshot separately so an interrupted write can be recovered.
      if (await this.adapter.exists(file)) await this.adapter.write(`${this.directory}/state.previous.json`, JSON.stringify(this.data));
      await this.adapter.write(file, JSON.stringify(next)); this.data = next;
    });
    this.queue = task; await task;
  }
  async request(route, value) {
    await this.queue.catch(() => {});
    if (route === 'storage/get') return structuredClone(this.data.local);
    if (route === 'storage/set') {
      if (typeof value?.key !== 'string' || !value.key.startsWith('folio.') || typeof value.value !== 'string' || value.value.length > 2_000_000) throw new UserError('留言存储格式不正确。');
      return this.mutate(data => { data.local[value.key] = value.value; });
    }
    if (route === 'recovery/list') return Object.values(this.data.drafts).filter(r => r.documentId === value.documentId).sort((a, b) => b.updatedAt - a.updatedAt);
    if (route === 'recovery/put') {
      if (typeof value?.key !== 'string' || typeof value.revision !== 'string' || typeof value.documentId !== 'string') throw new UserError('草稿格式错误。');
      inspect(value.source); return this.mutate(data => { data.drafts[value.key] = value; });
    }
    if (route === 'recovery/remove') return this.mutate(data => { for (const ref of value) if (data.drafts[ref.key]?.revision === ref.revision) delete data.drafts[ref.key]; });
    throw new UserError('未知存储请求。');
  }
}
