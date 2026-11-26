// データの窓口。変更のたびに保存し、保存に失敗したら画面上の変更も取り消す。
// 保存形式は Swift版（版6）と同じ。分からない欄はそのまま残し、空の値は欄ごと省く。
import { isDay } from './date.js';
import { MAXIMUM, yen } from './money.js';
import { find, live, selectable, items, groups } from './ledger.js';
import { redact } from './receipt.js';
import { itemKey } from './classify.js';
import { mergeLedgers, LISTS } from './merge.js';

export const SCHEMA_VERSION = 6;
/** 版6で増えた一覧 */
export const NEW_IN_6 = ['budgets', 'goals', 'goalDeposits', 'improvements', 'councils', 'consultations'];

export class LedgerError extends Error {}

/** 保存文字列を検査して読み込む。読めないものは例外（上書きしないため） */
export function parseLedger(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new LedgerError('データを読み込めません。ファイルが壊れているか、形式が違います。'); }
  if (!data || typeof data.schemaVersion !== 'number') throw new LedgerError('財略三成のデータではありません。');
  if (data.schemaVersion > SCHEMA_VERSION) throw new LedgerError('新しい版で作られたデータです。アプリを更新してください。');
  if (data.schemaVersion < 5) throw new LedgerError('古い版のデータです。Mac版（0.5.0以降）で一度開いてから、書き出してください。');
  if (data.schemaVersion === 5) { // 版5 → 版6：一覧が増えただけ。既存の記録は変えない。
    for (const key of NEW_IN_6) data[key] ??= [];
    data.schemaVersion = 6;
  }
  for (const key of LISTS) if (!Array.isArray(data[key])) throw new LedgerError(`データに「${key}」がありません。`);
  if (!data.settings) throw new LedgerError('データに設定がありません。');
  for (const t of data.transactions) {
    if (!t.id || !isDay(t.day) || !Number.isInteger(t.amount) || t.amount <= 0 || !t.kind || !t.scope) {
      throw new LedgerError('取引の記録に正しくないものがあります。');
    }
  }
  return data;
}

export function defaultUUID() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().toUpperCase();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const compact = (object) => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== null && v !== undefined));

export class Store {
  constructor(persistence, defaults, { now = () => Date.now(), uuid = defaultUUID } = {}) {
    this.persistence = persistence;
    this.defaults = defaults;
    this.now = now;
    this.uuid = uuid;
    this.data = null;
    this.failure = null;
    this.queue = Promise.resolve();
    this.onChange = null; // 利用者の操作で保存した後に呼ぶ（同期のきっかけ）
  }

  async load() {
    try {
      const text = await this.persistence.load();
      if (text == null) {
        const seeded = JSON.parse(JSON.stringify(this.defaults));
        await this.persistence.save(JSON.stringify(seeded));
        this.data = seeded;
      } else {
        const data = parseLedger(text);
        // 版を上げるときは、直前の状態を控えに残してから保存する
        const old = JSON.parse(text).schemaVersion;
        if (old < data.schemaVersion) {
          // 版を上げても、記録の件数と内容が変わらないことを確かめてから保存する
          const before = JSON.parse(text);
          for (const [key, list] of Object.entries(before)) {
            if (Array.isArray(list) && JSON.stringify(data[key]) !== JSON.stringify(list)) throw new LedgerError('データの引き継ぎで内容が変わるため、中止しました。データは変更していません。');
          }
          await this.persistence.save(JSON.stringify(data), { keepAs: `before-upgrade-v${old}` });
        }
        this.data = data;
      }
      this.failure = null;
    } catch (error) {
      this.failure = error.message;
      this.data = null;
    }
    return this;
  }

  /** 変更は順番に実行する。保存できた場合だけ画面のデータを置き換える。 */
  commit(change) {
    const run = async () => {
      if (!this.data) throw new LedgerError('データを読み込めなかったため、変更できません。');
      const next = JSON.parse(JSON.stringify(this.data));
      const result = change(next);
      await this.persistence.save(JSON.stringify(next));
      this.data = next;
      this.onChange?.();
      return result;
    };
    const task = this.queue.then(run);
    this.queue = task.catch(() => {});
    return task;
  }

  refunded(data, id) {
    return live(data.transactions).filter((t) => t.kind === 'refund' && t.refundOfID === id).reduce((s, t) => s + t.amount, 0);
  }

