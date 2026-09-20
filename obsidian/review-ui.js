import { Modal, Notice } from 'obsidian';
import { diffWordsWithSpace } from 'diff';
import { renderAnswer } from './answer-markdown.js';
import { reviewContext } from './review.js';

export class ReviewRequestModal extends Modal {
  constructor(panel, source) { super(panel.app); this.panel = panel; this.source = source; panel.plugin.register(()=>this.close()); }
  onOpen() {
    this.panel.plugin.pointSelect.clearSelection();
    this.setTitle('请 AI 审阅这篇笔记');
    const root = this.contentEl; root.addClass('folio-review-request');
    root.createEl('p', { text: 'AI 会在正文旁提出意见，原文保持不变。' });
    root.createEl('p', { cls: 'folio-note-context', text: `发送范围：当前笔记全文（${this.source.length.toLocaleString()} 字符）和下面的要求，发往你的 Codex 模型服务。不读取其他笔记。` });
    const input = root.createEl('textarea', { attr: { rows: '3', maxlength: '2000', 'aria-label': '审稿要求' } });
    input.value = '找出表达不清、重复、结构不顺或缺少依据的地方，最多提出 5 条具体意见。';
    const preview = root.createEl('details'); preview.createEl('summary', { text: '查看将发送的全文' });
    preview.createEl('pre', { text: this.source });
    const send = root.createEl('button', { cls: 'mod-cta folio-review-start', text: '发送并开始审稿' });
    send.onclick = () => {
      if (!input.value.trim()) return;
      try { reviewContext(this.source); this.close(); this.panel.review(this.source, input.value.trim()).catch(e => this.panel.report(e)); }
      catch (error) { new Notice(error.message); }
    };
  }
}

export class RevisionModal extends Modal {
  constructor(panel, records) { super(panel.app); this.panel = panel; this.records = structuredClone(records); this.selected = new Set(records.map(r => r.id)); this.request = 0; panel.plugin.register(()=>this.close()); }
  onOpen() {
    this.panel.plugin.pointSelect.clearSelection();
    this.setTitle('审阅这次修改'); this.modalEl.addClass('folio-revision-modal');
    const root = this.contentEl;
    root.createEl('p', { text: '勾选要采用的建议。保存前检查最终正文；未勾选的建议会保留。' });
    const choices = root.createDiv({ cls: 'folio-revision-choices' }); this.checkboxes = [];
    for (const record of this.records) {
      const row = choices.createEl('label');
      const check = row.createEl('input', { attr: { type: 'checkbox', 'aria-label': record.message } }); check.checked = true; this.checkboxes.push(check);
      row.createSpan({ text: record.message });
      check.onchange = () => { if (check.checked) this.selected.add(record.id); else this.selected.delete(record.id); this.refresh(); };
    }
    this.status = root.createDiv({ cls: 'folio-note-status', attr: { role: 'status' } });
    this.preview = root.createDiv({ cls: 'folio-revision-preview' });
    const footer = root.createDiv({ cls: 'folio-revision-footer' });
    this.save = footer.createEl('button', { cls: 'mod-cta folio-revision-save', text: '采用所选并保存' }); this.save.disabled = true;
    this.save.onclick = () => this.commit();
    const refresh=footer.createEl('button',{text:'重新检查预览'});refresh.onclick=()=>{if(!this.saving)this.refresh();};
    footer.createEl('small', { text: '保存前备份 · 可整批撤销' });
    this.refresh();
  }
  async refresh() {
    const request = ++this.request; this.save.disabled = true; this.plan = null;
    try {
      const records = this.records.filter(r => this.selected.has(r.id));
      const plan = await this.panel.plugin.noteStore.preview(records);
      if (request !== this.request || this.closed) return;
      this.plan = plan; this.preview.empty();
      this.status.setText(`本次采用 ${plan.changes.length} 处修改。`);
      for (const { record, capture, replacement } of plan.changes) {
        const item = this.preview.createDiv({ cls: 'folio-revision-change' });
        item.createEl('h3', { text: record.message });
        const diff = item.createEl('pre', { cls: 'folio-note-diff' });
        for (const part of diffWordsWithSpace(capture.expected, replacement)) diff.createEl(part.added ? 'ins' : part.removed ? 'del' : 'span', { text: part.value });
      }
      const final = this.preview.createEl('details', { cls: 'folio-revision-final' }); final.open = true;
      final.createEl('summary', { text: '保存后的完整正文' }); renderAnswer(final.createDiv(), plan.next);
      this.save.disabled = false;
    } catch (error) { if (request === this.request && !this.closed) { this.preview.empty(); this.status.setText(error.message); } }
  }
  async commit() {
    if (!this.plan || this.saving) return;
    this.saving = true; this.save.disabled = true; this.checkboxes.forEach(c => c.disabled = true);
    try {
      const plan = this.plan;
      await this.panel.plugin.noteStore.applyBatch(plan.changes.map(c => c.record), plan.version, s => this.panel.checkEditors(s, plan.path));
      await this.panel.reloadRecords(); this.panel.plugin.pointSelect.inline.refresh(plan.path);
      new Notice(`已保存 ${plan.changes.length} 处修改，可撤销这次保存。`); this.close();
    } catch (error) { this.status.setText(error.message); this.plan = null; }
    finally { this.saving = false; this.checkboxes.forEach(c => c.disabled = false); }
  }
  onClose() { this.closed = true; ++this.request; }
}
