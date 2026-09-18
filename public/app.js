import { RecoveryStore } from './recovery.js';
const $ = id => document.getElementById(id);
const host = globalThis.folioHost;
const localStore = host?.localStorage || localStorage, sessionStore = host?.sessionStorage || sessionStorage;
let token, doc, savedSource, savedVersion, channel, ready = false, status, documents = [];
let notes = [], selected, undo = [], redo = [], running = null, activeNotes = [], proposal = null, proposalSource, pollTimer;
let actions = Promise.resolve();
let composerDrafts = [], review = null;
const recoveryStore = host?.recovery || new RecoveryStore(), recoveryOwner = crypto.randomUUID();
let recoveryRefs = [], recoverySavedVersion = null, recoveryError = false, recovered = false;
const frame = $('document-frame');
async function api(route, data) {
  if (host) return host.request(route, data);
  const response = await fetch('/api/' + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'x-folio-token': token || '', ...(data === undefined ? {} : { 'content-type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '本地请求失败。'); return result;
}
if (host) host.onError = message => notice(message, true);
function notice(message, error = false) { $('notice-text').textContent = message; $('notice').classList.toggle('error', error); $('notice').hidden = false; }
function action(fn) { actions = actions.then(fn).catch(e => notice(e.message, true)); return actions; }
function post(data) { if (ready) frame.contentWindow.postMessage({ channel, ...data }, '*'); }
function persist() { if (doc) try { localStore.setItem('folio.notes.' + doc.id, JSON.stringify(notes)); localStore.setItem('folio.composers.' + doc.id, JSON.stringify(composerDrafts)); } catch { notice('浏览器空间不足，留言暂时只保留在当前页面。', true); } }
const pending = () => notes.filter(n => ['pending','error'].includes(n.state) && n.version === doc.version);
function configure() { post({ type: 'configure', enabled: true, drafts: composerDrafts.filter(d => d.version === doc.version), notes: notes.filter(n => n.version === doc.version && n.state !== 'applied').map(n => ({ id: n.id, targetId: n.targetId, comment: n.comment, number: notes.indexOf(n) + 1 })) }); }
function button(text, fn, className = '') { const b = document.createElement('button'); b.textContent = text; b.className = className; b.onclick = fn; return b; }
function showDocumentPicker() {
  document.body.classList.add('choosing-document'); frame.hidden = true;
  if (!$('document-welcome')) {
    const welcome = document.createElement('section'); welcome.id = 'document-welcome';
    const label = document.createElement('div'); label.className = 'eyebrow'; label.textContent = '页间 · 从你的文档开始';
    const title = document.createElement('h1'); title.textContent = host ? '想讨论或修改哪份文档？' : '想修改哪一份 HTML？';
    const description = document.createElement('p'); description.textContent = host?'打开一篇笔记或 HTML，点中内容就能留言。正在看文档时，点击左侧页间即可直接批注。':'选择笔记库里的页面，或从电脑导入一份。打开后，点中内容就能留言。';
    const choose = button('选择笔记库里的 HTML', () => { document.body.classList.add('documents-open'); $('document-search').focus(); }, 'primary'); choose.id = 'choose-vault-document';
    const upload = button('导入 HTML 文件', chooseImport); upload.id = 'import-welcome';
    const actions = document.createElement('div'); actions.className = 'welcome-actions'; actions.append(choose, upload);
    if(host){const notes=button('打开 Markdown 笔记',()=>action(()=>api('notes/open')));notes.id='choose-note-document';actions.prepend(notes);}
    const hint = document.createElement('small'); hint.textContent = host?'支持 Markdown 笔记与 HTML。导入 HTML 会在笔记库 Folio 文件夹创建副本。':'支持 .html / .htm。导入会在笔记库 Folio 文件夹创建副本。';
    welcome.append(label, title, description, actions, hint); document.querySelector('.paper-wrap').prepend(welcome);
  }
  $('document-welcome').hidden = false;
  $('doc-title').textContent = '选择文档'; $('save-state').textContent = host?'等待打开文档':'等待选择 HTML';
  for (const id of ['save','export','undo','redo','generate','history','recover-list']) $(id).disabled = true;
}
function renderDocuments() {
  const query = $('document-search')?.value.trim().toLocaleLowerCase() || '';
  const includeOther = $('show-incompatible')?.checked;
  const visible = documents.filter(d => (d.supported !== false || includeOther) && (d.title + ' ' + d.name).toLocaleLowerCase().includes(query));
  $('documents').replaceChildren(...visible.map(d => {
    const row = button('', () => action(async () => { await openDocument(d.id); document.body.classList.remove('documents-open'); }), d.id === doc?.id ? 'active' : '');
    row.title = d.title;
    const name = document.createElement('strong'); name.textContent = d.name || d.title;
    const folder = document.createElement('small'); folder.textContent = d.title.includes('/') ? d.title.slice(0, d.title.lastIndexOf('/')) : '笔记库';
    row.append(name, folder);
    if (d.supported === false) { const badge = document.createElement('small'); badge.className = 'compatibility-label'; badge.textContent = '需创建静态副本'; row.append(badge); }
    return row;
  }));
  if (!visible.length) $('documents').textContent = '没有匹配的可编辑 HTML。可导入文件或显示需转换的文件。';
  if ($('compatibility-count')) $('compatibility-count').textContent = `显示需转换文件（${documents.filter(d => d.supported === false).length}）`;
}
function unavailableDocument(entry, message) {
  if (entry?.convertible === false) { notice(message, true); return; }
  if (!doc) {
    $('save-state').textContent = '请选择可编辑 HTML';
    for (const id of ['save','export','undo','redo','generate','history','recover-list']) $(id).disabled = true;
  }
  if (!host) { notice(message, true); return; }
  $('incompatible-title').textContent = entry?.name || '此 HTML 暂不能直接编辑';
  $('incompatible-reason').textContent = message;
  $('static-copy').onclick = () => action(async () => {
    $('static-copy').disabled = true;
    try {
      const copy = entry.candidate ? await api('import/convert', {token: entry.candidate}) : entry.importSource !== undefined ? await api('documents/import-static', {name: entry.name, source: entry.importSource}) : await api('documents/static-copy', {id: entry.id});
      documents = await api('documents'); renderDocuments();
      $('incompatible-dialog').close(); await openDocument(copy.id, copy); notice(copy.conversion);
    } finally { $('static-copy').disabled = false; }
  });
  $('incompatible-dialog').showModal();
}

if (host) {
  document.body.classList.add('obsidian-host');
  const search = document.createElement('input'); search.id = 'document-search'; search.type = 'search'; search.placeholder = '搜索文件名或目录'; search.setAttribute('aria-label', '搜索 HTML 文档'); search.oninput = renderDocuments;
  const filter = document.createElement('label'); filter.className = 'compatibility-filter';
  const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.id = 'show-incompatible'; checkbox.onchange = renderDocuments;
  const count = document.createElement('span'); count.id = 'compatibility-count'; filter.append(checkbox, count);
  $('documents').before(search, filter);
  const dialog = document.createElement('dialog'); dialog.id = 'incompatible-dialog';
  const title = document.createElement('h2'); title.id = 'incompatible-title';
  const reason = document.createElement('p'); reason.id = 'incompatible-reason';
  const explanation = document.createElement('p'); explanation.textContent = '可以在 Folio 文件夹新建静态副本再编辑。原文件保留；图片会复制到笔记库，脚本、嵌入内容和外部样式会移除，布局与交互可能不同。';
  const copy = button('创建静态副本并打开', () => {}, 'primary'); copy.id = 'static-copy';
  dialog.append(title, reason, explanation, copy, button('取消', () => dialog.close())); document.body.append(dialog);
  const toggle = button('文档', () => document.body.classList.toggle('documents-open'), 'toggle-documents');
  toggle.setAttribute('aria-label', '显示文档与保存历史'); document.querySelector('.top-actions').prepend(toggle);
}
function refresh() {
  if (!doc) return;
  const dirty = doc.source !== savedSource;
  const durable = recoverySavedVersion === doc.version;
  $('save-state').textContent = !dirty ? '已保存到本机' : recoveryError ? '自动暂存失败 · 请保存' : durable ? '草稿已自动暂存 · 未保存' : '正在暂存草稿…';
  $('recovery-banner').hidden = !dirty;
  $('recovery-banner').classList.toggle('error', recoveryError);
  $('recovery-message').textContent = recoveryError ? '自动暂存失败，请保存文档或导出后再离开。' : !durable ? '正在暂存 AI 修改…' : recovered ? '已恢复上次未保存的修改，尚未写入文档。' : 'AI 修改已自动暂存，刷新后可恢复；点击保存才写入文档。';
  $('save-state').classList.toggle('dirty', doc.source !== savedSource); $('save').disabled = doc.source === savedSource;
  $('undo').disabled = !undo.length || !!running; $('redo').disabled = !redo.length || !!running;
  $('doc-title').textContent = doc.title; $('note-count').textContent = String(notes.filter(n => n.state !== 'applied').length).padStart(2, '0');
  $('generate').disabled = !pending().length || !!running || !status?.available || !!proposal;
  $('generate-label').textContent = pending().length ? `让 Codex 执行 ${pending().length} 条留言` : '让 Codex 执行留言';
  $('cancel').hidden = !running; $('notes-empty').hidden = !!notes.length;
  $('annotations').replaceChildren(...notes.map((note, i) => {
    const card = document.createElement('article'); card.className = 'note-card'; card.dataset.noteId = note.id;
    const top = document.createElement('div'); top.className = 'note-heading';
    const title = document.createElement('strong'); title.textContent = String(i + 1).padStart(2,'0') + ' · ' + note.label;
    const state = document.createElement('span'); state.className = 'note-state ' + note.state; state.textContent = ({ pending:'待执行',running:'修改中',done:'待采用',error:'可重试',stale:'需重新定位',applied:'已采用' })[note.state] || '';
    top.append(title, state); const comment = document.createElement('p'); comment.textContent = note.comment;
    const ops = document.createElement('div'); ops.className = 'note-actions';
    if (note.version === doc.version && !['applied','running','done'].includes(note.state)) ops.append(button('定位 / 改留言', () => post({ type: 'open-note', targetId: note.targetId, noteId: note.id })));
    if (note.state === 'stale') { const hint = document.createElement('small'); hint.textContent = '重新点击页面元素，粘贴这条留言。'; ops.append(hint); ops.append(button('复制留言', async () => { try { await (host ? host.copy(note.comment) : navigator.clipboard.writeText(note.comment)); notice('留言已复制，重新点击目标后粘贴即可。'); } catch { notice('请选中留言文字后复制。'); } })); }
    if (!['running','done'].includes(note.state)) ops.append(button('删除', () => { notes = notes.filter(n => n.id !== note.id); persist(); refresh(); configure(); }));
    card.append(top, comment, ops); return card;
  }));
  renderDocuments();
}
async function render() { ready = false; const preview = await api('preview', { source: doc.source }); channel = preview.channel; frame.srcdoc = preview.html; if (preview.warnings?.length) notice('图片未加载：' + preview.warnings.join('；'), true); }
function staleNotes() { for (const n of notes) { if (n.state !== 'applied' && n.version !== doc.version) n.state = 'stale'; else if (n.state === 'stale' && n.version === doc.version) n.state = 'pending'; } persist(); }
function snapshot() { return { source: doc.source, notes: structuredClone(notes).map(n => ({ ...n, state: ['done','running'].includes(n.state) ? 'pending' : n.state })) }; }
async function updateDraft(result, record = true, before = snapshot()) {
  if (result.source !== doc.source && record) { undo.push(before); if (undo.length > 100) undo.shift(); redo = []; }
  doc = { ...doc, ...result }; recoverySavedVersion = null; staleNotes(); refresh(); await checkpoint();
}
window.addEventListener('message', event => {
  if (event.source !== frame.contentWindow || event.data?.channel !== channel) return;
  const m = event.data;
  if (!ready && m.type !== 'ready') return;
  if (m.type === 'ready') { ready = true; configure(); }
  if (m.type === 'select') selected = m.id;
  if (m.type === 'composer-draft' && typeof m.comment === 'string' && m.comment.length <= 2000 && doc.elements.some(e => e.id === m.targetId)) {
    composerDrafts = composerDrafts.filter(d => !(d.targetId === m.targetId && d.version === doc.version));
    composerDrafts.push({ targetId: m.targetId, comment: m.comment, noteId: m.noteId, version: doc.version }); persist();
  }
  if (m.type === 'annotation') {
    const originDoc = doc.id, originVersion = doc.version;
    action(async () => {
    try {
    if (doc.id !== originDoc || doc.version !== originVersion) throw new Error('页面已经变化，留言已暂存，请重新选择位置。');
    const target = doc.elements.find(e => e.id === m.targetId);
    if (!target || typeof m.comment !== 'string' || !m.comment.trim() || m.comment.length > 2000) throw new Error('这条留言无效，请重新选择元素。');
    if (proposal) throw new Error('先采用或舍弃上一批修改，再添加留言。');
    let existing = notes.find(n => n.id === m.noteId || n.targetId === target.id && n.version === doc.version && !['applied','stale'].includes(n.state));
    if (existing && existing.state === 'running') throw new Error('这条留言正在执行，停止后才能修改。');
    if (!existing && notes.filter(n => n.state !== 'applied').length >= 12) throw new Error('每批最多 12 条留言，请先执行或删除现有留言。');
    const note = { id: existing?.id || crypto.randomUUID(), targetId: target.id, expected: target.html, version: doc.version, label: target.label, comment: m.comment.trim(), context: typeof m.context === 'string' ? m.context.slice(0, 5000) : '', state: 'pending' };
    if (existing) notes[notes.indexOf(existing)] = note; else notes.push(note);
    composerDrafts = composerDrafts.filter(d => !(d.targetId === target.id && d.version === doc.version));
    persist(); refresh(); configure();
    post({ type: 'annotation-result', requestId: m.requestId, ok: true });
    if (m.run) await generate([note]); else notice('留言已加入。你可以继续点其他位置，最后一起执行。');
    } catch (e) { post({ type: 'annotation-result', requestId: m.requestId, ok: false, error: e.message }); throw e; }
    });
  }
  if (m.type === 'shortcut') shortcut(m.key, m.shift);
});
async function stop() {
  if (!running) return;
  const id = running; running = null; clearTimeout(pollTimer); await api(`proposals/${id}/cancel`, {});
  for (const n of notes) if (activeNotes.includes(n.id)) n.state = 'pending'; activeNotes = []; $('progress').hidden = true; persist(); refresh();
}
async function openDocument(id, imported) {
  const entry = documents.find(d => d.id === id);
  if (entry?.supported === false && !imported) { unavailableDocument(entry, entry.reason); return; }
  if (doc && doc.source !== savedSource && !await checkpoint() && !confirm('自动暂存失败，离开会丢失当前草稿。仍然离开？')) return;
  let nextDoc;
  try { nextDoc = imported || await api(`documents/${id}`); }
  catch (error) { unavailableDocument({ ...entry, id, ...(error.status === 413 ? { convertible: false } : {}) }, error.message); return; }
  await stop(); doc = nextDoc; savedVersion = doc.version; savedSource = doc.source;
  document.body.classList.remove('choosing-document', 'documents-open');
  if ($('document-welcome')) $('document-welcome').hidden = true;
  frame.hidden = false;
  for (const key of ['export', 'history', 'recover-list']) $(key).disabled = false;
  if (host) await host.request('active-document', { id: doc.id });
  try { sessionStore.setItem('folio.lastDocument', doc.id); localStore.setItem('folio.lastDocument', doc.id); } catch {}
  recoveryRefs = []; recoverySavedVersion = null; recoveryError = false; recovered = false;
  selected = null; undo = []; redo = []; proposal = null; $('proposal').hidden = true;
  try { const stored = JSON.parse(localStore.getItem('folio.notes.' + doc.id) || '[]'); notes = Array.isArray(stored) ? stored.filter(n => typeof n.comment === 'string' && typeof n.id === 'string' && typeof n.expected === 'string').slice(-40) : []; } catch { notes = []; }
  try { const stored = JSON.parse(localStore.getItem('folio.composers.' + doc.id) || '[]'); composerDrafts = Array.isArray(stored) ? stored.filter(d => typeof d.comment === 'string' && d.comment.length <= 2000 && typeof d.targetId === 'string' && typeof d.version === 'string') : []; } catch { composerDrafts = []; }
  for (const n of notes) if (['running','done'].includes(n.state)) n.state = 'pending';
  try {
    const records = await recoveryCandidates();
    if (records.length === 1 && records[0].baseVersion === savedVersion) { await restoreRecovery(records[0]); return; }
    staleNotes(); refresh(); await render();
    if (records.length) showRecoveryRecords(records);
  } catch (e) { staleNotes(); refresh(); await render(); notice('无法恢复本地草稿：' + e.message, true); }
}
async function save() {
  const result = await api(`documents/${doc.id}/save`, { version: savedVersion, source: doc.source });
  savedVersion = result.version; savedSource = result.source; recovered = false;
  const cleaned = await checkpoint(); documents = await api('documents'); refresh();
  notice(cleaned ? '已保存，并清理本窗口的自动草稿。保存前的内容仍可从历史恢复。' : '文件已保存，但自动草稿清理失败；重新打开时会跳过相同内容。', !cleaned);
}
async function historyStep(forward = false) {
  if (running) throw new Error('请先停止正在执行的留言。');
  const from = forward ? redo : undo, to = forward ? undo : redo; if (!from.length) return;
  const entry = from.at(-1), result = await api('draft/inspect', { source: entry.source });
  from.pop(); to.push(snapshot()); discard();
  const historicIds = new Set(entry.notes.map(n => n.id));
  // Keep notes created later, so undoing a document change never drops new feedback.
  notes = [...structuredClone(entry.notes), ...notes.filter(n => !historicIds.has(n.id))];
  await updateDraft(result, false); await render();
}
function discard() {
  if (proposal) for (const n of notes) if (proposal.changes.some(c => c.noteId === n.id)) n.state = n.version === doc.version ? 'pending' : 'stale';
  proposal = null; proposalSource = null; $('proposal').hidden = true; persist(); refresh(); configure();
}
async function generate(batch = pending()) {
  if (running) throw new Error('已有留言正在执行，请等待完成。');
  if (!status?.available) throw new Error(status?.message || '本机 Codex 尚不可用。');
  if (!batch.length) throw new Error('先点击页面上的元素，写一条留言。');
  if (proposal) throw new Error('请先采用或舍弃上一批修改。');
  const result = await api('proposals', { source: doc.source, annotations: batch, preserveNumbers: $('preserve').checked });
  proposalSource = doc.source; activeNotes = batch.map(n => n.id); for (const n of batch) n.state = 'running';
  running = result.id; post({ type: 'close' }); $('progress').textContent = '正在连接本地 Codex…'; $('progress').hidden = false; persist(); refresh(); poll(result.id);
}
async function poll(id) {
  try {
    const job = await api(`proposals/${id}`); if (running !== id) return;
    if (job.state === 'running') { $('progress').textContent = job.message; pollTimer = setTimeout(() => poll(id), 800); return; }
    running = null; $('progress').hidden = true;
    if (job.state === 'done') {
      proposal = job; for (const n of notes) if (activeNotes.includes(n.id)) n.state = 'done';
      $('proposal-summary').textContent = job.summary;
      $('diff').replaceChildren(...job.changes.map(change => { const item = document.createElement('details'), title = document.createElement('summary'), diff = document.createElement('div'); title.textContent = change.summary; diff.className = 'source-diff'; for (const part of change.diff) { const el = document.createElement(part.added ? 'ins' : part.removed ? 'del' : 'span'); el.textContent = part.value; diff.append(el); } item.append(title, diff); return item; }));
      $('proposal').hidden = false; notice('AI 已完成，点击「查看修改效果」审阅。');
    } else { for (const n of notes) if (activeNotes.includes(n.id)) n.state = 'error'; if (job.state === 'error') notice(job.message, true); }
    activeNotes = []; persist(); refresh(); configure();
  } catch (e) { if (running === id) { running = null; for (const n of notes) if (activeNotes.includes(n.id)) n.state = 'error'; activeNotes = []; $('progress').hidden = true; persist(); refresh(); notice(e.message, true); } }
}
async function accept() {
  if (!proposal) return;
  const result = await api('draft/replace', { source: doc.source, changes: proposal.changes, version: proposal.version });
  const before = snapshot();
  for (const n of notes) if (proposal.changes.some(c => c.noteId === n.id)) n.state = 'applied';
  proposal = null; $('proposal').hidden = true; await updateDraft(result, true, before); await render(); if (!recoveryError) notice('AI 修改已采用并自动暂存，点击保存才写入文档。');
}
async function previewProposal() {
  if (!proposal) return;
  const original = await api('draft/inspect', { source: proposalSource });
  const result = await api('draft/replace', { source: proposalSource, changes: proposal.changes, version: proposal.version });
  const [before, after] = await Promise.all([api('preview', { source: proposalSource }), api('preview', { source: result.source })]);
  const mapped = proposal.changes.map(c => ({ ...c, element: original.elements.find(e => e.id === c.targetId) }));
  review = { before, after, index: 0, loaded: {}, changes: mapped.map(c => {
    const shift = mapped.filter(x => x.element.end <= c.element.start).reduce((delta, x) => delta + x.html.length - (x.element.end - x.element.start), 0);
    const start = c.element.start + shift;
    const target = result.elements.find(e => e.start === start && e.html === c.html);
    // Deleted elements have no after-node: show the nearest surviving containing element.
    const parent = result.elements.filter(e => e.start <= start && e.end >= start).sort((a,b) => (a.end-a.start)-(b.end-b.start))[0];
    return { ...c, afterId: target?.id || parent?.id };
  }) };
  $('review-change').replaceChildren(...review.changes.map((c, i) => { const option = document.createElement('option'); option.value = i; option.textContent = `${i + 1}. ${c.summary}`; return option; }));
  const currentReview = review;
  const setup = (id, value) => {
    const target = $(id); const listener = e => { if (e.source === target.contentWindow && e.data?.channel === value.channel && e.data.type === 'ready') { if (review === currentReview) { review.loaded[id] = true; focusReview(); } window.removeEventListener('message', listener); } };
    window.addEventListener('message', listener); setTimeout(() => window.removeEventListener('message', listener), 8000); target.srcdoc = value.html;
  };
  setup('before-frame', before); setup('after-frame', after); focusReview(); $('preview-dialog').showModal();
}
function focusReview() {
  if (!review) return;
  const change = review.changes[review.index];
  $('review-change').value = review.index;
  $('review-prev').disabled = review.index === 0; $('review-next').disabled = review.index === review.changes.length - 1;
  $('review-position').textContent = `${review.index + 1} / ${review.changes.length}`;
  $('review-context').textContent = change.html ? change.label : '这条留言删除了所选元素，右侧显示删除后的附近内容。';
  for (const [id, value, targetId] of [['before-frame',review.before,change.targetId],['after-frame',review.after,change.afterId]]) if (review.loaded[id]) $(id).contentWindow.postMessage({ channel: value.channel, type: 'configure', id: targetId, enabled: false, scroll: true }, '*');
}
$('review-change').onchange = () => { if (review) { review.index = Number($('review-change').value); focusReview(); } };
$('review-prev').onclick = () => { if (review && review.index > 0) { review.index--; focusReview(); } };
$('review-next').onclick = () => { if (review && review.index < review.changes.length - 1) { review.index++; focusReview(); } };
function limitedHistory(entries) {
  let bytes = 0; const result = [];
  for (const entry of [...entries].reverse()) {
    if (typeof entry.source !== 'string' || !Array.isArray(entry.notes)) continue;
    const size = JSON.stringify(entry).length;
    if (result.length >= 12 || bytes + size > 2_000_000) break;
    result.unshift(entry); bytes += size;
  }
  return result;
}
function validNotes(value) { return Array.isArray(value) ? value.filter(n => n && typeof n.id === 'string' && typeof n.comment === 'string' && typeof n.expected === 'string').slice(-100) : []; }
async function checkpoint() {
  if (!doc) return true;
  try {
    if (doc.source === savedSource) {
      await recoveryStore.remove(recoveryRefs); recoveryRefs = []; recoverySavedVersion = null;
    } else {
      const key = doc.id + ':' + recoveryOwner;
      const ancestors = recoveryRefs.filter(ref => ref.key !== key);
      const record = { key, revision: crypto.randomUUID(), documentId: doc.id, name: doc.name, title: doc.title, baseVersion: savedVersion, source: doc.source, version: doc.version, notes: structuredClone(notes), composerDrafts: structuredClone(composerDrafts), undo: limitedHistory(undo), redo: limitedHistory(redo), ancestors, updatedAt: Date.now() };
      await recoveryStore.put(record);
      recoveryRefs = [...ancestors, { key, revision: record.revision }]; recoverySavedVersion = record.version;
    }
    recoveryError = false; refresh(); return true;
  } catch {
    recoveryError = true; refresh(); notice('自动暂存失败，请点击保存文档或导出；当前修改仍在页面中。', true); return false;
  }
}
async function recoveryCandidates() {
  const rows = await recoveryStore.list(doc.id);
  const referenced = new Set(rows.flatMap(row => (row.ancestors || []).map(ref => ref.key + ':' + ref.revision)));
  const seen = new Set();
  return rows.filter(row => {
    if (typeof row.source !== 'string' || typeof row.baseVersion !== 'string' || typeof row.version !== 'string' || row.source === savedSource || referenced.has(row.key + ':' + row.revision)) return false;
    const identity = row.baseVersion + ':' + row.version; if (seen.has(identity)) return false; seen.add(identity); return true;
  });
}
async function restoreRecovery(record) {
  if (record.baseVersion !== savedVersion) throw new Error('原文件版本已变化，请将草稿恢复为新文档。');
  if (doc.source !== savedSource && !await checkpoint()) throw new Error('当前草稿尚未成功暂存，请先保存或导出。');
  const restored = await api('draft/inspect', { source: record.source });
  if (restored.version !== record.version) throw new Error('草稿内容校验失败，请导出后检查。');
  await stop(); discard();
  const restoredNotes = validNotes(record.notes), ids = new Set(restoredNotes.map(n => n.id));
  notes = [...restoredNotes, ...notes.filter(n => !ids.has(n.id))];
  const restoredComposers = Array.isArray(record.composerDrafts) ? record.composerDrafts.filter(d => typeof d?.comment === 'string' && typeof d?.targetId === 'string' && typeof d?.version === 'string') : [];
  composerDrafts = [...restoredComposers, ...composerDrafts.filter(d => !restoredComposers.some(x => x.targetId === d.targetId && x.version === d.version))];
  doc = { ...doc, ...restored }; undo = limitedHistory(Array.isArray(record.undo) ? record.undo : []); redo = limitedHistory(Array.isArray(record.redo) ? record.redo : []);
  recoveryRefs = [...(Array.isArray(record.ancestors) ? record.ancestors : []), { key: record.key, revision: record.revision }];
  recoverySavedVersion = null; recovered = true; staleNotes(); refresh(); await checkpoint(); await render();
  $('recovery-dialog').close(); if (!recoveryError) notice('已恢复上次未保存的 AI 修改，原文件保持不变。');
}
function downloadSource(source, name) {
  if (host) { host.export(source, name).then(() => notice('已另存到笔记库 Folio 文件夹。')).catch(error => notice(error.message, true)); return; }
  const url = URL.createObjectURL(new Blob([source], { type: 'text/html;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = name || 'recovered.html'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function showRecoveryRecords(records) {
  $('recovery-explanation').textContent = records.some(r => r.baseVersion !== savedVersion) ? '原文件已有新版本。旧草稿仍保留，可导出或恢复为新文档，避免覆盖最新文件。' : records.length ? '找到以下未保存草稿。选择要恢复的一份；关闭此窗口会继续保留它们。' : '当前没有其他未保存草稿。采用 AI 修改后会自动暂存。';
  $('recovery-records').replaceChildren(...records.map(record => {
    const card = document.createElement('article'); card.className = 'recovery-record';
    const title = document.createElement('h3'); title.textContent = (record.title || '文档') + ' · ' + new Date(record.updatedAt).toLocaleString('zh-CN');
    const info = document.createElement('p'); info.textContent = record.baseVersion === savedVersion ? '基于当前已保存版本，可以恢复为草稿。' : '与当前文件版本不同，可作为独立副本恢复。';
    const ops = document.createElement('div'); ops.className = 'record-actions';
    if (record.baseVersion === savedVersion) ops.append(button('恢复此草稿', () => action(() => restoreRecovery(record)), 'primary'));
    ops.append(button('恢复为新文档', () => action(async () => {
      const result = await api('documents/import', { name: '恢复副本-' + record.name, source: record.source });
      documents = await api('documents'); $('recovery-dialog').close(); await openDocument(result.id, result); notice('已恢复为独立文档，原文件和原草稿均已保留。');
    })));
    ops.append(button('导出草稿', () => downloadSource(record.source, '未保存草稿-' + (record.name || 'report.html')))); card.append(title, info, ops); return card;
  }));
  if (!$('recovery-dialog').open) $('recovery-dialog').showModal();
}
$('recover-list').onclick = () => action(async () => { if (doc.source !== savedSource) await checkpoint(); showRecoveryRecords(await recoveryCandidates()); });
$('drop-draft').onclick = () => action(async () => {
  if (!confirm('舍弃当前未保存的修改及其自动草稿，回到磁盘上已保存的版本？')) return;
  const disk = await api(`documents/${doc.id}`), before = snapshot();
  await recoveryStore.remove(recoveryRefs); recoveryRefs = [];
  savedSource = disk.source; savedVersion = disk.version; recovered = false;
  for (const n of notes) n.state = n.version === disk.version ? 'pending' : 'stale';
  discard(); await updateDraft(disk, true, before); await render(); notice('已回到已保存版本。当前页面仍可撤销这次操作。');
});
async function showHistory() {
  const versions = await api(`documents/${doc.id}/versions`); $('versions').replaceChildren();
  if (!versions.length) $('versions').textContent = '首次修改并保存后，会自动备份原文。';
  for (const version of versions) $('versions').append(button(new Date(version.date).toLocaleString('zh-CN') + '　恢复为草稿 ↗', () => action(async () => { await stop(); const result = await api(`documents/${doc.id}/restore`, { backup: version.id }); discard(); await updateDraft(result); await render(); $('history-dialog').close(); if (!recoveryError) notice('历史内容已恢复为草稿并自动暂存，保存后写入文档。'); })));
  $('history-dialog').showModal();
}
async function exportFile() {
  if (!doc) return;
  if (host) { await host.export(doc.source, doc.name); notice('已另存到笔记库 Folio 文件夹。'); return; }
  const url = URL.createObjectURL(new Blob([doc.source], { type: 'text/html;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = doc.name || 'report.html'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function shortcut(key, shift) { if (!doc) return; if (key === 's') action(save); else if (key === 'z') action(() => historyStep(shift)); else if (key === 'y') action(() => historyStep(true)); }
$('save').onclick = () => action(save); $('undo').onclick = () => action(() => historyStep()); $('redo').onclick = () => action(() => historyStep(true));
$('generate').onclick = () => action(() => generate()); $('cancel').onclick = () => action(stop); $('accept').onclick = () => action(accept); $('discard').onclick = discard;
$('preview-proposal').onclick = () => action(previewProposal); $('history').onclick = () => action(showHistory); $('export').onclick = () => action(exportFile);
function chooseImport() {
  if (!host) { $('file').click(); return; }
  action(async () => {
    const result = await api('import/file');
    if (!result) return;
    if (result.candidate) { unavailableDocument(result, result.reason); return; }
    documents = await api('documents'); await openDocument(result.id, result);
  });
}
$('dismiss').onclick = () => { $('notice').hidden = true; }; $('import').onclick = chooseImport;
$('file').onchange = () => {
  const file = $('file').files[0]; if (!file) return;
  action(async () => {
    try {
      if (file.size > (host ? 25_000_000 : 600_000)) throw new Error(host ? '请选择不超过 25 MB 的 HTML 文件。' : '请选择小于 600 KB 的静态 HTML。');
      const source = await file.text(); let result;
      try { result = await api('documents/import', {name: file.name, source}); }
      catch (error) { if (host) { unavailableDocument({name: file.name, importSource: source, ...(error.status === 413 ? {convertible: false} : {})}, error.message); return; } throw error; }
      documents = await api('documents'); await openDocument(result.id, result);
    } finally { $('file').value = ''; }
  });
};
document.querySelectorAll('[data-close]').forEach(b => { b.onclick = () => $(b.dataset.close).close(); });
document.addEventListener('keydown', event => { if (!(event.metaKey || event.ctrlKey)) return; const key = event.key.toLowerCase(); if (key === 's' || !['TEXTAREA','INPUT'].includes(event.target.tagName) && ['z','y'].includes(key)) { event.preventDefault(); shortcut(key, event.shiftKey); } });
window.addEventListener('beforeunload', event => { if (doc && (running || doc.source !== savedSource && (recoverySavedVersion !== doc.version || recoveryError))) { event.preventDefault(); event.returnValue = ''; } });
action(async () => {
  const bootstrap = await api('bootstrap'); token = bootstrap.token; status = bootstrap.status;
  document.querySelector('.prototype').textContent = `v${bootstrap.app.version} · ${host ? 'Obsidian' : '本地试用'}`;
  $('connection-dot').classList.toggle('offline', !status.available); $('connection-title').textContent = status.available ? status.mode === 'test' ? '测试替身 · 非真实 AI' : '已发现本地 Codex' : 'Codex 尚不可用';
  $('connection-detail').textContent = status.available ? `${status.model} · ${status.provider}` : status.message;
  documents = await api('documents');
  renderDocuments();
  if (host && !host.initialId) { showDocumentPicker(); return; }
  let preferred; try { preferred = sessionStore.getItem('folio.lastDocument') || localStore.getItem('folio.lastDocument'); } catch {}
  if (!documents.length) {
    for (const id of ['save','export','undo','redo','generate','history','recover-list']) $(id).disabled = true;
    $('save-state').textContent = '等待选择 HTML';
    notice('库中还没有 HTML。点击左侧 ＋ 导入，或运行命令“页间：创建 HTML 示例并开始批注”。'); return;
  }
  const selectedId = documents.find(d => d.id === preferred && d.supported !== false)?.id || documents.find(d => d.supported !== false)?.id;
  if (!selectedId) { $('save-state').textContent = '没有可直接编辑的 HTML'; for (const id of ['save','export','undo','redo','generate','history','recover-list']) $(id).disabled = true; notice('这些网页需要先转换。勾选“显示需转换文件”，选择文件后创建静态副本。'); return; }
  await openDocument(selectedId);
});
