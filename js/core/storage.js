// 端末内の保存（IndexedDB）。外部には送らない。
// ・その日の最初の保存の前に、直前の状態を複製（30日分）。取り込みの前の状態も残す。
// ・別のタブで変更されていたら保存しない（古い画面で上書きしない）。
import { LedgerError } from './store.js';
import { today } from './date.js';

const BACKUP_LIMIT = 30;

export class MemoryPersistence {
  constructor() { this.text = null; this.backups = new Map(); this.files = new Map(); this.locals = new Map(); this.fail = false; }
  async local(key) { return this.locals.get(key) ?? null; }
  async setLocal(key, value) { if (this.fail) throw new Error('保存できません'); if (value == null) this.locals.delete(key); else this.locals.set(key, value); }
  async load() { return this.text; }
  async save(text, { keepAs } = {}) {
    if (this.fail) throw new Error('保存できません');
    if (this.text != null && keepAs) this.backups.set(keepAs, this.text);
    this.text = text;
  }
  async backup(key) { return this.backups.get(key) ?? null; }
  async backupKeys() { return [...this.backups.keys()]; }
  async saveFiles(list) { if (this.fail) throw new Error('保存できません'); for (const f of list) this.files.set(f.name, f.data); }
  async file(name) { return this.files.get(name) ?? null; }
  async deleteFiles(names) { for (const n of names) this.files.delete(n); }
  async fileSizes() { return [...this.files].map(([name, data]) => ({ name, size: data.byteLength ?? data.size ?? 0 })); }
}

const done = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export class IndexedDBPersistence {
  constructor(name = 'zairyaku') { this.name = name; this.revision = 0; this.db = null; }

  async open() {
    if (this.db) return this.db;
    // 版1：記録と控え。版2：レシートの原本（files）を追加。既存のものは残す。
    const request = indexedDB.open(this.name, 2);
    request.onupgradeneeded = () => {
      for (const store of ['kv', 'backups', 'files']) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
    };
    this.db = await done(request);
    this.db.onversionchange = () => { this.db.close(); this.db = null; };
    return this.db;
  }

  async load() {
    const db = await this.open();
    const tx = db.transaction(['kv', 'backups'], 'readonly');
    const [record, keys] = await Promise.all([done(tx.objectStore('kv').get('ledger')), done(tx.objectStore('backups').getAllKeys())]);
    if (!record) {
      if (keys.length) throw new LedgerError('データが見つかりませんが、控えが残っています。上書きを防ぐため停止しています。');
      this.revision = 0;
      return null;
    }
    this.revision = record.revision;
    return record.text;
  }

  async save(text, { keepAs } = {}) {
    const db = await this.open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['kv', 'backups'], 'readwrite');
      const kv = tx.objectStore('kv');
      const backups = tx.objectStore('backups');
      let conflict = false;
      kv.get('ledger').onsuccess = (event) => {
        const old = event.target.result;
        if ((old?.revision ?? 0) !== this.revision) { conflict = true; tx.abort(); return; }
        if (old && keepAs) backups.put(old.text, keepAs);
        if (old) {
          const key = `day-${today()}`;
          backups.getKey(key).onsuccess = (found) => {
            if (found.target.result === undefined) backups.put(old.text, key);
            backups.getAllKeys().onsuccess = (all) => {
              const days = all.target.result.filter((k) => String(k).startsWith('day-')).sort();
              for (const k of days.slice(0, Math.max(0, days.length - BACKUP_LIMIT))) backups.delete(k);
            };
          };
        }
        kv.put({ text, revision: this.revision + 1 }, 'ledger');
      };
      tx.oncomplete = () => { this.revision += 1; resolve(); };
      tx.onabort = tx.onerror = () => reject(conflict
        ? new LedgerError('別の画面でデータが変更されました。画面を再読み込みしてください。')
        : new LedgerError('保存できませんでした。端末の空き容量などを確認してください。'));
    });
  }

  /** この端末だけの設定（記録やバックアップには入れない） */
  async local(key) {
    const db = await this.open();
    return (await done(db.transaction('kv', 'readonly').objectStore('kv').get(`local-${key}`))) ?? null;
  }

  async setLocal(key, value) {
    const db = await this.open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      if (value == null) tx.objectStore('kv').delete(`local-${key}`); else tx.objectStore('kv').put(value, `local-${key}`);
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(new LedgerError('設定を保存できませんでした。'));
    });
  }

  async backupKeys() {
    const db = await this.open();
    return (await done(db.transaction('backups', 'readonly').objectStore('backups').getAllKeys())).map(String);
  }

  async backup(key) {
    const db = await this.open();
    return (await done(db.transaction('backups', 'readonly').objectStore('backups').get(key))) ?? null;
  }

  /** 原本の書き込み（1回の取引でまとめて。失敗したら1つも残らない） */
  async writeFiles(change) {
    const db = await this.open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite');
      change(tx.objectStore('files'));
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(new LedgerError('レシートの原本を保存できませんでした。端末の空き容量を確認してください。'));
    });
  }

  // 原本は中身（ArrayBuffer）で保存する（古い Safari でも安定するため）
  saveFiles(list) { return this.writeFiles((store) => { for (const f of list) store.put(f.data, f.name); }); }
  deleteFiles(names) { return this.writeFiles((store) => { for (const n of names) store.delete(n); }); }

  async file(name) {
    const db = await this.open();
    return (await done(db.transaction('files', 'readonly').objectStore('files').get(name))) ?? null;
  }

  async fileSizes() {
    const db = await this.open();
    const store = db.transaction('files', 'readonly').objectStore('files');
    const [names, values] = await Promise.all([done(store.getAllKeys()), done(store.getAll())]);
    return names.map((name, i) => ({ name, size: values[i].byteLength ?? values[i].size ?? 0 }));
  }
}
