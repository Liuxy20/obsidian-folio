// Serialized into the trusted workbench iframe; deliberately has no imports.
export function installClient({ channel, local, initialId }) {
  const waiting = new Map(); let nextId = 0;
  const request = (route, data) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('插件响应超时，请重新打开工作台。')); }, route === 'import/file' ? 300_000 : 30_000);
    waiting.set(id, { resolve, reject, timer }); parent.postMessage({ folio: channel, id, route, data }, '*');
  });
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.folio !== channel) return;
    const { id, value, error } = event.data, pending = waiting.get(id);
    if (!pending) return; waiting.delete(id); clearTimeout(pending.timer);
    error ? pending.reject(Object.assign(new Error(error), { status: event.data.status })) : pending.resolve(value);
  });
  const session = {};
  if (initialId) session['folio.lastDocument'] = initialId;
  const storage = (data, durable) => ({
    getItem: key => data[key] ?? null,
    setItem(key, value) {
      data[key] = String(value);
      if (durable) request('storage/set', { key, value: String(value) }).catch(error => window.folioHost.onError?.(error.message));
    }
  });
  window.folioHost = {
    request, initialId, localStorage: storage(local, true), sessionStorage: storage(session, false),
    recovery: { list: documentId => request('recovery/list', { documentId }), put: record => request('recovery/put', record), remove: refs => request('recovery/remove', refs) },
    export: (source, name) => request('export', { source, name }),
    copy: text => request('clipboard', { text })
  };
}