  /** 返金は、元の支出の項目と区分にそろえる。ほかの種類には返金の元を付けない。 */
  normalized(data, draft) {
    if (draft.kind !== 'refund') return { ...draft, refundOfID: null };
    const original = live(data.transactions).find((t) => t.id === draft.refundOfID && t.kind === 'expense');
    if (!original) throw new LedgerError('返金の元になる支出が見つかりません。');
    return { ...draft, categoryID: original.categoryID, scope: original.scope };
  }

  validate(data, draft, editing) {
    if (!['income', 'expense', 'refund'].includes(draft.kind)) throw new LedgerError('この種類の記録は、この画面では編集できません。');
    if (!Number.isInteger(draft.amount) || draft.amount <= 0 || draft.amount > MAXIMUM) throw new LedgerError('金額は1円以上の整数で入力してください。');
    if (!isDay(draft.day ?? '')) throw new LedgerError('日付を指定してください。');
    if (!draft.categoryID) throw new LedgerError('項目を選んでください。');
    const category = find(data.categories, draft.categoryID);
    const categoryKind = draft.kind === 'refund' ? 'expense' : draft.kind;
    if (!category || category.isGroup || category.kind !== categoryKind
      || (category.deletedAt != null && draft.categoryID !== editing?.categoryID)) throw new LedgerError('収入・支出に合った項目を選んでください。');
    if (draft.accountID && draft.cardID) throw new LedgerError('口座とカードは同時に指定できません。');
    if (draft.kind === 'income' && draft.cardID) throw new LedgerError('収入の入金先にカードは指定できません。');
    if (draft.accountID && !find(data.accounts, draft.accountID)) throw new LedgerError('選んだ口座が見つかりません。');
    if (draft.cardID && !find(data.cards, draft.cardID)) throw new LedgerError('選んだカードが見つかりません。');
    if (draft.kind === 'refund') {
      const original = live(data.transactions).find((t) => t.id === draft.refundOfID && t.kind === 'expense');
      if (!original) throw new LedgerError('返金の元になる支出が見つかりません。');
      const remaining = original.amount - this.refunded(data, original.id) + (editing?.kind === 'refund' && editing.refundOfID === original.id ? editing.amount : 0);
      if (draft.amount > remaining) throw new LedgerError(`返金できる残りの金額（${yen(remaining)}）を超えています。`);
    }
    if (editing) {
      const refunded = this.refunded(data, editing.id);
      if (refunded > 0 && (draft.kind !== 'expense' || draft.amount < refunded)) {
        throw new LedgerError(`返金の記録（${yen(refunded)}）がある支出です。先に返金を削除してください。`);
      }
    }
  }

  fields(draft) {
    return {
      kind: draft.kind, day: draft.day, amount: draft.amount, categoryID: draft.categoryID, scope: draft.scope,
      accountID: draft.accountID || null, cardID: draft.cardID || null,
      storeName: (draft.storeName ?? '').trim(), memo: (draft.memo ?? '').trim(),
      costNature: draft.kind === 'expense' ? draft.costNature || null : null, refundOfID: draft.kind === 'refund' ? draft.refundOfID : null,
    };
  }

  addTransaction(input) {
    return this.commit((data) => {
      const draft = this.normalized(data, input);
      this.validate(data, draft);
      const time = this.now();
      const record = compact({ id: this.uuid(), ...this.fields(draft), createdAt: time, updatedAt: time });
      data.transactions.push(record);
      return record;
    });
  }

  /** 返金・取消を記録する。支払い方法は、指定がなければ元の支出と同じ。 */
  addRefund(originalID, { amount, day, accountID, cardID, memo = '' }) {
    const original = this.data && live(this.data.transactions).find((t) => t.id === originalID);
    const chosen = accountID !== undefined || cardID !== undefined;
    return this.addTransaction({ kind: 'refund', refundOfID: originalID, amount, day, memo, storeName: original?.storeName ?? '',
      accountID: chosen ? accountID : original?.accountID, cardID: chosen ? cardID : original?.cardID });
  }

  updateTransaction(id, input) {
    return this.commit((data) => {
      const index = data.transactions.findIndex((t) => t.id === id && t.deletedAt == null);
      if (index < 0) throw new LedgerError('対象の記録が見つかりません。');
      const old = data.transactions[index];
      const draft = this.normalized(data, input);
      this.validate(data, draft, old);
      const record = compact({ ...old, ...this.fields(draft), updatedAt: this.now() });
      data.transactions[index] = record;
      for (const other of data.transactions) { // 返金は元の支出の項目と区分に合わせる
        if (other.refundOfID === id && (other.categoryID !== record.categoryID || other.scope !== record.scope)) {
          Object.assign(other, { categoryID: record.categoryID, scope: record.scope, updatedAt: record.updatedAt });
        }
      }
      return record;
    });
  }

