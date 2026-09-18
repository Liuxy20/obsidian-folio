import http from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffWordsWithSpace } from 'diff';
import { DocumentStore, inspect, replaceElements, validateReplacement, buildPreview, UserError } from './documents.js';
import { codexStatus, generateWithCodex } from './codex.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const maxBody = 1_000_000;
export async function createApp({ dataDir = path.join(root, '.folio'), generate = generateWithCodex, status = codexStatus } = {}) {
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const identity = { app: 'folio', version, workspace: createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0, 24) };
  const store = new DocumentStore(dataDir);
  await store.init(await readFile(path.join(root, 'examples/weekly-review.html'), 'utf8'));
  const bridge = await readFile(path.join(root, 'public/frame.js'), 'utf8');
  const token = randomBytes(32).toString('hex'); const previewNonce = randomBytes(24).toString('hex'); const jobs = new Map();
  const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const body = async req => {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new UserError('请求必须使用 JSON。', 415);
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > maxBody) throw new UserError('请求内容过大。', 413); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new UserError('JSON 格式错误。'); }
  };
  const server = http.createServer(async (req, res) => {
    try {
      const port = server.address()?.port;
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) throw new UserError('只允许本机访问。', 403);
      const origin = `http://${req.headers.host}`;
      if (req.headers.origin && req.headers.origin !== origin) throw new UserError('请求来源不被允许。', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new UserError('不允许跨站访问。', 403);
      res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'nonce-${previewNonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self' about:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
      const url = new URL(req.url, origin); const route = url.pathname;
      if (route === '/api/health' && req.method === 'GET') return send(res, 200, identity);
      if (route === '/api/bootstrap' && req.method === 'GET') return send(res, 200, { token, app: identity, status: await status() });
      if (route.startsWith('/api/')) {
        if (req.headers['x-folio-token'] !== token) throw new UserError('访问凭证失效，请刷新页面。', 403);
        if (route === '/api/documents' && req.method === 'GET') return send(res, 200, await store.list());
        if (route === '/api/documents/import' && req.method === 'POST') { const b = await body(req); return send(res, 200, await store.import(b.name, b.source)); }
        const doc = route.match(/^\/api\/documents\/([a-f0-9-]+)(?:\/(save|versions|restore))?$/);
        if (doc) {
          const [, id, operation] = doc;
          if (!operation && req.method === 'GET') return send(res, 200, await store.get(id));
          if (operation === 'save' && req.method === 'POST') { const b = await body(req); return send(res, 200, await store.save(id, b.version, b.source)); }
          if (operation === 'versions' && req.method === 'GET') return send(res, 200, await store.versions(id));
          if (operation === 'restore' && req.method === 'POST') return send(res, 200, await store.restore(id, (await body(req)).backup));
        }
        if (route === '/api/draft/inspect' && req.method === 'POST') return send(res, 200, inspect((await body(req)).source));
        if (route === '/api/draft/replace' && req.method === 'POST') { const b = await body(req); return send(res, 200, replaceElements(b.source, b.changes, b.version)); }
        if (route === '/api/preview' && req.method === 'POST') {
          const b = await body(req); const channel = randomBytes(16).toString('hex');
          const script = `const FOLIO_CHANNEL=${JSON.stringify(channel)};\n${bridge}`;
          return send(res, 200, { channel, html: buildPreview(b.source, previewNonce, script) });
        }
        if (route === '/api/proposals' && req.method === 'POST') {
          if ([...jobs.values()].some(j => j.state === 'running')) throw new UserError('已有一项生成正在进行，请等待或停止。', 409);
          const b = await body(req); const snapshot = inspect(b.source);
          if (!Array.isArray(b.annotations) || !b.annotations.length || b.annotations.length > 12) throw new UserError('每批支持 1–12 条留言。');
          const annotations = b.annotations.map(note => {
            if (note.version !== snapshot.version) throw new UserError('留言对应的页面已变动，请重新点击定位。', 409);
            const original = snapshot.elements.find(e => e.id === note.targetId);
            if (!original || original.html !== note.expected) throw new UserError('留言元素已变化，请重新点击定位。', 409);
            if (typeof note.comment !== 'string' || !note.comment.trim() || note.comment.length > 2000) throw new UserError('请输入 1–2000 字的留言。');
            const context = typeof note.context === 'string' ? note.context.slice(0, 5000) : '';
            return { original, comment: note.comment, noteId: String(note.id).slice(0, 100), context };
          });
          // Validate overlap before making any paid model calls.
          replaceElements(b.source, annotations.map(a => ({ targetId: a.original.id, expected: a.original.html, html: a.original.html })), snapshot.version);
          const id = randomUUID(); const controller = new AbortController();
          const job = { id, state: 'running', message: '正在连接本地 Codex…', version: snapshot.version, changes: [], controller };
          if (jobs.size >= 20) jobs.delete(jobs.keys().next().value);
          jobs.set(id, job);
          Promise.resolve().then(async () => {
            const changes = [];
            for (let i = 0; i < annotations.length; i++) {
              if (job.state !== 'running') return;
              const a = annotations[i];
              const prefix = `正在处理留言 ${i + 1}/${annotations.length}`;
              job.message = prefix;
              const result = await generate({ block: a.original, instruction: a.comment, context: a.context, preserveNumbers: b.preserveNumbers !== false, signal: controller.signal, onProgress: () => { if (job.state === 'running') job.message = prefix + ' · Codex 修改中…'; } });
              if (job.state !== 'running') return;
              const html = validateReplacement(result.html, a.original, b.preserveNumbers !== false);
              changes.push({ targetId: a.original.id, noteId: a.noteId, expected: a.original.html, html, label: a.original.label, summary: String(result.summary || '已按留言修改。').slice(0, 400), diff: diffWordsWithSpace(a.original.html, html).map(({ value, added, removed }) => ({ value, added: !!added, removed: !!removed })) });
            }
            replaceElements(b.source, changes, snapshot.version);
            Object.assign(job, { state: 'done', changes, summary: `已处理 ${changes.length} 条留言，请查看效果。` });
          }).catch(error => { if (job.state === 'running') Object.assign(job, { state: 'error', message: error instanceof UserError ? error.message : '执行失败，原文未被修改。' }); });
          return send(res, 202, { id });
        }
        const proposal = route.match(/^\/api\/proposals\/([a-f0-9-]+)(?:\/(cancel))?$/);
        if (proposal) {
          const job = jobs.get(proposal[1]); if (!job) throw new UserError('建议已失效，请重新生成。', 404);
          if (proposal[2] === 'cancel' && req.method === 'POST') { await body(req); job.state = 'cancelled'; job.controller.abort(); }
          else if (req.method !== 'GET') throw new UserError('不支持的请求。', 405);
          const { controller, ...safe } = job; return send(res, 200, safe);
        }
        throw new UserError('接口不存在。', 404);
      }
      if (req.method !== 'GET') throw new UserError('不支持的请求。', 405);
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/recovery.js': ['recovery.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (!files[route]) throw new UserError('页面不存在。', 404);
      const [file, mime] = files[route]; res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Cache-Control': 'no-store' }); res.end(await readFile(path.join(root, 'public', file)));
    } catch (e) {
      if (!res.headersSent) send(res, e instanceof UserError ? e.status : 500, { error: e instanceof UserError ? e.message : '本地服务遇到错误，当前文件未被覆盖。' });
      else res.end();
    }
  });
  server.on('close', () => { for (const j of jobs.values()) j.controller.abort(); });
  return { server, store, jobs };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server } = await createApp({ dataDir: process.env.FOLIO_DATA_DIR || path.join(root, '.folio') });
  const port = Number(process.env.PORT || 4317);
  server.listen(port, '127.0.0.1', () => console.log(`页间 Folio · http://127.0.0.1:${server.address().port}`));
  server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? '端口已占用，可使用 PORT=4318 npm start。' : '服务启动失败。'); process.exitCode = 1; });
  const stop = () => server.close(() => process.exit()); process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
