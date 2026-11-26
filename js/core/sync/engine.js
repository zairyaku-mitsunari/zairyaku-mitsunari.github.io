// 同期の手順。通信の結果で端末の記録を消さない。成功していないのに「成功」としない。
import { parseLedger } from '../store.js';
import { seal, open, context, deriveKeys } from './crypto.js';
import { mergeSync, indexOf, sameData, reviewItems, revertTo, shrink, liveCounts } from './merge3.js';

export const MESSAGES = {
  network: '置き場に接続できません。端末の記録はそのままです。後でもう一度試します。',
  auth: '認証できません。同期キーを確認してください。',
  unregistered: '置き場がまだ登録されていません。',
  registered: '置き場は、別の同期キーで登録されています。',
  setup: '管理用の番号が違います。',
  quota: '今日の回数の上限に達しました。明日（日本時間の午前9時以降）に再開します。',
  full: '置き場の容量の上限に達しました。古い原本の整理が必要です。',
  size: '1回に送れる大きさを超えました。',
  clock: 'この端末の時刻がずれています。日付と時刻の自動設定を確認してください。',
  rollback: '置き場の内容が、前回より古くなっています。取り込まずに止めました。',
  tamper: '置き場の内容を開けません（改ざん・破損・鍵の違い）。取り込まずに止めました。',
  newer: '別の端末の新しい版のアプリで作られた内容です。この端末のアプリを更新してください。',
  busy: '別の端末の書き込みが続いたため、終わりませんでした。後でもう一度試します。',
  server: '置き場で問題が起きました。後でもう一度試します。',
};
export class SyncError extends Error {
  constructor(code) { super(MESSAGES[code] ?? MESSAGES.server); this.code = code; }
}

const text = new TextEncoder();
const CLOCK_LIMIT = 10 * 60 * 1000;

/**
 * send(method, path, headers, body) → Response のようなもの { status, headers.get, json(), arrayBuffer() }
 * session：端末に保存する同期の状態 { vault, token, key, version, base, counts, conflicts, suspects, dismissed, lastSyncAt, lastError }
 */
export class SyncEngine {
  constructor({ store, send, session, saveSession, now = () => Date.now() }) {
    Object.assign(this, { store, send, session, saveSession, now });
    this.running = null;
  }

  static async create(raw) {
    const { key, token, vault } = await deriveKeys(raw);
    return { vault, token, key, version: 0, base: null, counts: null, conflicts: [], suspects: [], dismissed: [], lastSyncAt: null, lastError: null };
  }

  async request(method, path, { headers = {}, body = null, allow = [] } = {}) {
    let response;
    try {
      response = await this.send(method, path, { authorization: `Bearer ${this.session.token}`, 'x-vault': this.session.vault, ...headers }, body);
    } catch { throw new SyncError('network'); }
    if (response.status === 200 || allow.includes(response.status)) return response;
    let code = null;
    try { code = (await response.json()).error; } catch { /* 本文がない */ }
    const known = { auth: 'auth', unregistered: 'unregistered', registered: 'registered', setup: 'setup', quota: 'quota', full: 'full', size: 'size' }[code];
    throw new SyncError(known ?? (response.status === 429 ? 'quota' : 'server'));
  }

  async register(setupCode) { await this.request('POST', '/v1/register', { headers: { 'x-setup-code': setupCode } }); }
  async state() { return (await this.request('GET', '/v1/state')).json(); }

