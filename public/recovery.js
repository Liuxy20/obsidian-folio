// Each page writes its own checkpoint. A restored checkpoint is only removed
// if its revision still matches, so another window's newer work survives.
export class RecoveryStore {
  constructor(name = 'folio-recovery-v1') { this.name = name; this.connection = null; }
  async open() {
    if (!this.connection) this.connection = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('drafts', { keyPath: 'key' });
        store.createIndex('documentId', 'documentId');
      };
      request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); this.connection = null; }; resolve(db); };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('草稿存储被其他页面占用。'));
    }).catch(error => { this.connection = null; throw error; });
    return this.connection;
  }
  async transaction(mode, operation) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('drafts', mode); let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('自动草稿事务未完成。'));
      try { operation(tx.objectStore('drafts'), value => { result = value; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  }
  async list(documentId) {
    return this.transaction('readonly', (store, done) => {
      const request = store.index('documentId').getAll(documentId);
      request.onsuccess = () => done(request.result.sort((a, b) => b.updatedAt - a.updatedAt));
    });
  }
  async put(record) { await this.transaction('readwrite', store => store.put(record)); return record; }
  async remove(references) {
    await this.transaction('readwrite', store => {
      for (const ref of references) {
        const request = store.get(ref.key);
        request.onsuccess = () => { if (request.result?.revision === ref.revision) store.delete(ref.key); };
      }
    });
  }
}
