import { parse, parseFragment, serialize, defaultTreeAdapter } from 'parse5';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, rename, lstat, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

export class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const MAX_IMPORT_BYTES = 25_000_000;
export const MAX_DOCUMENT_BYTES = 5_000_000;
export const hash = text => createHash('sha256').update(text).digest('hex');
export const escapeHTML = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const allowedTags = new Set('html head body title meta style main header footer nav section article aside div span p h1 h2 h3 h4 h5 h6 strong b em i u s small mark code pre blockquote ul ol li table thead tbody tfoot tr td th caption colgroup col hr br a sup sub time figure figcaption button img'.split(' '));
const voidTags = new Set(['img', 'br', 'hr', 'col']);
const hiddenTags = new Set(['html', 'head', 'body', 'title', 'meta', 'style']);
export const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value;
export const isDataImage = value => /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/.test(value);
export function isImageReference(value) {
  if (!value || /[\x00-\x1f\x7f]/.test(value)) return false;
  return isDataImage(value) || /^(https?:|file:)/i.test(value) || /^[a-z]:[\\/]/i.test(value) || !/^[a-z][a-z\d+.-]*:/i.test(value);
}
export function walk(node, fn) { fn(node); for (const child of node.childNodes ?? []) walk(child, fn); }
export function textOf(node) { return node.nodeName === '#text' ? node.value : (node.childNodes ?? []).map(textOf).join(''); }
function isDocumentLink(value) {
  const link = value.trim();
  if (/[\x00-\x1f\x7f]/.test(link)) return false;
  if (/^[a-z]:[\\/]/i.test(link)) return true;
  if (!/^[a-z][a-z\d+.-]*:/i.test(link)) return true;
  return /^(https?:|file:|mailto:|tel:|obsidian:)/i.test(link);
}

