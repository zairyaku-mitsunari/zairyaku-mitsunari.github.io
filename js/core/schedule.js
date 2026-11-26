// 固定費・サブスク・保険・負債の予定と集計（Swift版の Schedule と同じ規則）
import { addDays, addMonths, monthDay, monthOf, parts } from './date.js';
import { live, find } from './ledger.js';
import { bills } from './finance.js';

export const KINDS = { fixed: '固定費', subscription: 'サブスク', insurance: '保険', loan: '負債・ローン' };
export const CYCLES = { monthly: '毎月', everyTwoMonths: '2か月ごと', quarterly: '3か月ごと', halfYearly: '半年ごと', yearly: '年1回', once: '一括（1回だけ）' };
export const CYCLE_MONTHS = { monthly: 1, everyTwoMonths: 2, quarterly: 3, halfYearly: 6, yearly: 12, once: null };
export const ACCOUNT_TYPES = { cash: '現金', bank: '普通預金', savings: '貯蓄口座', timeDeposit: '定期預金', emoney: '電子マネー', paypay: 'PayPay', securities: '証券口座', other: 'その他' };
export const USAGE = { daily: 'ほぼ毎日', weekly: '週に数回', monthly: '月に数回', rarely: 'ほとんど使わない' };
export const INSURANCE = {
  life: '生命保険', wholeLife: '終身保険', term: '定期保険', incomeProtection: '収入保障保険', medical: '医療保険', cancer: 'がん保険', majorDisease: '三大疾病保険',
  car: '自動車保険', compulsoryCar: '自賠責保険', fire: '火災保険', earthquake: '地震保険', education: '学資保険', pension: '個人年金保険', nursing: '介護保険', injury: '傷害保険', pet: 'ペット保険', other: 'その他',
};

/** 指定日までの予定（古い順）。解約・停止したものは作らない。 */
export function occurrences(cost, end) {
  if (!cost.isActive || cost.deletedAt != null) return [];
  const last = cost.endDay && cost.endDay < end ? cost.endDay : end;
  const step = CYCLE_MONTHS[cost.cycle];
  const day = parts(cost.firstDueDay)[2];
  const result = [];
  for (let i = 0; i < 1200; i++) {
    const due = monthDay(addMonths(monthOf(cost.firstDueDay), i * (step ?? 0)), day);
    if (due > last) break;
    result.push({ recurringID: cost.id, dueDay: due, dueMonth: monthOf(due) });
    if (step == null) break;
  }
  return result;
}

/** 支払い済み・見送りの判定。つないだ支出が削除されていれば未払いに戻る。 */
export function status(data, occurrence) {
  const record = live(data.recurringPayments).filter((p) => p.recurringID === occurrence.recurringID && p.dueMonth === occurrence.dueMonth).at(-1);
  if (!record) return { type: 'unpaid' };
  if (record.isSkipped) return { type: 'skipped' };
  if (record.entryID && live(data.transactions).some((t) => t.id === record.entryID)) return { type: 'paid', entryID: record.entryID };
  return { type: 'unpaid' };
}

export function unpaid(data, end, include = () => true) {
  return data.recurringCosts.filter(include).flatMap((c) => occurrences(c, end)).filter((o) => status(data, o).type === 'unpaid')
    .sort((a, b) => (a.dueDay !== b.dueDay ? (a.dueDay < b.dueDay ? -1 : 1) : a.recurringID < b.recurringID ? -1 : 1));
}

export const nextUnpaid = (data, cost, today) => occurrences(cost, addDays(today, 800)).find((o) => status(data, o).type === 'unpaid') ?? null;

/** 予定額の合計。一括払いは年額に含めない。月額は換算値。 */
export function plannedTotal(costs, today) {
  const result = { yearly: 0, monthly: 0, unknown: 0, count: 0 };
  for (const cost of live(costs)) {
    if (!cost.isActive || (cost.endDay && cost.endDay < today)) continue;
    result.count += 1;
    const months = CYCLE_MONTHS[cost.cycle];
    if (months == null) continue;
    if (cost.plannedAmount != null) result.yearly += cost.plannedAmount * (12 / months);
    else result.unknown += 1;
  }
  result.monthly = Math.floor((result.yearly + 6) / 12);
  return result;
}

/** 負債の元本残高。基準の残高が未入力なら null。 */
export function loanBalance(data, cost) {
  const loan = cost.loan;
  if (!loan || loan.principalBalance == null) return null;
  let amount = loan.principalBalance;
  let missing = 0;
  for (const record of live(data.recurringPayments)) {
    if (record.recurringID !== cost.id || !record.entryID) continue;
    const entry = live(data.transactions).find((t) => t.id === record.entryID);
    if (!entry || (loan.balanceDay && entry.day < loan.balanceDay)) continue;
    if (record.principal != null) amount -= record.principal; else missing += 1;
  }
  return { amount: Math.max(0, amount), missing };
}

export function liabilities(data) {
  let cards = 0, loans = 0, unknownLoans = 0;
  for (const card of live(data.cards)) cards += bills(data, card).filter((b) => !b.settled).reduce((s, b) => s + b.remaining, 0);
  for (const cost of live(data.recurringCosts).filter((c) => c.kind === 'loan')) {
    const balance = loanBalance(data, cost);
    if (balance) loans += balance.amount; else unknownLoans += 1;
  }
  return { cards, loans, unknownLoans, total: cards + loans };
}

export const isLinked = (data, entryID) => live(data.recurringPayments).some((p) => p.entryID === entryID);
export const paymentMethod = (data, cost) => find(data.cards, cost.cardID)?.name ?? find(data.accounts, cost.accountID)?.name ?? '未入力';