  /** 指定の版の記録を取り出して復号する */
  async download(version) {
    const response = await this.request('GET', `/v1/ledger?version=${version}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let plain;
    try { plain = await open(this.session.key, bytes, context(this.session.vault, 'ledger', 'ledger', version)); }
    catch { throw new SyncError('tamper'); }
    const json = new TextDecoder().decode(plain);
    try { return parseLedger(json); }
    catch { let schema = 0; try { schema = JSON.parse(json).schemaVersion; } catch { /* 壊れた内容 */ } throw new SyncError(schema > this.store.data.schemaVersion ? 'newer' : 'tamper'); }
  }

  /** 置き場の内容をすべて消す（同期キーをなくした・漏れたとき）。管理用の番号が要る。端末の記録は変えない。 */
  async destroy(setupCode) {
    const response = await this.request('DELETE', '/v1/vault', { headers: { 'x-setup-code': setupCode }, allow: [403] });
    if (response.status === 403) throw new SyncError('setup');
  }

  /** 同時に2回走らせない */
  sync(options = {}) {
    this.running ??= this.run(options).finally(() => { this.running = null; });
    return this.running;
  }

  async run({ allowShrink = false } = {}) {
    const session = this.session;
    try {
      let state = await this.state();
      if (Math.abs(state.time - this.now()) > CLOCK_LIMIT) throw new SyncError('clock');
      if (state.version < session.version) throw new SyncError('rollback');
      for (let attempt = 0; attempt < 4; attempt++) {
        const remote = state.version > 0 ? await this.download(state.version) : null;
        if (remote && !allowShrink) {
          const lost = shrink(session.counts, remote);
          if (lost.length) {
            await this.save({ lastError: { code: 'held', message: '置き場の内容が、前回より大きく減っています。確認するまで取り込みません。', at: this.now() } });
            return { status: 'held', lost };
          }
        }
        let merged = null;
        const applied = await this.store.applySync((local) => {
          merged = remote ? mergeSync(local, remote, session.base) : { data: local, conflicts: [], suspects: [], added: 0, updated: 0 };
          return merged.data;
        });
        // この版までは取り込んだので覚えておく（送信に失敗しても、次に偽の競合を出さない）
        if (remote) { await this.remember(merged); await this.save({ base: indexOf(remote), version: state.version }); }
        await this.exchangeFiles(applied, state.files);
        let version = state.version;
        if (!remote || !sameData(applied, remote)) {
          const sealed = await seal(session.key, text.encode(JSON.stringify(applied)), context(session.vault, 'ledger', 'ledger', state.version + 1), { compress: true });
          const response = await this.request('PUT', '/v1/ledger', { headers: { 'x-base-version': String(state.version), 'content-type': 'application/octet-stream' }, body: sealed, allow: [409] });
          if (response.status === 409) { // ほかの端末が先に書いた：合わせ直す
            state = await this.state();
            continue;
          }
          version = (await response.json()).version;
        }
        await this.remember(merged);
        // 前回は使っていて、利用者が削除した原本は、置き場からも消す
        const used = [...new Set(applied.receipts.flatMap((r) => r.files))];
        for (const name of (this.session.files ?? []).filter((n) => !used.includes(n))) await this.request('DELETE', `/v1/files/${name}`);
        await this.save({ version, base: indexOf(applied), counts: liveCounts(applied), files: used, lastSyncAt: this.now(), lastError: null });
        return { status: 'ok', version, added: merged.added, updated: merged.updated, conflicts: merged.conflicts.length };
      }
      throw new SyncError('busy');
    } catch (error) {
      const code = error.code ?? 'server';
      await this.save({ lastError: { code, message: error instanceof SyncError ? error.message : `同期できませんでした：${error.message}`, at: this.now() } }).catch(() => {});
      return { status: 'error', code, message: this.session.lastError?.message ?? error.message };
    }
  }

  /** 原本：端末にだけあるものを送り、足りないものを受け取る。原本は消さない。 */
  async exchangeFiles(data, serverFiles) {
    const wanted = [...new Set(data.receipts.flatMap((r) => r.files))];
    const mine = new Set((await this.store.persistence.fileSizes()).map((f) => f.name));
    const theirs = new Set(serverFiles);
    for (const name of wanted) {
      const aad = context(this.session.vault, 'file', name);
      if (mine.has(name) && !theirs.has(name)) {
        const content = await this.store.persistence.file(name);
        await this.request('PUT', `/v1/files/${name}`, { headers: { 'content-type': 'application/octet-stream' }, body: await seal(this.session.key, new Uint8Array(content), aad) });
      } else if (!mine.has(name) && theirs.has(name)) {
        const sealed = new Uint8Array(await (await this.request('GET', `/v1/files/${name}`)).arrayBuffer());
        let plain;
        try { plain = await open(this.session.key, sealed, aad); } catch { throw new SyncError('tamper'); }
        await this.store.persistence.saveFiles([{ name, data: plain.slice().buffer }]);
      }
    }
  }

  /** 競合の控えと、二重登録の疑いを覚える */
  async remember(merged) {
    const at = this.now();
    const known = new Set(this.session.conflicts.map((c) => `${c.list}/${c.id}/${JSON.stringify(c.discarded)}`));
    const conflicts = [...this.session.conflicts, ...merged.conflicts.filter((c) => !known.has(`${c.list}/${c.id}/${JSON.stringify(c.discarded)}`)).map((c) => ({ ...c, at }))].slice(-200);
    const pairs = new Map([...this.session.suspects, ...merged.suspects].map((p) => [[...p].sort().join(':'), p]));
    await this.save({ conflicts, suspects: [...pairs.values()].slice(-200) });
  }

  async save(changes) {
    Object.assign(this.session, changes);
    await this.saveSession(this.session);
  }

  /** バックアップで置き換えた後は、置き場の新しい内容を優先して合わせ直す（古い内容を広げない） */
  reset() { return this.save({ base: null, counts: null }); }

  reviews() { return reviewItems(this.store.data, this.session.suspects).filter((r) => !this.session.dismissed.includes(r.key)); }
  dismiss(key) { return this.save({ dismissed: [...this.session.dismissed, key].slice(-500) }); }

  /** 競合で採らなかった内容に戻す（今の変更として、ほかの端末にも伝わる） */
  async restoreConflict(index) {
    const conflict = this.session.conflicts[index];
    if (!conflict) return;
    await this.store.applySync((data) => {
      const value = { ...conflict.discarded, updatedAt: this.now() };
      if (conflict.list === 'settings') return { ...data, settings: value };
      return { ...data, [conflict.list]: data[conflict.list].map((x) => (x.id === conflict.id ? value : x)) };
    }, 'before-restore');
    await this.resolveConflict(index);
  }
  resolveConflict(index) { return this.save({ conflicts: this.session.conflicts.filter((_, i) => i !== index) }); }

  /** 置き場の過去の版に戻す。今の状態は控えに残る。 */
  async restoreVersion(version) {
    const snapshot = await this.download(version);
    let changed = 0;
    await this.store.applySync((data) => { const result = revertTo(data, snapshot, this.now()); changed = result.changed; return result.data; }, 'before-restore');
    return changed;
  }
}

/** 公開した置き場に送る方法（接続先が設定されたときだけ使う） */
export const httpSend = (endpoint) => (method, path, headers, body) => fetch(endpoint + path, { method, headers, body, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