  deleteTransaction(id) {
    return this.commit((data) => {
      const record = data.transactions.find((t) => t.id === id && t.deletedAt == null);
      if (!record) throw new LedgerError('対象の記録が見つかりません。');
      if (this.refunded(data, id) > 0) throw new LedgerError('返金の記録がある支出です。先に返金の記録を削除してください。');
      record.deletedAt = record.updatedAt = this.now();
    });
  }

  restoreTransaction(id) {
    return this.commit((data) => {
      const record = data.transactions.find((t) => t.id === id && t.deletedAt != null);
      if (!record) throw new LedgerError('対象の記録が見つかりません。');
      if (record.kind === 'refund') {
        const original = data.transactions.find((t) => t.id === record.refundOfID && t.deletedAt == null);
        if (!original || this.refunded(data, original.id) + record.amount > original.amount) throw new LedgerError('元の支出がないため、返金を戻せません。');
      }
      delete record.deletedAt;
      record.updatedAt = this.now();
    });
  }

  addCategory(kind, name, parentID = null) {
    return this.commit((data) => {
      const trimmed = name.trim();
      if (!trimmed) throw new LedgerError('名前を入力してください。');
      if (live(data.categories).some((c) => c.kind === kind && !c.isGroup && c.name === trimmed)) throw new LedgerError('同じ名前の項目がすでにあります。');
      if (parentID && !groups(data, kind, true).some((g) => g.id === parentID)) throw new LedgerError('大項目の指定が正しくありません。');
      const time = this.now();
      const siblings = items(data, kind, parentID, true);
      const record = compact({
        id: this.uuid(), kind, name: trimmed, sortOrder: Math.max(-1, ...siblings.map((c) => c.sortOrder)) + 1,
        isHidden: false, isGroup: false, isFavorite: false, parentID,
        costNature: kind === 'expense' ? 'variable' : null, createdAt: time, updatedAt: time,
      });
      data.categories.push(record);
      return record;
    });
  }

  setFavorite(id, favorite) {
    return this.commit((data) => {
      const record = selectable(data, find(data.categories, id)?.kind).find((c) => c.id === id);
      if (!record) throw new LedgerError('対象の項目が見つかりません。');
      Object.assign(find(data.categories, id), { isFavorite: favorite, updatedAt: this.now() });
    });
  }

  /** 確認済みのレシート・明細をまとめて1回で登録する。レシートと請求は、合計が一致しなければ登録しない。 */
  async registerDocument(receipt, drafts, { files = [], corrections = [] } = {}) {
    if (!drafts.length) throw new LedgerError('登録する内容がありません。');
    if (receipt.kind !== 'statement') {
      const sum = drafts.reduce((s, d) => s + d.amount, 0);
      if (sum !== receipt.total || drafts.some((d) => d.kind !== 'expense')) {
        throw new LedgerError(`レシートの合計と振り分けの合計が一致しません（差 ${yen(receipt.total - sum)}）。`);
      }
    }
    const saved = await this.saveOriginals(files);
    try {
      return await this.commit((data) => {
        for (const draft of drafts) this.validate(data, draft);
        const time = this.now();
        const record = this.receiptRecord(receipt, saved.map((f) => f.name), time);
        const entries = drafts.map((draft) => compact({ id: this.uuid(), ...this.fields(draft), receiptID: record.id, createdAt: time, updatedAt: time }));
        data.receipts.push(record);
        data.transactions.push(...entries);
        this.learn(data, corrections, time);
        return entries;
      });
    } catch (error) {
      await this.persistence.deleteFiles(saved.map((f) => f.name)).catch(() => {}); // 記録できなかった原本は残さない
      throw error;
    }
  }

  /** 新しい支出を作らず、登録済みの記録にレシートを付ける（二重計上の防止） */
  async attachDocument(receipt, entryIDs, files = []) {
    const saved = await this.saveOriginals(files);
    try {
      await this.commit((data) => {
        const targets = live(data.transactions).filter((t) => entryIDs.includes(t.id));
        if (!targets.length) throw new LedgerError('対象の記録が見つかりません。');
        if (targets.some((t) => t.receiptID)) throw new LedgerError('この記録には、すでにレシートが付いています。');
        const time = this.now();
        const record = this.receiptRecord(receipt, saved.map((f) => f.name), time);
        data.receipts.push(record);
        for (const t of targets) Object.assign(t, { receiptID: record.id, updatedAt: time });
      });
    } catch (error) {
      await this.persistence.deleteFiles(saved.map((f) => f.name)).catch(() => {});
      throw error;
    }
  }

