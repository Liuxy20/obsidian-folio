import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import { parse } from 'parse5';
import { walk, attr, hash, escapeHTML, isDataImage, isImageReference, UserError, MAX_IMPORT_BYTES } from '../server/documents.js';

const MAX_IMAGE = 8_000_000, MAX_TOTAL = 32_000_000, MAX_COUNT = 32;
export function imageNodes(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_IMPORT_BYTES) throw new UserError('导入的 HTML 不能超过 25 MB。', 413);
  const nodes = [];
  walk(parse(source, { sourceCodeLocationInfo: true }), node => {
    if (node.tagName === 'img' && attr(node, 'src') && !isDataImage(attr(node, 'src'))) nodes.push(node);
  });
  return nodes;
}
// Normalize before inspect/collect: base64 repeated in ancestors and full-size
// links must never become editable element payloads or model context.
export function extractEmbeddedImages(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_IMPORT_BYTES) throw new UserError('导入的 HTML 不能超过 25 MB。', 413);
  const provided = new Map(), edits = []; let total = 0;
  walk(parse(source, { sourceCodeLocationInfo: true }), node => {
    const name = node.tagName === 'img' ? 'src' : node.tagName === 'a' ? 'href' : null;
    const value = name && attr(node, name);
    if (!value || !isDataImage(value)) return;
    const bytes = Buffer.from(value.slice(value.indexOf(',') + 1), 'base64');
    if (bytes.length > MAX_IMAGE) throw new UserError('单张内嵌图片不能超过 8 MB。', 413);
    const type = rasterType(bytes), file = `${hash(bytes)}.${type}`, reference = `attachments/${file}`;
    if (!provided.has(reference)) {
      total += bytes.length;
      if (provided.size >= MAX_COUNT || total > MAX_TOTAL) throw new UserError('内嵌图片最多 32 张，总大小不能超过 32 MB。', 413);
      provided.set(reference, { bytes, type, name: file, data: `data:image/${type};base64,${bytes.toString('base64')}` });
    }
    const loc = node.sourceCodeLocation?.attrs?.[name];
    if (!loc) throw new UserError('无法定位内嵌图片。');
    edits.push({ ...loc, value: `${name}="${reference}"` });
  });
  for (const edit of edits.sort((a,b) => b.startOffset - a.startOffset)) source = source.slice(0, edit.startOffset) + edit.value + source.slice(edit.endOffset);
  return { source, provided };
}
export function rasterType(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii', 12, 16) === 'IHDR') return 'png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (bytes.length >= 13 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'gif';
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  throw new UserError('不是支持的 PNG、JPEG、GIF 或 WebP 图片。');
}
function remoteBytes(address, signal, redirects = 0) {
  return new Promise((resolve, reject) => {
    const url = new URL(address);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { reject(new UserError('图片 URL 不允许携带登录凭据或使用非 HTTP(S) 协议。')); return; }
    const req = (url.protocol === 'https:' ? https : http).get(url, { signal, headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp' } }, res => {
      if ([301,302,303,307,308].includes(res.statusCode)) {
        res.resume();
        if (!res.headers.location || redirects >= 4) { reject(new UserError('图片重定向次数过多。')); return; }
        try { resolve(remoteBytes(new URL(res.headers.location, url), signal, redirects + 1)); } catch (error) { reject(error); } return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new UserError(`图片下载失败（HTTP ${res.statusCode}）。`)); return; }
      let size = 0; const chunks = [];
      res.on('error', reject);
      res.on('data', chunk => { size += chunk.length; if (size > MAX_IMAGE) req.destroy(new UserError('单张图片不能超过 8 MB。')); else chunks.push(chunk); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
  });
}
async function localBytes(file, root) {
  let handle;
  try {
    const resolved = await realpath(file);
    if (root) {
      const relative = path.relative(await realpath(root), resolved);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new UserError('图片位于笔记库之外，请通过“导入 HTML 文件”复制图片。');
    }
    handle = await open(resolved, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_IMAGE) throw new UserError('图片必须是小于 8 MB 的普通文件。');
    // Read at most the limit even if the file grows after stat.
    const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_IMAGE + 1));
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const chunk = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > MAX_IMAGE) throw new UserError('单张图片不能超过 8 MB。');
    return bytes.subarray(0, bytesRead);
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(`找不到或无法读取图片：${file}`);
  } finally { await handle?.close(); }
}
export async function loadImages(source, { sourcePath, root, allowed, cache = new Map(), provided = new Map(), strict = true } = {}) {
  const counts = new Map();
  for (const node of imageNodes(source)) { const ref = attr(node, 'src'); counts.set(ref, (counts.get(ref) || 0) + 1); }
  const references = [...counts.keys()];
  if (references.length > MAX_COUNT) throw new UserError('每份 HTML 最多引用 32 张不同图片。');
  const images = new Map(), warnings = []; let total = 0;
  const signal = AbortSignal.timeout(20_000);
  for (const reference of references) {
    try {
      if (allowed && !allowed.has(reference) && !provided.has(reference)) throw new UserError('新图片路径尚未导入，请从原文件重新导入。');
      if (!isImageReference(reference)) throw new UserError('不支持此图片协议。');
      let bytes = provided.get(reference)?.bytes || (/^https?:/i.test(reference) || reference.startsWith('//') ? cache.get(reference)?.bytes : undefined);
      if (!bytes) {
        if (/^https?:/i.test(reference) || reference.startsWith('//')) bytes = await remoteBytes(reference.startsWith('//') ? 'https:' + reference : reference, signal);
        else {
          if (!sourcePath) throw new UserError('无法确定图片所在目录，请点击“导入 HTML 文件”重新选择原文件。');
          const file = /^file:/i.test(reference) ? fileURLToPath(reference) : path.resolve(path.dirname(sourcePath), decodeURIComponent(reference.replace(/[?#].*$/, '')));
          bytes = await localBytes(file, root);
        }
      }
      const type = rasterType(bytes); total += bytes.length * counts.get(reference);
      if (total > MAX_TOTAL) throw new UserError('图片总大小不能超过 32 MB。');
      const item = { bytes, type, name: `${hash(bytes)}.${type}`, data: `data:image/${type};base64,${bytes.toString('base64')}` };
      images.set(reference, item);
    } catch (error) {
      const message = `${reference}：${error instanceof UserError ? error.message : '图片下载失败或超过 20 秒，请检查网址和网络。'}`;
      if (strict) throw new UserError(message);
      warnings.push(message);
    }
  }
  return { images, warnings };
}
export function rewriteImages(source, images) {
  const edits = imageNodes(source).map(node => {
    const image = images.get(attr(node, 'src')), loc = node.sourceCodeLocation?.attrs?.src;
    if (!image || !loc) throw new UserError('图片未成功导入。');
    return { ...loc, value: `src="${escapeHTML('attachments/' + image.name)}"` };
  }).sort((a,b) => b.startOffset - a.startOffset);
  for (const edit of edits) source = source.slice(0, edit.startOffset) + edit.value + source.slice(edit.endOffset);
  return source;
}
