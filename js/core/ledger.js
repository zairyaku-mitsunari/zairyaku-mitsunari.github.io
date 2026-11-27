// 集計・検索・項目（Swift版の Ledger / LedgerStore の参照部分と同じ規則）
import { inRange } from './date.js';

export const live = (list) => list.filter((x) => x.deletedAt == null);
export const includesScope = (filter, scope) => filter === 'all' || filter === scope;
export const newestFirst = (a, b) => (a.day !== b.day ? (a.day > b.day ? -1 : 1)
  : a.createdAt !== b.createdAt ? b.createdAt - a.createdAt : a.id > b.id ? -1 : 1);

export function inPeriod(data, range, scope = 'all') {
  return live(data.transactions).filter((t) => inRange(t.day, range) && includesScope(scope, t.scope));
}

/** 振替とカード引き落としは数えない。返金は返金日の支出を減らす。 */
export function summary(data, range, scope = 'all') {
  let income = 0;
  let expense = 0;
  for (const t of inPeriod(data, range, scope)) {
    if (t.kind === 'income') income += t.amount;
    else if (t.kind === 'expense') expense += t.amount;
    else if (t.kind === 'refund') expense -= t.amount;
  }
  return { income, expense, net: income - expense };
}

export function expenseByCategory(data, range, scope = 'all') {
  const sums = new Map();
  for (const t of inPeriod(data, range, scope)) {
    if (t.kind !== 'expense' && t.kind !== 'refund') continue;
    const key = t.categoryID ?? '';
    sums.set(key, (sums.get(key) ?? 0) + (t.kind === 'refund' ? -t.amount : t.amount));
  }
  return [...sums].filter(([, amount]) => amount !== 0)
    .map(([categoryID, amount]) => ({ categoryID, amount }))
    .sort((a, b) => b.amount - a.amount || (a.categoryID < b.categoryID ? -1 : 1));
}

export function cardUsage(data, range, scope = 'all', cardID = null) {
  return inPeriod(data, range, scope).filter((t) => t.cardID && (!cardID || t.cardID === cardID))
    .reduce((sum, t) => sum + (t.kind === 'expense' ? t.amount : t.kind === 'refund' ? -t.amount : 0), 0);
}

const inOrder = (a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1);

export function groups(data, kind, includeHidden = false) {
  return live(data.categories).filter((c) => c.kind === kind && c.isGroup && (includeHidden || !c.isHidden)).sort(inOrder);
}

export function items(data, kind, parentID, includeHidden = false) {
  const liveGroups = new Set(groups(data, kind, true).map((g) => g.id));
  return live(data.categories).filter((c) => c.kind === kind && !c.isGroup && (includeHidden || !c.isHidden)
    && (parentID ? c.parentID === parentID : !c.parentID || !liveGroups.has(c.parentID))).sort(inOrder);
}

export function selectable(data, kind) {
  return [...groups(data, kind).flatMap((g) => items(data, kind, g.id)), ...items(data, kind, null)];
}

export const find = (list, id) => list.find((x) => x.id === id);

/** 不明金の項目（固定の番号は Swift版の DefaultData と同じ） */
export const UNKNOWN = { name: '不明金', ids: { expense: '4D495453-0000-4000-8000-000200000253', income: '4D495453-0000-4000-8000-000100000110' } };

export function isUnknownCategory(data, id) {
  if (id === UNKNOWN.ids.expense || id === UNKNOWN.ids.income) return true;
  const category = find(data.categories, id);
  return !!category && !category.isGroup && category.name === UNKNOWN.name;
}

/** 不明金の項目がないデータに足す（同じ名前の項目があれば足さない）。保存は、次に何かを変えたとき。 */
export function addUnknownCategories(data, defaults) {
  for (const kind of ['income', 'expense']) {
    const exists = data.categories.some((c) => c.id === UNKNOWN.ids[kind])
      || live(data.categories).some((c) => c.kind === kind && !c.isGroup && c.name === UNKNOWN.name);
    const template = defaults.categories.find((c) => c.id === UNKNOWN.ids[kind]);
    if (!exists && template) data.categories.push({ ...template });
  }
  return data;
}
export const categoryName = (data, id) => find(data.categories, id)?.name ?? '未分類';
export function categoryPath(data, id) {
  const parent = find(data.categories, find(data.categories, id)?.parentID);
  return parent ? `${parent.name} › ${categoryName(data, id)}` : categoryName(data, id);
}
export const kindTitle = { income: '収入', expense: '支出', refund: '返金', transfer: '振替', cardPayment: 'カード引き落とし' };
export const entryTitle = (data, t) => (['transfer', 'cardPayment'].includes(t.kind) ? kindTitle[t.kind] : categoryName(data, t.categoryID));
export function sourceName(data, t) {
  const account = (id) => find(data.accounts, id)?.name ?? '未入力';
  if (t.kind === 'transfer') return `${account(t.accountID)} → ${account(t.destinationAccountID)}`;
  if (t.kind === 'cardPayment') return `${account(t.accountID)} → ${find(data.cards, t.cardID)?.name ?? '未入力'}`;
  return find(data.cards, t.cardID)?.name ?? find(data.accounts, t.accountID)?.name ?? '未入力';
}

export function search(data, list, keyword) {
  const word = keyword.trim().toLowerCase();
  if (!word) return list;
  return list.filter((t) => [t.storeName, t.memo, categoryPath(data, t.categoryID), sourceName(data, t), String(t.amount)]
    .some((text) => text && text.toLowerCase().includes(word)));
}
