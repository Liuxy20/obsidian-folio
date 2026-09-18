(() => {
  const channel = FOLIO_CHANNEL;
  const send = (type, data = {}) => parent.postMessage({ channel, type, ...data }, '*');
  const elements = new Map([...document.querySelectorAll('[data-folio-node]')].map(el => [el.dataset.folioNode, el]));
  let selected, enabled = false, notes = [], editingNote = null, submission = null;
  const drafts = new Map();
  const host = document.createElement('div'); host.dataset.folioUi = 'true';
  // Isolate annotation controls from document CSS; all generated UI stays in this shadow root.
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  document.body.append(host); const ui = host.attachShadow({ mode: 'open' });
  ui.innerHTML = `<style>
    :host{font:13px "Avenir Next","PingFang SC",sans-serif;color:#283c36}*{box-sizing:border-box}button,textarea{font:inherit}button{cursor:pointer;color:inherit;border:1px solid #dce2d7;border-radius:5px;background:#fffefa;padding:7px 10px}button:hover{background:#edf2e7}button:disabled{opacity:.45;cursor:not-allowed}button:focus-visible{outline:2px solid #a36d30;outline-offset:2px}[hidden]{display:none!important}.box{position:fixed;border:1px dashed #ba8a46;background:#d5a44408;pointer-events:none;border-radius:2px}.selected{border:2px solid #bb8843;background:#d5a44406}.label{position:fixed;background:#283c36;color:white;padding:4px 7px;border-radius:3px;font-size:10px;pointer-events:none;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.panel{position:fixed;width:290px;max-width:calc(100vw - 24px);background:#fffefa;border:1px solid #d9dece;box-shadow:0 10px 50px #253b3633;border-radius:10px;padding:15px;pointer-events:auto}.head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.head strong{font-size:13px;font-weight:600}.close{padding:0 5px;border:0;font-size:20px}.quote{font-size:11px;color:#7f897b;border-left:2px solid #c6a274;padding-left:8px;margin-bottom:12px;max-height:40px;overflow:hidden;line-height:1.7}textarea{width:100%;height:88px;resize:vertical;background:#f7f8f1;border:1px solid #dce2d5;border-radius:5px;padding:10px;line-height:1.7;outline-color:#8ca079;color:#283c36;font-size:12px}.row{display:flex;gap:7px;margin-top:10px}.row button{flex:1;font-size:11px}.primary{background:#286353;color:white;border-color:#286353}.primary:hover{background:#204f42}.parent{margin-top:11px;border:0;background:none;padding:0;color:#738267;font-size:10px}.tip{margin:9px 0 0;color:#939987;font-size:10px}.pin{position:fixed;width:23px;height:23px;border-radius:50%;background:#b58747;color:white;border:2px solid #fffefa;padding:0;box-shadow:0 2px 6px #0002;font-size:10px;pointer-events:auto}.pin:hover{background:#966b31}
  </style><div id="hover" class="box" hidden></div><div id="selection" class="box selected" hidden></div><div id="tag" class="label" hidden></div><div id="pins"></div>
  <section id="composer" class="panel" role="dialog" aria-label="给这里留言" hidden><div class="head"><strong>给这里留言</strong><button id="close" class="close" aria-label="关闭留言">×</button></div><div id="quote" class="quote"></div><textarea id="comment" aria-label="修改留言" maxlength="2000" placeholder="例如：标题大一点，颜色换成深绿色。"></textarea><button id="parent" class="parent">↑ 选择上一级，修改更大范围</button><div class="row"><button id="add">加入留言</button><button id="run" class="primary">让 AI 改这里 ↗</button></div><p class="tip">Enter 加入留言 · Shift + Enter 换行</p></section>`;
  const $ = id => ui.getElementById(id);
  const human = el => ({h1:'标题',h2:'标题',h3:'标题',p:'段落',span:'文字',strong:'文字',em:'文字',a:'链接',button:'按钮',img:'图片',table:'表格',td:'单元格',th:'表头',tr:'表格行',li:'列表项'}[el.tagName.toLowerCase()] || '容器');
  function placeBox(box, el) {
    if (!el?.isConnected) { box.hidden = true; return; }
    const r = el.getBoundingClientRect(); box.hidden = r.width === 0 || r.height === 0;
    Object.assign(box.style, { left: r.left - 3 + 'px', top: r.top - 3 + 'px', width: r.width + 6 + 'px', height: r.height + 6 + 'px' });
  }
  function layout() {
    placeBox($('selection'), selected);
    for (const pin of $('pins').children) {
      const el = elements.get(pin.dataset.target); if (!el) { pin.hidden = true; continue; }
      const r = el.getBoundingClientRect(); pin.hidden = r.bottom < 0 || r.top > innerHeight;
      pin.style.left = Math.max(2, Math.min(innerWidth - 25, r.right - 10)) + 'px'; pin.style.top = Math.max(2, r.top - 10) + 'px';
    }
    if (selected && !$('composer').hidden) {
      const r = selected.getBoundingClientRect(), panel = $('composer');
      let left = r.right + 14; if (left + panel.offsetWidth > innerWidth - 12) left = r.left - panel.offsetWidth - 14;
      let preferredTop = r.top;
      if (left < 12) { left = r.left; preferredTop = r.bottom + 14; if (preferredTop + panel.offsetHeight > innerHeight - 12) preferredTop = r.top - panel.offsetHeight - 14; }
      left = Math.max(12, Math.min(innerWidth - panel.offsetWidth - 12, left));
      // Large text spans: keep the composer near the element, inside the viewport.
      const top = Math.max(12, Math.min(innerHeight - panel.offsetHeight - 12, preferredTop));
      panel.style.left = left + 'px'; panel.style.top = top + 'px';
    }
  }
  function context(el) {
    const cs = getComputedStyle(el), p = el.parentElement;
    return JSON.stringify({ tag: el.tagName.toLowerCase(), text: el.textContent.slice(0, 600), styles: Object.fromEntries(['fontSize','fontWeight','color','backgroundColor','display','padding','margin','width','height','textAlign','gap'].map(k => [k, cs[k]])), parent: p ? { tag: p.tagName.toLowerCase(), display: getComputedStyle(p).display, width: p.getBoundingClientRect().width } : null });
  }
  function remember() {
    if (!selected || $('composer').hidden) return;
    const draft = { targetId: selected.dataset.folioNode, comment: $('comment').value, noteId: editingNote };
    drafts.set(draft.targetId, draft); send('composer-draft', draft);
  }
  function choose(el, open = true, noteId = null, scroll = false) {
    if (!el || submission) return;
    remember(); selected = el; editingNote = noteId;
    if (scroll) el.scrollIntoView({ block: 'center', behavior: 'instant' });
    $('hover').hidden = true; $('tag').hidden = true;
    if (open && enabled) {
      const existing = notes.find(n => n.id === noteId || !noteId && n.targetId === el.dataset.folioNode);
      const draft = drafts.get(el.dataset.folioNode);
      editingNote = draft?.noteId || existing?.id || noteId;
      $('quote').textContent = `${human(el)} · ${(el.textContent.trim() || el.getAttribute('alt') || '此元素').slice(0, 90)}`;
      $('comment').value = draft ? draft.comment : existing?.comment || '';
      $('status').textContent = '输入会自动暂存，关闭后可继续。';
      $('parent').disabled = !el.parentElement?.closest('[data-folio-node]'); $('composer').hidden = false;
      requestAnimationFrame(() => { layout(); $('comment').focus(); });
    }
    send('select', { id: el.dataset.folioNode }); layout();
  }
  function close(keep = true) { if (submission) return; if (keep) remember(); $('composer').hidden = true; $('comment').value = ''; editingNote = null; }
  function submit(run) {
    if (submission) return;
    const comment = $('comment').value.trim(); if (!comment || !selected) { $('comment').focus(); return; }
    remember();
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { submission = null; $('comment').readOnly = false; $('add').disabled = false; $('run').disabled = false; $('status').textContent = '工作台暂未确认，文字已暂存，请稍后重试。'; }, 8000);
    submission = { requestId, targetId: selected.dataset.folioNode, timer };
    $('comment').readOnly = true; $('add').disabled = true; $('run').disabled = true; $('status').textContent = '正在提交…';
    send('annotation', { requestId, targetId: selected.dataset.folioNode, noteId: editingNote, comment, context: context(selected), run });
  }
  const status = document.createElement('p'); status.id = 'status'; status.className = 'tip'; status.setAttribute('role','status'); status.textContent = '输入会自动暂存，关闭后可继续。'; $('composer').append(status);
  $('comment').addEventListener('input', remember);
  $('close').onclick = () => close(); $('add').onclick = () => submit(false); $('run').onclick = () => submit(true);
  $('parent').onclick = () => { if (submission) return; const comment = $('comment').value; choose(selected.parentElement.closest('[data-folio-node]')); $('comment').value = comment; remember(); };
  $('comment').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(false); } if (e.key === 'Escape') close(); });
  document.addEventListener('pointermove', event => {
    if (!enabled || event.composedPath().includes(host) || !$('composer').hidden) return;
    const el = event.target.closest('[data-folio-node]'); placeBox($('hover'), el);
    if (el) { const r = el.getBoundingClientRect(); $('tag').textContent = human(el) + ' · 点击留言'; $('tag').style.left = Math.max(4, r.left) + 'px'; $('tag').style.top = Math.max(4, r.top - 25) + 'px'; $('tag').hidden = false; }
  }, true);
  document.addEventListener('click', event => {
    if (event.composedPath().includes(host)) return;
    if (event.target.closest('a')) event.preventDefault();
    if (!enabled) return;
    event.preventDefault(); event.stopPropagation();
    const el = event.target.closest('[data-folio-node]'); if (el) choose(el);
  }, true);
  document.addEventListener('keydown', event => {
    if (event.composedPath().includes(host)) return;
    if (event.key === 'Escape') close();
    if ((event.metaKey || event.ctrlKey) && ['s','z','y'].includes(event.key.toLowerCase())) { event.preventDefault(); send('shortcut', { key: event.key.toLowerCase(), shift: event.shiftKey }); }
  });
  function pins() {
    $('pins').replaceChildren();
    if (!enabled) return;
    notes.forEach((note, i) => { if (!elements.has(note.targetId)) return; const pin = document.createElement('button'); pin.className = 'pin'; pin.dataset.target = note.targetId; pin.textContent = note.number || i + 1; pin.title = note.comment; pin.setAttribute('aria-label', '留言 ' + pin.textContent); pin.onclick = () => choose(elements.get(note.targetId), true, note.id, true); $('pins').append(pin); }); layout();
  }
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.channel !== channel) return;
    const m = event.data;
    if (m.type === 'configure') { enabled = m.enabled === true; notes = Array.isArray(m.notes) ? m.notes : []; for (const draft of m.drafts || []) if (!drafts.has(draft.targetId)) drafts.set(draft.targetId, draft); if (m.id) choose(elements.get(m.id), false, null, m.scroll); if (!enabled) close(); pins(); }
    if (m.type === 'annotation-result' && m.requestId === submission?.requestId) {
      clearTimeout(submission.timer); const targetId = submission.targetId; submission = null;
      $('comment').readOnly = false; $('add').disabled = false; $('run').disabled = false;
      if (m.ok) { drafts.delete(targetId); close(false); $('status').textContent = '输入会自动暂存，关闭后可继续。'; }
      else { $('status').textContent = m.error || '未提交，文字已保留。'; $('comment').focus(); }
    }
    if (m.type === 'open-note' && enabled) choose(elements.get(m.targetId), true, m.noteId, true);
    if (m.type === 'close') close();
  });
  addEventListener('scroll', layout, true); addEventListener('resize', layout); send('ready');
})();
