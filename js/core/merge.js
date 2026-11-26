// 2つの端末のデータを合わせる。記録を消さず、同じIDは更新日時が新しい方を採用する（削除も新しければ反映）。
import { daysBetween } from './date.js';

export const LISTS = ['categories', 'accounts', 'cards', 'transactions', 'statements', 'recurringCosts', 'recurringPayments', 'incomeSources', 'incomeReceipts', 'receipts', 'itemRules',
  'budgets', 'goals', 'goalDeposits', 'improvements', 'councils', 'consultations'];

const same = (a, b) => JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort());

/**
 * 取り込み側にだけある支出・収入で、この端末に同じ金額・同じ種類・近い日付の別の記録があるもの。
 * 両方の端末で同じ支払いを登録した可能性がある。
 */
export function suspectedDuplicates(local, incoming) {
  const ids = new Set(local.transactions.map((t) => t.id));
  const used = new Set(incoming.transactions.map((t) => t.id)); // 両方にある記録は同じものなので候補にしない
  const result = [];
  for (const t of incoming.transactions) {
    if (ids.has(t.id) || t.deletedAt != null) continue;
    const match = local.transactions.find((o) => o.deletedAt == null && !used.has(o.id) && o.kind === t.kind && o.amount === t.amount && Math.abs(daysBetween(o.day, t.day)) <= 1);
    if (match) { used.add(match.id); result.push({ incoming: t, local: match }); }
  }
  return result;
}

/** include：疑わしくても追加する取り込み側の記録ID */
export function mergeLedgers(local, incoming, { include = [] } = {}) {
  const suspects = suspectedDuplicates(local, incoming);
  const skipped = new Set(suspects.map((s) => s.incoming.id).filter((id) => !include.includes(id)));
  // 追加しない支出への返金も追加しない
  for (const t of incoming.transactions) if (t.refundOfID && skipped.has(t.refundOfID)) skipped.add(t.id);
  const data = { ...local, schemaVersion: local.schemaVersion };
  const counts = { added: 0, updated: 0, kept: 0, skipped: skipped.size };
  for (const key of LISTS) {
    const merged = new Map(local[key].map((x) => [x.id, x]));
    for (const item of incoming[key]) {
      if (key === 'transactions' && skipped.has(item.id)) continue;
      // 追加しない支出につながる支払い・入金の記録も追加しない
      if ((key === 'recurringPayments' || key === 'incomeReceipts') && item.entryID && skipped.has(item.entryID)) continue;
      const mine = merged.get(item.id);
      if (!mine) { merged.set(item.id, item); counts.added += 1; }
      else if (!same(mine, item)) {
        if ((item.updatedAt ?? 0) > (mine.updatedAt ?? 0)) { merged.set(item.id, item); counts.updated += 1; } else counts.kept += 1;
      }
    }
    data[key] = [...merged.values()];
  }
  if ((incoming.settings.updatedAt ?? 0) > (local.settings.updatedAt ?? 0)) data.settings = incoming.settings;
  return { data, counts, suspects };
}
