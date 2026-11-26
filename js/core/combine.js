// 何回かの読み取り結果を、金額のつじつまを手がかりに1つにする。
// 値は、どれかの読み取りで実際に読めたものだけを使う（計算で作らない）。
import { payableAmounts } from './receipt.js';

const sumOf = (parsed) => payableAmounts(parsed.items, parsed.discount, parsed.addedTax).reduce((a, b) => a + b, 0);
export const matches = (parsed) => parsed.total != null && parsed.items.length > 0 && sumOf(parsed) === parsed.total;

/** 読み取りの確からしさ（点が高いほど良い） */
export function quality(parsed) {
  if (parsed.kind === 'statement') return 10 + parsed.rows.length;
  return (parsed.total != null ? 4 : 0) + (parsed.day ? 3 : 0) + (matches(parsed) ? 6 : 0) + Math.min(parsed.items.length, 30) * 0.1;
}

/** 多くの読み取りで一致した値（同数なら先の読み取り） */
function common(values) {
  const counts = new Map();
  for (const v of values) if (v != null) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** 何回かの読み取り結果を1つにする */
export function combine(parsedList) {
  const best = [...parsedList].sort((a, b) => quality(b) - quality(a))[0];
  if (best.kind === 'statement') return best;
  const result = { ...best };
  // ある読み取りの内訳の合計が、どれかの読み取りの合計と一致すれば、その組み合わせを使う
  const totals = parsedList.map((p) => p.total).filter((t) => t != null);
  if (!matches(result)) {
    for (const candidate of parsedList) {
      const total = totals.find((t) => candidate.items.length && sumOf(candidate) === t);
      if (total !== undefined) { Object.assign(result, { items: candidate.items, discount: candidate.discount, addedTax: candidate.addedTax, includedTax: candidate.includedTax, total }); break; }
    }
  }
  if (!matches(result)) result.total = common(totals) ?? result.total;
  result.day = common(parsedList.map((p) => p.day));
  result.storeName = result.storeName ?? common(parsedList.map((p) => p.storeName));
  result.payment = result.payment ?? common(parsedList.map((p) => p.payment));
  return result;
}
