import { randomBytes, randomUUID } from 'node:crypto';
import { diffWordsWithSpace } from 'diff';
import { inspect, replaceElements, validateReplacement, buildPreview, UserError } from '../server/documents.js';

export class WorkspaceService {
  constructor({ store, state, bridge, status, generate, version, nonce = randomBytes(16).toString('hex') }) { Object.assign(this, { store, state, bridge, status, generate, version, nonce }); this.jobs = new Map(); this.closed = false; }
  close() { this.closed = true; for (const job of this.jobs.values()) { job.state = 'cancelled'; job.controller.abort(); } }
  async request(route, b) {
    if (this.closed) throw new UserError('工作台已关闭。');
    if (typeof route !== 'string' || route.length > 4000) throw new UserError('无效操作。');
    if (route.startsWith('storage/') || route.startsWith('recovery/')) return this.state.request(route, b);
    if (route === 'bootstrap') return { app: { version: this.version }, status: await this.status() };
    if (route === 'documents') return this.store.list();
    if (route === 'documents/import') return this.store.import(b.name, b.source);
    if (route === 'documents/static-copy') return this.store.staticCopy(b.id);
    if (route === 'documents/import-static') return this.store.importStatic(b.name, b.source);
    const doc = route.match(/^documents\/([\w-]+)(?:\/(save|versions|restore))?$/);
    if (doc) {
      if (!doc[2]) return this.store.get(doc[1]);
      if (doc[2] === 'save') return this.store.save(doc[1], b.version, b.source);
      if (doc[2] === 'versions') return this.store.versions(doc[1]);
      if (doc[2] === 'restore') return this.store.restore(doc[1], b.backup);
    }
    if (route === 'draft/inspect') return inspect(b.source);
    if (route === 'draft/replace') return replaceElements(b.source, b.changes, b.version);
    if (route === 'preview') {
      inspect(b.source);
      const resources = await this.store.previewImages(this.activeId, b.source, this.imageCache);
      this.imageCache = resources.images;
      const channel = randomBytes(16).toString('hex'), nonce = this.nonce;
      return { channel, warnings: resources.warnings, html: buildPreview(b.source, nonce, `const FOLIO_CHANNEL=${JSON.stringify(channel)};\n${this.bridge}`, new Map([...resources.images].map(([key, value]) => [key, value.data]))) };
    }
    if (route === 'proposals') {
      if ([...this.jobs.values()].some(j => j.state === 'running')) throw new UserError('请等待或停止当前修改。');
      const snapshot = inspect(b.source);
      if (!Array.isArray(b.annotations) || !b.annotations.length || b.annotations.length > 12) throw new UserError('每批支持 1–12 条留言。');
      const annotations = b.annotations.map(note => {
        const original = snapshot.elements.find(e => e.id === note.targetId);
        if (note.version !== snapshot.version || !original || original.html !== note.expected) throw new UserError('页面已改变，请重新定位留言。');
        if (typeof note.comment !== 'string' || !note.comment.trim() || note.comment.length > 2000) throw new UserError('请输入 1–2000 字留言。');
        return { original, comment: note.comment, noteId: String(note.id).slice(0, 100), context: typeof note.context === 'string' ? note.context.slice(0, 5000) : '' };
      });
      replaceElements(b.source, annotations.map(a => ({ targetId: a.original.id, expected: a.original.html, html: a.original.html })), snapshot.version);
      const id = randomUUID(), controller = new AbortController();
      const job = { id, controller, state: 'running', message: '正在连接本机 Codex…', version: snapshot.version, changes: [] };
      if (this.jobs.size >= 20) this.jobs.delete(this.jobs.keys().next().value);
      this.jobs.set(id, job);
      Promise.resolve().then(async () => {
        const changes = [];
        for (let i = 0; i < annotations.length; i++) {
          if (job.state !== 'running') return;
          const a = annotations[i]; job.message = `正在处理留言 ${i + 1}/${annotations.length}`;
          const result = await this.generate({ block: a.original, instruction: a.comment, context: a.context, preserveNumbers: b.preserveNumbers !== false, signal: controller.signal });
          if (job.state !== 'running') return;
          const html = validateReplacement(result.html, a.original, b.preserveNumbers !== false);
          changes.push({ targetId: a.original.id, noteId: a.noteId, expected: a.original.html, html, label: a.original.label, summary: String(result.summary || '已修改。').slice(0, 400), diff: diffWordsWithSpace(a.original.html, html).map(({ value, added, removed }) => ({ value, added: !!added, removed: !!removed })) });
        }
        replaceElements(b.source, changes, snapshot.version);
        Object.assign(job, { state: 'done', changes, summary: `已处理 ${changes.length} 条留言，请查看效果。` });
      }).catch(error => { if (job.state === 'running') Object.assign(job, { state: 'error', message: error instanceof UserError ? error.message : '执行失败，原文未修改。' }); });
      return { id };
    }
    const jobRoute = route.match(/^proposals\/([\w-]+)(?:\/(cancel))?$/);
    if (jobRoute) {
      const job = this.jobs.get(jobRoute[1]); if (!job) throw new UserError('修改请求已失效。');
      if (jobRoute[2]) { job.state = 'cancelled'; job.controller.abort(); }
      const { controller, ...result } = job; return result;
    }
    throw new UserError('不支持此操作。');
  }
}