function validateTree(tree) {
  walk(tree, node => {
    if (!node.tagName) return;
    if (!allowedTags.has(node.tagName)) throw new UserError(`暂不支持 <${node.tagName}>。请使用不含脚本、表单或嵌入内容的静态 HTML。`);
    for (const a of node.attrs) {
      if (/^on/i.test(a.name) || ['srcdoc', 'action', 'formaction', 'nonce', 'contenteditable', 'data-folio-node', 'data-folio-selected', 'data-folio-ui'].includes(a.name)) throw new UserError(`文档含不支持的属性：${a.name}`);
      if (a.name === 'src' && !(node.tagName === 'img' && isImageReference(a.value))) throw new UserError('图片地址不受支持，请使用本地路径、HTTP(S) 或内嵌 PNG/JPEG/GIF/WebP。');
      if (['srcset', 'ping', 'background'].includes(a.name)) throw new UserError('暂不支持外部资源属性。');
      if (a.name === 'href' && !isDocumentLink(a.value)) throw new UserError('文档含有不支持的链接协议或控制字符。');
      if (a.name === 'style' && /url\s*\(|@import|expression\s*\(|\\/i.test(a.value)) throw new UserError('不支持加载外部资源的样式。');
    }
    if (node.tagName === 'meta' && (attr(node, 'http-equiv') || attr(node, 'name') && attr(node, 'name') !== 'viewport')) throw new UserError('不支持此 meta 设置。');
    if (node.tagName === 'style' && /url\s*\(|@import|expression\s*\(|\\/i.test(textOf(node))) throw new UserError('不支持加载外部资源的 CSS。');
  });
}

// IDs are structural paths in this exact snapshot, never persistent document markup.
function collect(tree, source) {
  const elements = []; let bytes = 0;
  const visit = (node, indices = [], inBody = false, parentId = null) => {
    const body = inBody || node.tagName === 'body';
    let ownId = parentId;
    if (body && node.tagName && !hiddenTags.has(node.tagName) && node.sourceCodeLocation?.startTag) {
      const loc = node.sourceCodeLocation;
      const html = source.slice(loc.startOffset, loc.endOffset);
      if (indices.length > 64 || elements.length >= 2000 || (bytes += html.length) > 32_000_000) throw new UserError('文档结构过于复杂，请缩小 HTML 范围后导入。', 413);
      ownId = 'el-' + indices.join('-');
      elements.push({ id: ownId, parentId, parentTag: node.parentNode?.tagName || 'body', tag: node.tagName, start: loc.startOffset, end: loc.endOffset, html, text: textOf(node).trim(), label: (textOf(node).trim() || attr(node, 'alt') || node.tagName).slice(0, 70) });
    }
    let index = 0;
    for (const child of node.childNodes ?? []) if (child.tagName) visit(child, node.tagName === 'body' ? [index++] : [...indices, index++], body, ownId);
  };
  visit(tree);
  return elements;
}
export function inspect(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_DOCUMENT_BYTES) throw new UserError('可编辑 HTML 正文不能超过 5 MB；含内嵌图片的文件请通过“导入 HTML 文件”提取附件。', 413);
  const tree = parse(source, { sourceCodeLocationInfo: true }); validateTree(tree);
  let title = '未命名文档'; walk(tree, node => { if (node.tagName === 'title') title = textOf(node).trim() || title; });
  const elements = collect(tree, source);
  return { title, source, version: hash(source), elements };
}

// An explicit conversion makes a new editable document; never used when saving
// an existing file or validating model output.
export function createStaticHTML(source, { preserveImages = false } = {}) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_IMPORT_BYTES) throw new UserError('导入的 HTML 不能超过 25 MB。', 413);
  const tree = parse(source);
  const removed = new Set();
  const drop = new Set(['script', 'noscript', 'template', 'link', 'iframe', 'object', 'embed', 'svg', 'canvas', 'audio', 'video', 'source', 'input']);
  const clean = parent => {
    parent.childNodes = (parent.childNodes || []).flatMap(node => {
      if (!node.tagName) return node.nodeName === '#comment' ? [] : [node];
      if (drop.has(node.tagName)) { removed.add(node.tagName); return []; }
      if (node.tagName === 'meta' && (attr(node, 'http-equiv') || attr(node, 'name') && attr(node, 'name') !== 'viewport')) { removed.add('meta'); return []; }
      if (node.tagName === 'style') {
        try { validateTree(node); } catch { removed.add('含外部资源的样式'); return []; }
      }
      clean(node);
      if (!allowedTags.has(node.tagName)) { removed.add(node.tagName + ' 外层'); for (const child of node.childNodes) child.parentNode = parent; return node.childNodes; }
      node.attrs = node.attrs.filter(a => {
        if (!preserveImages && node.tagName === 'img' && a.name === 'src' && !isDataImage(a.value)) return false;
        try { validateTree({ ...node, attrs: [a], childNodes: [] }); return true; }
        catch { removed.add(a.name + ' 属性'); return false; }
      });
      if (node.tagName === 'img' && !attr(node, 'src')) {
        const alt = attr(node, 'alt'); removed.add('外部图片');
        if (!alt) return [];
        const text = defaultTreeAdapter.createElement('span', 'http://www.w3.org/1999/xhtml', []);
        defaultTreeAdapter.insertText(text, `[图片：${alt}]`); text.parentNode = parent; return [text];
      }
      return [node];
    });
  };
  clean(tree);
  const result = inspect(serialize(tree));
  if (!result.elements.some(e => e.text)) throw new UserError('此网页主要由脚本生成，没有可转换的静态正文。');
  return { ...result, removed: [...removed] };
}
export function validateReplacement(html, original, preserveNumbers = false) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 120_000) throw new UserError('元素内容过大或格式错误。');
  const context = defaultTreeAdapter.createElement(original.parentTag || 'body', 'http://www.w3.org/1999/xhtml', []);
  const tree = parseFragment(context, html, { sourceCodeLocationInfo: true }); validateTree(tree);
  const originalImages = new Set();
  walk(parseFragment(original.html), node => { if (node.tagName === 'img') originalImages.add(attr(node, 'src')); });
  walk(tree, node => {
    if (node.tagName === 'img' && attr(node, 'src') && !originalImages.has(attr(node, 'src'))) throw new UserError('AI 不能新增未经导入的图片地址，请先导入包含原图的 HTML。');
  });
  const nodes = tree.childNodes.filter(n => n.nodeName !== '#text' || n.value.trim());
  if (html.trim()) {
    if (nodes.length !== 1 || nodes[0].tagName !== original.tag) throw new UserError('建议必须保留所选元素的外层标签；删除时返回空内容。');
    const loc = nodes[0].sourceCodeLocation;
    if (!loc || (!loc.endTag && !voidTags.has(original.tag)) || html.slice(0, loc.startOffset).trim() || html.slice(loc.endOffset).trim()) throw new UserError('建议含有不完整或多余的标签。');
    walk(nodes[0], node => { if (node.tagName === 'style') throw new UserError('局部修改不能加入影响整份文档的样式表。'); });
  }
  if (preserveNumbers) {
    const numbers = s => (s.match(/\d+(?:[.,]\d+)*(?:%|％)?/g) ?? []).sort().join('|');
    if (numbers(textOf(tree)) !== numbers(original.text)) throw new UserError('建议改变了数字，已拦截。请重新生成，或取消“保留数字”。', 422);
  }
  return html.trim();
}
export function replaceElements(source, changes, expectedVersion) {
  const before = inspect(source);
  if (expectedVersion && before.version !== expectedVersion) throw new UserError('页面已变动，这批建议对应旧版本。请重新定位留言并生成。', 409);
  if (!Array.isArray(changes) || !changes.length || changes.length > 12) throw new UserError('每批支持 1–12 条留言。');
  const targets = changes.map(change => {
    const target = before.elements.find(e => e.id === change.targetId);
    if (!target || target.html !== change.expected) throw new UserError('留言对应的元素已被修改或移动，请重新定位。', 409);
    return { ...target, replacement: change.html === target.html ? target.html : validateReplacement(change.html, target) };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < targets.length; i++) if (targets[i].start < targets[i - 1].end) throw new UserError('留言目标相互包含。请保留其中一条，或分两批修改。', 409);
  let next = source;
  for (const t of [...targets].reverse()) next = next.slice(0, t.start) + t.replacement + next.slice(t.end);
  const result = inspect(next);
  // Parse again: a replacement must not reparent source outside its intended range.
  for (const target of targets) {
    if (!target.replacement) continue;
    const delta = targets.filter(t => t.end <= target.start).reduce((n, t) => n + t.replacement.length - (t.end - t.start), 0);
    const node = result.elements.find(e => e.start === target.start + delta && e.html === target.replacement);
    if (!node || node.parentTag !== target.parentTag) throw new UserError('这次修改会破坏页面结构，请重新生成。', 422);
  }
  return result;
}
export function buildPreview(source, nonce, bridge, images = new Map()) {
  const doc = inspect(source);
  const byStart = new Map(doc.elements.map(e => [e.start, e.id]));
  const tree = parse(source, { sourceCodeLocationInfo: true });
  walk(tree, node => {
    const id = byStart.get(node.sourceCodeLocation?.startOffset);
    if (id && node.attrs) node.attrs.push({ name: 'data-folio-node', value: id });
    // References stay byte-for-byte in the source, but the preview never opens
    // local files, other apps, or websites (including keyboard/context-menu use).
    if (node.attrs) node.attrs = node.attrs.filter(a => !['href', 'target', 'download'].includes(a.name));
    if (node.tagName === 'img') {
      const src = node.attrs.find(a => a.name === 'src');
      if (src && !isDataImage(src.value)) {
        const data = images.get(src.value);
        if (data && isDataImage(data)) src.value = data;
        else { node.attrs = node.attrs.filter(a => a !== src); node.attrs.push({ name: 'title', value: '图片未加载，请检查原图路径后重新导入。' }); }
      }
    }
    if (node.childNodes) node.childNodes = node.childNodes.filter(c => c.tagName !== 'meta');
  });
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'`;
  const injection = `<meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1">`;
  return serialize(tree).replace('<head>', '<head>' + injection).replace('</body>', `<script nonce="${nonce}">${bridge}</script></body>`);
}

export class DocumentStore {
  constructor(root) { this.root = root; this.documents = path.join(root, 'documents'); this.history = path.join(root, 'history'); this.locks = new Map(); }
  async init(sample) { await mkdir(this.documents, { recursive: true }); await mkdir(this.history, { recursive: true }); if (!(await this.list()).length) await this.import('产品观察周报.html', sample); }
  async file(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new UserError('文件 ID 无效。', 404);
    const file = path.join(this.documents, id + '.html');
    let st; try { st = await lstat(file); } catch { throw new UserError('文件不存在。', 404); }
    if (!st.isFile() || st.isSymbolicLink()) throw new UserError('不支持符号链接文件。');
    if (path.dirname(await realpath(file)) !== await realpath(this.documents)) throw new UserError('文件超出工作区。');
    return file;
  }
  async list() {
    const files = await readdir(this.documents);
    const result = [];
    for (const f of files.filter(x => /^[a-f0-9-]{36}\.html$/.test(x))) {
      try { const id = f.slice(0, -5); const doc = await this.get(id); result.push({ id, title: doc.title, name: doc.name }); } catch { /* Invalid external files are not exposed. */ }
    }
    return result;
  }
  async import(name, source) {
    const doc = inspect(source); const id = randomUUID();
    const safeName = path.basename(String(name)).replace(/[\x00-\x1f]/g, '').slice(0, 100) || 'report.html';
    await writeFile(path.join(this.documents, id + '.html'), source, { mode: 0o600, flag: 'wx' });
    await writeFile(path.join(this.documents, id + '.json'), JSON.stringify({ name: safeName }), { mode: 0o600 });
    return { ...doc, id, name: safeName };
  }
  async get(id) {
    const source = await readFile(await this.file(id), 'utf8');
    let name = 'report.html'; try { name = JSON.parse(await readFile(path.join(this.documents, id + '.json'), 'utf8')).name; } catch {}
    return { ...inspect(source), id, name };
  }
  async save(id, version, source) {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const doc = inspect(source); const file = await this.file(id);
      const current = await readFile(file, 'utf8');
      if (hash(current) !== version) throw new UserError('磁盘文件已被其他窗口或程序修改。请导出当前草稿，再重新打开文件。', 409);
      if (current === source) return this.get(id);
      const dir = path.join(this.history, id); await mkdir(dir, { recursive: true });
      const backup = `${Date.now()}-${randomUUID()}.html`;
      await writeFile(path.join(dir, backup), current, { mode: 0o600, flag: 'wx' });
      const tmp = file + '.' + randomUUID() + '.tmp';
      await writeFile(tmp, source, { mode: 0o600, flag: 'wx' });
      try {
        if (hash(await readFile(file, 'utf8')) !== version) throw new UserError('保存期间检测到外部修改，未覆盖文件。', 409);
        await rename(tmp, file);
      } finally { await unlink(tmp).catch(() => {}); }
      return { ...await this.get(id), version: doc.version };
    });
    this.locks.set(id, task);
    try { return await task; } finally { if (this.locks.get(id) === task) this.locks.delete(id); }
  }
  async versions(id) {
    await this.file(id);
    let names = []; try { names = await readdir(path.join(this.history, id)); } catch {}
    return names.filter(n => /^\d+-[a-f0-9-]+\.html$/.test(n)).sort().reverse().slice(0, 30).map(name => ({ id: name, date: Number(name.split('-')[0]) }));
  }
  async restore(id, backup) {
    if (!(await this.versions(id)).some(v => v.id === backup)) throw new UserError('历史版本不存在。', 404);
    return inspect(await readFile(path.join(this.history, id, backup), 'utf8'));
  }
}
