import { randomUUID } from 'node:crypto';
import { NoteStore } from './notes.js';
import { planNoteChanges } from './review.js';
import { hash, UserError } from '../server/documents.js';

export class ReviewStore extends NoteStore {
  async thread(path) {
    return this.locked(path, async () => {
      await this.recover(path);
      return super.thread(path);
    });
  }
  async recover(path) {
    await this.state.queue.catch(() => {});
    const pending = this.state.data.notes?.[path]?.pendingBatch;
    if (!pending) return;
    const current = hash(await this.vault.read(this.file(path)));
    if (current === pending.afterVersion) await this.finish(path, pending);
    else if (current === pending.beforeVersion) await this.state.mutate(data => { delete data.notes[path].pendingBatch; });
    else throw new UserError('上次保存中断后笔记又有变化。请先备份笔记与插件状态，再处理恢复冲突。', 409);
  }
  async finish(path, batch) {
    await this.state.mutate(data => {
      const thread = data.notes[path];
      if (thread.pendingBatch?.id !== batch.id) throw new UserError('保存状态已改变，请重新打开笔记。');
      const updates = new Map(batch.updates.map(r => [r.id, r]));
      thread.records = thread.records.map(r => updates.get(r.id) || r);
      if (batch.undo) delete thread.lastBatch;
      else thread.lastBatch = { id: batch.id, beforeVersion: batch.beforeVersion, afterVersion: batch.afterVersion, backup: batch.backup, ids: batch.updates.map(r => r.id) };
      delete thread.pendingBatch;
    });
  }
  async preview(records) {
    const path = records[0]?.capture.path;
    return this.locked(path,async()=>{this.file(path);await this.recover(path);return planNoteChanges(await this.vault.read(this.file(path)), records);});
  }
  async applyBatch(records, expectedVersion, checkEditor = () => {}) {
    const path = records[0]?.capture.path;
    return this.locked(path, async () => {
      await this.recover(path);
      const file = this.file(path), current = await this.vault.read(file);
      if (hash(current) !== expectedVersion) throw new UserError('预览后笔记已变化，请重新预览。', 409);
      checkEditor(current);
      const saved = this.state.data.notes?.[path]?.records || [];
      for (const record of records) {
        const latest = saved.find(r => r.id === record.id);
        if (!latest || JSON.stringify(latest) !== JSON.stringify(record)) throw new UserError('建议已更新，请重新选择和预览。', 409);
      }
      const plan = planNoteChanges(current, records), id = randomUUID();
      if (plan.next === current) throw new UserError('所选建议没有改变原文。');
      const dir = `${this.directory}/note-history/${hash(path)}`;
      await this.vault.adapter.mkdir(dir);
      const backup = `${dir}/${Date.now()}-${id}.md`;
      await this.vault.adapter.write(backup, current);
      const batch = { id, backup, beforeVersion: plan.version, afterVersion: hash(plan.next), updates: plan.changes.map(c => ({ ...c.record, state: 'applied', batchId: id, anchor: c.anchor, removed: !c.anchor, backup, appliedVersion: hash(plan.next) })) };
      await this.state.mutate(data => { data.notes[path].pendingBatch = batch; });
      await this.writeBatch(file,path,current,plan.next,batch,checkEditor);
      try { await this.finish(path, batch); }
      catch { throw new UserError('正文已写入，但保存状态待恢复。请重新打开笔记以恢复记录，再继续操作。'); }
      return batch.updates;
    });
  }
  async undoBatch(path, checkEditor = () => {}) {
    return this.locked(path, async () => {
      await this.recover(path);
      const last = this.state.data.notes?.[path]?.lastBatch;
      if (!last) throw new UserError('没有可撤销的批次。');
      const file = this.file(path), current = await this.vault.read(file);
      if (hash(current) !== last.afterVersion) throw new UserError('保存后笔记又有修改，不能直接撤销。', 409);
      checkEditor(current);
      const prefix = `${this.directory}/note-history/`;
      if (!last.backup.startsWith(prefix) || !/^[a-f0-9]+\/\d+-[\w-]+\.md$/.test(last.backup.slice(prefix.length))) throw new UserError('备份路径无效。');
      const original = await this.vault.adapter.read(last.backup);
      if (hash(original) !== last.beforeVersion) throw new UserError('备份校验失败，未改动笔记。');
      const batch = { id: randomUUID(), undo: true, beforeVersion: last.afterVersion, afterVersion: last.beforeVersion, updates: this.state.data.notes[path].records.filter(r => r.batchId === last.id).map(r => ({ ...r, state: 'undone', anchor: null, removed: false })) };
      await this.state.mutate(data => { data.notes[path].pendingBatch = batch; });
      await this.writeBatch(file,path,current,original,batch,checkEditor);
      try { await this.finish(path, batch); }
      catch { throw new UserError('正文已写入，但保存状态待恢复。请重新打开笔记以恢复记录，再继续操作。'); }
    });
  }
  async writeBatch(file,path,current,next,batch,checkEditor){
    let proposed=false;
    try{
      await this.vault.process(file,latest=>{
        checkEditor(current);
        if(file.path!==path||hash(latest)!==batch.beforeVersion)throw new UserError('保存时检测到外部修改，未覆盖。',409);
        proposed=true;return next;
      });
    }catch(error){
      if(!proposed)await this.state.mutate(data=>{if(data.notes[path]?.pendingBatch?.id===batch.id)delete data.notes[path].pendingBatch;});
      throw error;
    }
  }
  async rename(oldPath, path) {
    if (oldPath === path) return;
    return this.locked(oldPath, () => this.locked(path, async () => {
      if (!this.state.data.notes?.[oldPath]) return;
      this.file(path);
      await this.state.mutate(data => {
        if (data.notes[path]) throw new UserError('新路径已有留言，未自动合并；旧留言已保留。');
        const thread = data.notes[oldPath];
        const move = r => {
          if (r.capture) r.capture.path = path;
          if (r.anchor) r.anchor.path = path;
          for (const turn of r.turns || []) if (turn.capture) turn.capture.path = path;
        };
        for (const r of thread.records) move(r);
        if (thread.draft) move(thread.draft);
        for (const r of thread.pendingBatch?.updates || []) move(r);
        data.notes[path] = thread; delete data.notes[oldPath];
      });
    }));
  }
}
