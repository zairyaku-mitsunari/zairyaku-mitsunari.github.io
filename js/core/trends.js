// 支出の変化・多い順・大きな支払い・ペース・店ごとの集計。記録からの計算だけで、推測で値を作らない。
import { live, summary, inPeriod, expenseByCategory, categoryName } from './ledger.js';
import { periodRange, monthContaining } from './finance.js';
import { addDays, addMonths, daysBetween } from './date.js';
import { spent } from './planning.js';

/**
 * 集計月度と、その前の月度の支出を比べる。
 * 月度の途中は、前の月度も同じ日数までで比べる（途中の月と丸1か月を比べて「減った」としない）。
 */
export function compare(data, month, scope, today) {
  const range = periodRange(month, data);
  const before = periodRange(addMonths(month, -1), data);
  const partial = today >= range.start && today < range.end;
  const days = partial ? daysBetween(range.start, today) : null;
  const current = partial ? { start: range.start, end: today } : range;
  const limit = partial ? addDays(before.start, days) : before.end;
  const previous = { start: before.start, end: limit < before.end ? limit : before.end };
  const rows = new Map();
  for (const [key, span] of [['now', current], ['past', previous]]) {
    for (const item of expenseByCategory(data, span, scope)) {
      const id = item.categoryID ?? null;
      const row = rows.get(id) ?? { categoryID: id, name: categoryName(data, id), now: 0, past: 0 };
      row[key] += item.amount;
      rows.set(id, row);
    }
  }
  const list = [...rows.values()].map((r) => ({ ...r, diff: r.now - r.past })).filter((r) => r.diff !== 0)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || a.name.localeCompare(b.name, 'ja'));
  const total = (span) => summary(data, span, scope).expense;
  return {
    current, previous, partial, now: total(current), past: total(previous), rows: list,
    /** 前の期間に記録が1件もなければ、比べない */
    comparable: inPeriod(data, previous, scope).some((t) => t.kind === 'expense' || t.kind === 'refund'),
  };
}

/** 増えた（減った）項目で、金額が大きい記録（理由をたどる手がかり） */
export function topEntries(data, range, scope, categoryID = undefined, limit = 5) {
  return inPeriod(data, range, scope).filter((t) => t.kind === 'expense' && (categoryID === undefined || t.categoryID === categoryID))
    .sort((a, b) => b.amount - a.amount || (a.day < b.day ? 1 : -1)).slice(0, limit);
}

export const ranking = (data, range, scope) => expenseByCategory(data, range, scope).filter((r) => r.amount > 0)
  .sort((a, b) => b.amount - a.amount).map((r) => ({ name: categoryName(data, r.categoryID), amount: r.amount }));

/** 記録のある店の名前（長い順） */
export const storeNames = (data) => [...new Set(live(data.transactions).map((t) => (t.storeName ?? '').trim()).filter((n) => n.length >= 2))]
  .sort((a, b) => b.length - a.length);

export function storeTotal(data, range, scope, name) {
  const found = inPeriod(data, range, scope).filter((t) => (t.storeName ?? '').trim() === name && (t.kind === 'expense' || t.kind === 'refund'));
  return { amount: found.reduce((s, t) => s + (t.kind === 'refund' ? -t.amount : t.amount), 0), count: found.filter((t) => t.kind === 'expense').length,
    entries: found.filter((t) => t.kind === 'expense').sort((a, b) => (a.day < b.day ? 1 : -1)) };
}

/** 今の月度の1日あたりの支出。始まって7日未満は見込みを出さない（ぶれが大きいため）。 */
export function pace(data, today, scope) {
  const month = monthContaining(today, data);
  const range = periodRange(month, data);
  const elapsed = daysBetween(range.start, today) + 1;
  const length = daysBetween(range.start, range.end) + 1;
  const amount = spent(data, { start: range.start, end: today }, scope);
  return { range, elapsed, length, amount, perDay: elapsed > 0 ? Math.round(amount / elapsed) : null };
}
