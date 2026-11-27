// 何回かの読み取り結果を、金額のつじつまを手がかりに1つにする。
// 値は、どれかの読み取りで実際に読めたものだけを使う（計算で作らない）。
import { payableAmounts, totalChecks, cashPaid } from './receipt.js';

const sumOf = (parsed) => payableAmounts(parsed.items, parsed.discount, parsed.addedTax).reduce((a, b) => a + b, 0);
export const matches = (parsed) => parsed.total != null && parsed.items.length > 0 && sumOf(parsed) === parsed.total;
/** 預り金・小計などと食い違いがない */
export const consistent = (parsed) => totalChecks(parsed, parsed.total).every((c) => c.ok);

/** 読み取りの確からしさ（点が高いほど良い） */
export function quality(parsed) {
  if (parsed.kind === 'statement') return 10 + parsed.rows.length;
  return (parsed.total != null ? 4 : 0) + (parsed.day ? 3 : 0) + (matches(parsed) ? 6 : 0) + (parsed.total != null && consistent(parsed) ? 1 : 0) + Math.min(parsed.items.length, 30) * 0.1;
}

/** 多くの読み取りで一致した値（同数なら先の読み取り） */
function common(values) {
  const counts = new Map();
  for (const v of values) if (v != null) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

const sameName = (a, b) => a.replace(/\s/g, '') === b.replace(/\s/g, '');

/**
 * 商品ごとに、何回かの読み取りで実際に読めた金額の中から選び、合計と一致する組み合わせを探す。
 * 変える数がいちばん少ない組み合わせが1通りに決まるときだけ使う（どれか分からないときは直さない）。
 */
export function pickAmounts(base, others, total) {
  const used = others.map(() => new Set());
  const options = base.items.map((item) => {
    const values = [item.amount];
    others.forEach((other, k) => {
      const index = other.items.findIndex((x, i) => !used[k].has(i) && sameName(x.name, item.name));
      if (index < 0) return;
      used[k].add(index);
      if (!values.includes(other.items[index].amount)) values.push(other.items[index].amount);
    });
    // 数量×単価と同じ金額が読めていれば、それを使う
    const product = item.quantity && item.unitPrice ? item.quantity * item.unitPrice : null;
    return values.includes(product) ? [product] : values;
  });
  const open = options.map((v, i) => (v.length > 1 || v[0] !== base.items[i].amount ? i : -1)).filter((i) => i >= 0);
  if (!open.length || open.length > 14) return null;
  const items = base.items.map((item, i) => ({ ...item, amount: options[i][0] }));
  let found = null, fewest = Infinity, ties = 0, tried = 0;
  const search = (k, changes) => {
    if (changes > fewest || tried > 200_000) return;
    if (k === open.length) {
      tried += 1;
      if (sumOf({ ...base, items }) !== total) return;
      if (changes < fewest) { fewest = changes; ties = 1; found = items.map((i) => ({ ...i })); } else ties += 1;
      return;
    }
    const i = open[k];
    for (const amount of options[i]) { items[i].amount = amount; search(k + 1, changes + (amount === base.items[i].amount ? 0 : 1)); }
    items[i].amount = options[i][0];
  };
  search(0, 0);
  return found && ties === 1 && tried <= 200_000 ? found : null;
}

/** 何回かの読み取り結果を1つにする */
export function combine(parsedList) {
  const best = [...parsedList].sort((a, b) => quality(b) - quality(a))[0];
  if (best.kind === 'statement') return best;
  const result = { ...best };
  // ある読み取りの内訳の合計が、どれかの読み取りの合計と一致すれば、その組み合わせを使う
  const totals = parsedList.map((p) => p.total).filter((t) => t != null);
  const proofs = [...totals, ...parsedList.map(cashPaid).filter((t) => t != null)]; // お預り−お釣りも、合計の手がかりにする
  if (!matches(result)) {
    for (const candidate of parsedList) {
      const total = proofs.find((t) => candidate.items.length && sumOf(candidate) === t);
      if (total !== undefined) { Object.assign(result, { items: candidate.items, discount: candidate.discount, addedTax: candidate.addedTax, includedTax: candidate.includedTax, total }); break; }
    }
  }
  if (!matches(result)) {
    // 商品ごとに、読めた金額を組み合わせる
    const candidates = [...new Set(totals)].sort((a, b) => totals.filter((t) => t === b).length - totals.filter((t) => t === a).length);
    for (const source of [...parsedList].sort((a, b) => quality(b) - quality(a))) {
      const total = candidates.find((t) => source.items.length && pickAmounts(source, parsedList.filter((p) => p !== source), t));
      if (total === undefined) continue;
      Object.assign(result, { items: pickAmounts(source, parsedList.filter((p) => p !== source), total), discount: source.discount, addedTax: source.addedTax, includedTax: source.includedTax, total });
      break;
    }
  }
  if (!matches(result)) result.total = common(totals) ?? result.total;
  result.day = common(parsedList.map((p) => p.day));
  result.storeName = result.storeName ?? common(parsedList.map((p) => p.storeName));
  result.payment = result.payment ?? common(parsedList.map((p) => p.payment));
  result.venue = result.venue ?? common(parsedList.map((p) => p.venue));
  result.tendered = result.tendered ?? common(parsedList.map((p) => p.tendered));
  result.change = result.change ?? common(parsedList.map((p) => p.change));
  if (!result.payments?.length) result.payments = parsedList.find((p) => p.payments?.length)?.payments ?? [];
  return result;
}
