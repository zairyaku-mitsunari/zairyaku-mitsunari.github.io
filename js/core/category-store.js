// 項目の追加・名前の変更・分類・非表示・削除（Swift版の LedgerStore と同じ規則。IDは変えない）
import { Store, LedgerError } from './store.js';
import { find, live, groups, items } from './ledger.js';

export const NECESSITY = { essential: '必要不可欠な支出', investment: '将来への投資', enrich: '生活を充実させる支出', review: '見直し可能な支出', waste: '不要な支出の候補' };

const compact = (object) => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== null && v !== undefined));

/** この項目を使っているもの */
export function categoryUsage(data, id) {
  const count = (list) => live(list).filter((x) => x.categoryID === id).length;
  return { entries: count(data.transactions), recurring: count(data.recurringCosts), incomes: count(data.incomeSources), budgets: count(data.budgets) };
}
export const usageTotal = (data, id) => Object.values(categoryUsage(data, id)).reduce((a, b) => a + b, 0);

function target(data, id) {
  const record = live(data.categories).find((c) => c.id === id);
  if (!record) throw new LedgerError('対象の項目が見つかりません。');
  return record;
}

function checkName(data, name, kind, isGroup, id) {
  if (!name) throw new LedgerError('名前を入力してください。');
  if (live(data.categories).some((c) => c.id !== id && c.kind === kind && c.isGroup === isGroup && c.name === name)) throw new LedgerError('同じ名前の項目がすでにあります。');
}

const siblings = (data, c) => (c.isGroup ? groups(data, c.kind, true) : items(data, c.kind, find(data.categories, c.parentID)?.deletedAt == null ? c.parentID : null, true));

Object.assign(Store.prototype, {
  addGroup(kind, name) {
    return this.commit((data) => {
      const trimmed = String(name ?? '').trim();
      checkName(data, trimmed, kind, true, null);
      const time = this.now();
      const record = { id: this.uuid(), kind, name: trimmed, sortOrder: Math.max(-1, ...groups(data, kind, true).map((c) => c.sortOrder)) + 1,
        isHidden: false, isGroup: true, isFavorite: false, createdAt: time, updatedAt: time };
      data.categories.push(record);
      return record;
    });
  },

  /** changes にある欄だけを変える：name・parentID・defaultScope・costNature・necessity */
  updateCategory(id, changes) {
    return this.commit((data) => {
      const old = target(data, id);
      const next = { ...old };
      if ('name' in changes) next.name = String(changes.name ?? '').trim();
      checkName(data, next.name, old.kind, old.isGroup, id);
      if (!old.isGroup && 'parentID' in changes) {
        next.parentID = changes.parentID || null;
        if (next.parentID && !groups(data, old.kind, true).some((g) => g.id === next.parentID)) throw new LedgerError('大項目の指定が正しくありません。');
        if ((next.parentID ?? null) !== (old.parentID ?? null)) {
          next.sortOrder = Math.max(-1, ...items(data, old.kind, next.parentID, true).map((c) => c.sortOrder)) + 1;
        }
      }
      if ('defaultScope' in changes) next.defaultScope = changes.defaultScope || null;
      if (old.kind === 'expense' && !old.isGroup) {
        if ('costNature' in changes) next.costNature = changes.costNature || null;
        if ('necessity' in changes) {
          if (changes.necessity && !NECESSITY[changes.necessity]) throw new LedgerError('分類を選んでください。');
          next.necessity = changes.necessity || null;
        }
      }
      next.updatedAt = this.now();
      data.categories[data.categories.indexOf(old)] = compact(next);
    });
  },

  setCategoryHidden(id, hidden) {
    return this.commit((data) => Object.assign(target(data, id), { isHidden: hidden, updatedAt: this.now() }));
  },

  /** 同じ階層の中で上下に1つ動かす */
  moveCategory(id, step) {
    return this.commit((data) => {
      const record = target(data, id);
      const list = siblings(data, record);
      const from = list.findIndex((c) => c.id === id);
      const to = from + step;
      if (to < 0 || to >= list.length) return;
      [list[from], list[to]] = [list[to], list[from]];
      const time = this.now();
      list.forEach((c, order) => { if (c.sortOrder !== order) Object.assign(c, { sortOrder: order, updatedAt: time }); });
    });
  },

  /** 使っている項目は、移し替え先を指定しないと削除できない（記録は消えない） */
  deleteCategory(id, replacementID = null) {
    return this.commit((data) => {
      const record = target(data, id);
      const time = this.now();
      if (record.isGroup) {
        if (items(data, record.kind, id, true).length) throw new LedgerError('中に項目がある大項目は削除できません。先に項目を移すか削除してください。');
      } else if (replacementID) {
        const other = live(data.categories).find((c) => c.id === replacementID);
        if (!other || other.id === id || other.isGroup || other.kind !== record.kind) throw new LedgerError('移し替え先には、同じ種類の別の項目を選んでください。');
      } else {
        const count = usageTotal(data, id);
        if (count) throw new LedgerError(`この項目は${count}件の記録や設定で使われています。移し替え先の項目を選んでください。`);
      }
      Object.assign(record, { deletedAt: time, updatedAt: time });
      if (!replacementID) return;
      // 削除済みの記録も移す（「元に戻す」をしても項目が残るように）
      for (const list of [data.transactions, data.recurringCosts, data.incomeSources, data.budgets, data.itemRules]) {
        for (const item of list) if (item.categoryID === id) Object.assign(item, { categoryID: replacementID, updatedAt: time });
      }
    });
  },
});