  async saveOriginals(files) {
    if (!files.length || !this.data?.settings.keepsReceiptImages) return [];
    const named = files.map((f) => ({ name: `${this.uuid()}.${f.extension === 'pdf' ? 'pdf' : 'jpg'}`, data: f.data }));
    await this.persistence.saveFiles(named);
    return named;
  }

  receiptRecord(receipt, names, time) {
    return compact({
      id: this.uuid(), kind: receipt.kind, storeName: redact((receipt.storeName ?? '').trim()), day: receipt.day, total: receipt.total,
      tax: receipt.tax, discount: receipt.discount,
      lines: (receipt.lines ?? []).map((l) => compact({ name: redact(l.name), quantity: l.quantity, amount: l.amount, categoryID: l.categoryID })),
      files: names, fingerprints: receipt.fingerprints ?? [], createdAt: time, updatedAt: time,
    });
  }

  learn(data, corrections, time) {
    for (const { name, categoryID } of corrections) {
      const key = itemKey(name);
      if (!key) continue;
      const rule = live(data.itemRules).find((r) => r.key === key);
      if (rule) Object.assign(rule, { categoryID, updatedAt: time });
      else data.itemRules.push({ id: this.uuid(), key, categoryID, createdAt: time, updatedAt: time });
    }
  }

  /** 原本を削除する。支出の記録は残る。 */
  async deleteReceiptFiles(id) {
    const names = await this.commit((data) => {
      const record = data.receipts.find((r) => r.id === id);
      if (!record) throw new LedgerError('対象の記録が見つかりません。');
      const old = record.files;
      Object.assign(record, { files: [], updatedAt: this.now() });
      return old;
    });
    await this.persistence.deleteFiles(names);
  }

  /** 記録をすべて削除したのに、原本が残っているレシート */
  unlinkedReceipts() {
    const used = new Set(live(this.data.transactions).map((t) => t.receiptID));
    return this.data.receipts.filter((r) => r.files.length && !used.has(r.id));
  }

  setSetting(key, value) {
    return this.commit((data) => { data.settings = { ...data.settings, [key]: value, updatedAt: this.now() }; });
  }

  /** 別の端末の控えを合わせる（消さずに、新しい方を採用する）。原本は先に保存する。 */
  async merge(text, files = [], options = {}) {
    const incoming = parseLedger(text);
    const preview = mergeLedgers(this.data, incoming, options);
    const needed = new Set(preview.data.receipts.flatMap((r) => r.files));
    const have = new Set((await this.persistence.fileSizes()).map((f) => f.name));
    const added = files.filter((f) => needed.has(f.name) && !have.has(f.name));
    if (added.length) await this.persistence.saveFiles(added);
    const run = async () => {
      const result = mergeLedgers(this.data, incoming, options);
      parseLedger(JSON.stringify(result.data));
      await this.persistence.save(JSON.stringify(result.data), { keepAs: 'before-import' });
      this.data = result.data;
      this.onChange?.();
      return result;
    };
    const task = this.queue.then(run);
    this.queue = task.catch(() => {});
    try { return await task; } catch (error) { await this.persistence.deleteFiles(added.map((f) => f.name)).catch(() => {}); throw error; }
  }

  /**
   * 同期や復元で作った内容を反映する。順番を守り、形式を検査してから保存する。
   * 変わらなければ保存しない。反映する前の状態は keepAs の名前で控えに残す。
   */
  applySync(change, keepAs = 'before-sync') {
    const run = async () => {
      if (!this.data) throw new LedgerError('データを読み込めなかったため、変更できません。');
      const next = change(JSON.parse(JSON.stringify(this.data)));
      const text = JSON.stringify(next);
      if (text === JSON.stringify(this.data)) return this.data;
      parseLedger(text);
      await this.persistence.save(text, { keepAs });
      this.data = JSON.parse(text);
      return this.data;
    };
    const task = this.queue.then(run);
    this.queue = task.catch(() => {});
    return task;
  }

  /** 書き出し用の文字列 */
  export() { return JSON.stringify(this.data, null, 1); }

  /** 別のデータに置き換える（呼ぶ前に利用者へ確認する）。置き換える前の状態は保存側が残す。 */
  replaceAll(text, files = []) {
    const incoming = parseLedger(text);
    const run = async () => {
      if (files.length) await this.persistence.saveFiles(files);
      await this.persistence.save(JSON.stringify(incoming), { keepAs: 'before-import' });
      this.data = incoming;
      this.failure = null;
    };
    const task = this.queue.then(run);
    this.queue = task.catch(() => {});
    return task;
  }
}
