// 残高・カード請求・集計期間（Swift版の Balances / Billing / Payroll と同じ規則）
import { addDays, addMonths, monthDay, monthOf, monthRange, inRange } from './date.js';
import { shiftDay } from './holidays.js';
import { live } from './ledger.js';

export function basisSource(data) {
  const active = live(data.incomeSources).filter((s) => s.isActive);
  const chosen = active.find((s) => s.id === data.settings.basisSourceID);
  if (data.settings.periodBasis === 'closing') {
    return chosen?.closingDay != null ? chosen : active.find((s) => s.closingDay != null);
  }
  return chosen ?? active[0];
}

export const effectiveBasis = (data) => (data.settings.periodBasis === 'custom' ? 'custom' : basisSource(data) ? data.settings.periodBasis : 'calendar');

/** 「month 度」の集計期間 */
export function periodRange(month, data) {
  const source = basisSource(data);
  const { periodBasis: basis, periodFollowsShift: follows, paydayLabel: label, periodStartDay = 1 } = data.settings;
  if (basis === 'custom') { // その月の指定日から翌月の指定日の前日まで
    const first = label === 'end' ? addMonths(month, -1) : month;
    return { start: monthDay(first, periodStartDay), end: addDays(monthDay(addMonths(first, 1), periodStartDay), -1) };
  }
  if (!source || basis === 'calendar') return monthRange(month);
  if (basis === 'payday') {
    const start = (m) => { const nominal = monthDay(m, source.payDay); return follows ? shiftDay(nominal, source.shift) : nominal; };
    const first = label === 'end' ? addMonths(month, -1) : month;
    return { start: start(first), end: addDays(start(addMonths(first, 1)), -1) };
  }
  if (source.closingDay == null) return monthRange(month);
  return { start: addDays(monthDay(addMonths(month, -1), source.closingDay), 1), end: monthDay(month, source.closingDay) };
}

export function monthContaining(day, data) {
  const base = monthOf(day);
  return [0, -1, 1, -2, 2].map((n) => addMonths(base, n)).find((m) => inRange(day, periodRange(m, data))) ?? base;
}

/** 口座の残高。初期残高が未入力なら null。 */
export function balance(data, account, asOf) {
  if (account.openingBalance == null) return null;
  return live(data.transactions).reduce((total, t) => {
    if (t.day > asOf || (account.openingDay && t.day < account.openingDay)) return total;
    let result = total;
    if (t.accountID === account.id) result += t.kind === 'income' || t.kind === 'refund' ? t.amount : -t.amount;
    if (t.kind === 'transfer' && t.destinationAccountID === account.id) result += t.amount;
    return result;
  }, account.openingBalance);
}

export function totalAssets(data, asOf, include = () => true) {
  let amount = null;
  let unknown = 0;
  for (const account of live(data.accounts).filter(include)) {
    const value = balance(data, account, asOf);
    if (value != null) amount = (amount ?? 0) + value;
    else if (!account.isArchived) unknown += 1;
  }
  return { amount, unknown };
}

export const isConfigured = (card) => card.closingDay != null && card.paymentDay != null && card.paymentMonthOffset != null;
/** 締め月の締め日、利用期間の初日、計算上の引き落とし日 */
export const closingDate = (card, month) => monthDay(month, card.closingDay);
export const periodStart = (card, month) => addDays(monthDay(addMonths(month, -1), card.closingDay), 1);
export const nominalPaymentDate = (card, month) => monthDay(addMonths(month, card.paymentMonthOffset), card.paymentDay);

export function bills(data, card) {
  if (!isConfigured(card)) return [];
  const usage = new Map();
  const paid = new Map();
  const bump = (map, key, value) => map.set(key, (map.get(key) ?? 0) + value);
  for (const t of live(data.transactions)) {
    if (t.cardID !== card.id) continue;
    if (t.kind === 'expense' || t.kind === 'refund') {
      const month = monthOf(t.day);
      const closing = t.day <= monthDay(month, card.closingDay) ? month : addMonths(month, 1);
      bump(usage, closing, t.kind === 'refund' ? -t.amount : t.amount);
    } else if (t.kind === 'cardPayment' && t.billingMonth) bump(paid, t.billingMonth, t.amount);
  }
  const statements = live(data.statements).filter((s) => s.cardID === card.id);
  const months = [...new Set([...usage.keys(), ...paid.keys(), ...statements.map((s) => s.closingMonth)])].sort();
  return months.map((month) => {
    const statement = statements.find((s) => s.closingMonth === month);
    const used = usage.get(month) ?? 0;
    const confirmed = statement?.confirmedAmount ?? null;
    const done = paid.get(month) ?? 0;
    const remaining = Math.max(0, (confirmed ?? used) - done);
    return {
      month, usage: used, confirmed, paid: done, remaining,
      paymentDay: statement?.paymentDayOverride ?? monthDay(addMonths(month, card.paymentMonthOffset), card.paymentDay),
      settled: remaining === 0 && (done > 0 || confirmed != null || used <= 0),
    };
  });
}

export function nextWithdrawal(data, today) {
  const upcoming = live(data.cards).flatMap((card) => bills(data, card))
    .filter((b) => !b.settled && b.remaining > 0 && b.paymentDay >= today);
  if (!upcoming.length) return null;
  const day = upcoming.map((b) => b.paymentDay).sort()[0];
  const same = upcoming.filter((b) => b.paymentDay === day);
  return { day, amount: same.reduce((s, b) => s + b.remaining, 0), isEstimate: same.some((b) => b.confirmed == null) };
}
