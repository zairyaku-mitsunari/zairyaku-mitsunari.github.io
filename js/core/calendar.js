// 財務カレンダー：予定と実績を日付ごとに並べ、予定から残高を見通す。
// 予定は記録ではない（支出・収入に数えない）。分からない金額は含めない。
import { addDays, addMonths, inRange, monthOf } from './date.js';
import { live, find } from './ledger.js';
import { balance, bills, isConfigured, closingDate, nominalPaymentDate } from './finance.js';
import { occurrences, status, KINDS } from './schedule.js';
import * as Pay from './payroll.js';

export const TYPES = { payday: '給料・入金', card: 'カード引き落とし', fixed: '固定費', subscription: 'サブスク', insurance: '保険料', loan: 'ローン返済', tax: '税金', contract: '更新・見直し' };
export const LIQUID = ['cash', 'bank', 'emoney', 'paypay', 'other'];

/** 税金の支払い：項目名が「〜税」か「社会保険料」（自動車税・固定資産税などは別の大項目にある） */
const isTax = (data, categoryID) => /(税|社会保険料)$/.test(find(data.categories, categoryID)?.name ?? '');
const inScope = (scope, value) => scope === 'all' || value === scope;

/** 期間内の出来事（古い順）。state: planned 予定 / overdue 予定日を過ぎて記録なし / done 実績 / skipped なし / info お知らせ */
export function events(data, range, today, scope = 'all') {
  const result = [];
  const add = (e) => { if (inRange(e.day, range)) result.push({ amount: null, flow: null, ...e }); };
  const late = (day) => (day < today ? 'overdue' : 'planned');
  const transaction = (id) => live(data.transactions).find((t) => t.id === id);

  for (const source of live(data.incomeSources).filter((s) => inScope(scope, s.scope))) {
    for (const o of Pay.occurrences(source, range)) {
      const state = Pay.status(data, o);
      const entry = state.type === 'received' ? transaction(state.entryID) : null;
      add({ day: o.day, type: 'payday', title: `${source.name}${o.bonusID ? '（賞与）' : ''}`, flow: 'in', amount: entry ? entry.amount : o.expectedAmount,
        state: entry ? 'done' : state.type === 'skipped' ? 'skipped' : late(o.day), ref: { occurrence: o } });
    }
  }
  for (const card of live(data.cards)) {
    for (const b of bills(data, card)) {
      if (b.settled && !b.paid) continue;
      add({ day: b.paymentDay, type: 'card', title: card.name, flow: 'out', amount: b.settled ? b.paid : b.remaining, state: b.settled ? 'done' : late(b.paymentDay),
        estimate: !b.settled && b.confirmed == null, ref: { cardID: card.id, month: b.month } });
    }
  }
  for (const cost of data.recurringCosts.filter((c) => c.deletedAt == null && inScope(scope, c.scope))) {
    const type = isTax(data, cost.categoryID) ? 'tax' : cost.kind;
    for (const o of occurrences(cost, range.end)) {
      if (o.dueDay < range.start) continue;
      const state = status(data, o);
      const entry = state.type === 'paid' ? transaction(state.entryID) : null;
      add({ day: o.dueDay, type, title: cost.name, flow: 'out', amount: entry ? entry.amount : cost.plannedAmount, byCard: !!cost.cardID,
        state: entry ? 'done' : state.type === 'skipped' ? 'skipped' : late(o.dueDay), ref: { occurrence: o, recurringID: cost.id } });
    }
    const info = (day, text) => day && add({ day, type: 'contract', title: `${cost.name}：${text}`, state: 'info', ref: { recurringID: cost.id } });
    if (cost.isActive && cost.insurance) { info(cost.insurance.renewalDay, '保険の更新日'); info(cost.insurance.reviewDay, '見直しの時期'); info(cost.endDay, `${KINDS[cost.kind]}の満了日`); }
    if (cost.isActive && cost.subscription) info(cost.subscription.trialEndDay, '無料期間の終了');
  }
  return result.sort((a, b) => (a.day !== b.day ? (a.day < b.day ? -1 : 1) : a.title < b.title ? -1 : 1));
}

/**
 * 現金・口座の残高の見通し（今日の残高から、予定を足し引きする）。日々の買い物などは含まない。
 * 予定日を過ぎて記録がない支払いは、今日に支払うものとして引く。カード払いの固定費は、カードの引き落とし日に引く。
 */
export function forecast(data, today, until) {
  const accounts = live(data.accounts).filter((a) => LIQUID.includes(a.type));
  const known = accounts.filter((a) => a.openingBalance != null);
  const unknownAccounts = accounts.filter((a) => a.openingBalance == null && !a.isArchived).length;
  const start = known.length ? known.reduce((s, a) => s + balance(data, a, today), 0) : null;
  const ids = new Set(known.map((a) => a.id));
  const moves = new Map();
  let unknownAmounts = 0;
  const move = (day, amount, title) => {
    const at = day < today ? today : day;
    if (at > until) return;
    const m = moves.get(at) ?? { in: 0, out: 0, items: [] };
    if (amount >= 0) m.in += amount; else m.out -= amount;
    m.items.push({ title, amount, late: day < today });
    moves.set(at, m);
  };
  const past = { start: addDays(today, -62), end: until };
  for (const e of events(data, past, today)) {
    if (e.state !== 'planned' && e.state !== 'overdue') continue;
    if (e.type === 'payday') { // 入っていないお金は、これから入る分だけ数える
      if (e.day <= today) continue;
      if (e.amount == null) unknownAmounts += 1; else move(e.day, e.amount, e.title);
    } else if (e.type === 'card') move(e.day, -e.amount, `${e.title} 引き落とし`);
    else if (e.amount == null) unknownAmounts += 1;
    else if (!e.byCard) move(e.day, -e.amount, e.title);
    else { // カード払いの予定は、そのカードの引き落とし日に引く（利用の記録がまだないので二重にならない）
      const cost = find(data.recurringCosts, e.ref.recurringID);
      const card = find(data.cards, cost.cardID);
      if (!card || !isConfigured(card)) { unknownAmounts += 1; continue; }
      const month = monthOf(e.day);
      const closing = e.day <= closingDate(card, month) ? month : addMonths(month, 1);
      const statement = live(data.statements).find((s) => s.cardID === card.id && s.closingMonth === closing);
      const day = statement?.paymentDayOverride ?? nominalPaymentDate(card, closing);
      move(day, -e.amount, `${e.title}（${card.name}の引き落とし）`);
    }
  }
  // 先の日付で記録済みの入出金（今日の残高に含まれないもの）
  for (const t of live(data.transactions).filter((x) => x.day > today && x.day <= until)) {
    let amount = 0;
    if (ids.has(t.accountID)) amount += t.kind === 'income' || t.kind === 'refund' ? t.amount : -t.amount;
    if (t.kind === 'transfer' && ids.has(t.destinationAccountID)) amount += t.amount;
    if (amount) move(t.day, amount, '記録済みの入出金');
  }
  const days = [];
  let value = start;
  for (let day = today; day <= until && days.length < 800; day = addDays(day, 1)) {
    const m = moves.get(day) ?? { in: 0, out: 0, items: [] };
    if (value != null) value += m.in - m.out;
    days.push({ day, ...m, balance: value });
  }
  return { start, days, shortage: days.find((d) => d.balance != null && d.balance < 0) ?? null, unknownAccounts, unknownAmounts };
}
