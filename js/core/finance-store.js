// 口座・カード・固定費などの追加と編集（Swift版の FinanceStore と同じ規則）
import { Store, LedgerError } from './store.js';
import { find, live } from './ledger.js';
import { isDay } from './date.js';
import { MAXIMUM } from './money.js';
import { CYCLES, KINDS, ACCOUNT_TYPES, INSURANCE, status, isLinked } from './schedule.js';

const compact = (object) => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== null && v !== undefined));
const text = (v) => String(v ?? '').trim();
const amountOK = (v, { zero = false, negative = false } = {}) => v == null || (Number.isInteger(v) && Math.abs(v) <= MAXIMUM && (negative || v >= 0) && (zero || v !== 0));
const usable = (list, id) => live(list).some((x) => x.id === id && !x.isArchived);
const nextOrder = (list) => Math.max(-1, ...list.map((x) => x.sortOrder)) + 1;

function record(list, id, message) {
  const found = list.find((x) => x.id === id && x.deletedAt == null);
  if (!found) throw new LedgerError(message);
  return found;
}

function replace(list, value) {
  const index = list.findIndex((x) => x.id === value.id);
  if (index < 0) list.push(value); else list[index] = value;
}

function checkName(list, name, id) {
  if (!name) throw new LedgerError('名前を入力してください。');
  if (live(list).some((x) => x.id !== id && x.name === name)) throw new LedgerError('同じ名前のものがすでにあります。');
}

Object.assign(Store.prototype, {
  /** id がなければ追加 */
  saveAccount(draft, id = null) {
    return this.commit((data) => {
      const old = id ? record(data.accounts, id, '選んだ口座が見つかりません。') : null;
      const name = text(draft.name);
      checkName(data.accounts, name, id);
      if (!ACCOUNT_TYPES[draft.type]) throw new LedgerError('口座の種類を選んでください。');
      const balance = draft.openingBalance ?? null;
      if (!amountOK(balance, { zero: true, negative: true })) throw new LedgerError('金額が正しくありません。');
      if (draft.openingDay && !isDay(draft.openingDay)) throw new LedgerError('日付が正しくありません。');
      const time = this.now();
      const value = compact({
        ...(old ?? { id: this.uuid(), sortOrder: nextOrder(data.accounts), createdAt: time }),
        name, type: draft.type, openingBalance: balance, openingDay: balance == null ? null : draft.openingDay || null,
        isArchived: draft.isArchived ?? old?.isArchived ?? false, updatedAt: time,
      });
      replace(data.accounts, value);
      return value;
    });
  },

  saveCard(draft, id = null) {
    return this.commit((data) => {
      const old = id ? record(data.cards, id, '選んだカードが見つかりません。') : null;
      const name = text(draft.name);
      checkName(data.cards, name, id);
      let { closingDay = null, paymentDay = null, paymentMonthOffset = null } = draft;
      if (closingDay == null && paymentDay == null) paymentMonthOffset = null;
      else {
        const dayOK = (d) => Number.isInteger(d) && d >= 1 && d <= 31;
        if (!dayOK(closingDay) || !dayOK(paymentDay) || ![0, 1, 2].includes(paymentMonthOffset) || (paymentMonthOffset === 0 && paymentDay <= closingDay)) {
          throw new LedgerError('締め日と引き落とし日は、引き落とし月と合わせて入力してください。当月払いの引き落とし日は締め日より後にします。');
        }
      }
      if (draft.withdrawalAccountID && !usable(data.accounts, draft.withdrawalAccountID) && draft.withdrawalAccountID !== old?.withdrawalAccountID) throw new LedgerError('選んだ口座が見つかりません。');
      if (!amountOK(draft.creditLimit, { zero: true }) || !amountOK(draft.annualFee, { zero: true })) throw new LedgerError('金額が正しくありません。');
      const time = this.now();
      const value = compact({
        ...(old ?? { id: this.uuid(), sortOrder: nextOrder(data.cards), createdAt: time }),
        name, closingDay, paymentDay, paymentMonthOffset, withdrawalAccountID: draft.withdrawalAccountID || null,
        creditLimit: draft.creditLimit ?? null, annualFee: draft.annualFee ?? null, isArchived: draft.isArchived ?? old?.isArchived ?? false, updatedAt: time,
      });
      replace(data.cards, value);
      return value;
    });
  },

  /** 実際の請求額（と引き落とし日）を確定・修正する。両方 null で未確定に戻る。 */
  setStatement(cardID, closingMonth, confirmedAmount = null, paymentDayOverride = null) {
    return this.commit((data) => {
      record(data.cards, cardID, '選んだカードが見つかりません。');
      if (!amountOK(confirmedAmount, { zero: true })) throw new LedgerError('金額が正しくありません。');
      upsertStatement(data, cardID, closingMonth, confirmedAmount, paymentDayOverride, this);
    });
  },

  saveTransfer({ from, to, amount, day, memo = '' }, id = null, { alongside } = {}) {
    return this.commit((data) => {
      if (!(Number.isInteger(amount) && amount > 0 && amount <= MAXIMUM)) throw new LedgerError('金額は1円以上の整数で入力してください。');
      if (!from || !to) throw new LedgerError('口座を選んでください。');
      if (from === to) throw new LedgerError('振替元と振替先には別の口座を選んでください。');
      if (!find(data.accounts, from) || !find(data.accounts, to)) throw new LedgerError('選んだ口座が見つかりません。');
      if (!isDay(day ?? '')) throw new LedgerError('日付を指定してください。');
      const old = id ? record(data.transactions, id, '対象の記録が見つかりません。') : null;
      const time = this.now();
      const value = compact({
        ...(old ?? { id: this.uuid(), kind: 'transfer', scope: 'personal', storeName: '', createdAt: time }),
        accountID: from, destinationAccountID: to, amount, day, memo: text(memo), updatedAt: time,
      });
      if (!old) alongside?.(data, value, time);
      replace(data.transactions, value);
      return value;
    });
  },

  /** カードの引き落としを記録する。confirms なら、この金額を確定請求額にする。 */
  saveCardPayment({ cardID, closingMonth, accountID, amount, day, memo = '', confirms = false }, id = null) {
    return this.commit((data) => {
      if (!(Number.isInteger(amount) && amount > 0 && amount <= MAXIMUM)) throw new LedgerError('金額は1円以上の整数で入力してください。');
      record(data.cards, cardID, '選んだカードが見つかりません。');
      if (!accountID) throw new LedgerError('口座を選んでください。');
      if (!find(data.accounts, accountID)) throw new LedgerError('選んだ口座が見つかりません。');
      if (!isDay(day ?? '')) throw new LedgerError('日付を指定してください。');
      const old = id ? record(data.transactions, id, '対象の記録が見つかりません。') : null;
      const time = this.now();
      const value = compact({
        ...(old ?? { id: this.uuid(), kind: 'cardPayment', scope: 'personal', storeName: '', cardID, billingMonth: closingMonth, createdAt: time }),
        accountID, amount, day, memo: text(memo), updatedAt: time,
      });
      replace(data.transactions, value);
      if (confirms) {
        const existing = live(data.statements).find((s) => s.cardID === cardID && s.closingMonth === closingMonth);
        upsertStatement(data, cardID, closingMonth, amount, existing?.paymentDayOverride ?? null, this);
      }
      return value;
    });
  },

  saveRecurring(draft, id = null) {
    return this.commit((data) => {
      const old = id ? record(data.recurringCosts, id, '対象の固定費が見つかりません。') : null;
      const kind = draft.kind;
      if (!KINDS[kind]) throw new LedgerError('種類が正しくありません。');
      const name = text(draft.name);
      if (!name) throw new LedgerError('名前を入力してください。');
      if (draft.plannedAmount != null && !(amountOK(draft.plannedAmount) && draft.plannedAmount > 0)) throw new LedgerError('金額は1円以上の整数で入力してください。');
      if (!CYCLES[draft.cycle]) throw new LedgerError('支払い周期を選んでください。');
      if (!isDay(draft.firstDueDay ?? '')) throw new LedgerError('最初の支払い予定日を指定してください。');
      if (draft.endDay && (!isDay(draft.endDay) || draft.endDay < draft.firstDueDay)) throw new LedgerError('終了日は、最初の支払い予定日より後にしてください。');
      if (draft.accountID && draft.cardID) throw new LedgerError('口座とカードは同時に指定できません。');
      if (draft.categoryID) {
        const category = find(data.categories, draft.categoryID);
        if (!category || category.isGroup || category.kind !== 'expense') throw new LedgerError('支出の項目を選んでください。');
      }
      const time = this.now();
      const value = compact({
        ...(old ?? { id: this.uuid(), createdAt: time }),
        kind, name, categoryID: draft.categoryID || null, plannedAmount: draft.plannedAmount ?? null, cycle: draft.cycle,
        firstDueDay: draft.firstDueDay, endDay: draft.endDay || null, isActive: draft.isActive ?? true, scope: draft.scope ?? 'personal',
        accountID: draft.accountID || null, cardID: draft.cardID || null, memo: text(draft.memo), updatedAt: time,
        subscription: kind === 'subscription' ? subscriptionDetail(draft.subscription) : null,
        insurance: kind === 'insurance' ? insuranceDetail(draft.insurance) : null,
        loan: kind === 'loan' ? loanDetail(draft.loan) : null,
      });
      replace(data.recurringCosts, value);
      return value;
    });
  },

  /** 予定を削除する。支払い済みの支出の記録は残る。 */
  deleteRecurring(id) {
    return this.commit((data) => {
      const value = record(data.recurringCosts, id, '対象の固定費が見つかりません。');
      value.deletedAt = value.updatedAt = this.now();
    });
  },

  /** 支払いを記録する（支出を1件作り、この回につなぐ。1回の保存でまとめる） */
  payRecurring(occurrence, draft, principal = null) {
    return this.commit((data) => {
      checkUnpaid(data, occurrence);
      if (draft.kind !== 'expense') throw new LedgerError('支出の記録を選んでください。');
      checkPrincipal(principal, draft.amount);
      this.validate(data, draft);
      const time = this.now();
      const entry = compact({ id: this.uuid(), ...this.fields(draft), createdAt: time, updatedAt: time });
      data.transactions.push(entry);
      upsertPayment(data, occurrence, { entryID: entry.id, isSkipped: false, principal }, this);
      return entry;
    });
  },

  /** すでに登録した支出を、この回の支払いにする（二重に記録しないため） */
  linkRecurring(occurrence, entryID, principal = null) {
    return this.commit((data) => {
      checkUnpaid(data, occurrence);
      const entry = live(data.transactions).find((t) => t.id === entryID);
      if (!entry || entry.kind !== 'expense') throw new LedgerError('支出の記録を選んでください。');
      if (isLinked(data, entryID)) throw new LedgerError('この支出は、別の支払い予定に使われています。');
      checkPrincipal(principal, entry.amount);
      upsertPayment(data, occurrence, { entryID, isSkipped: false, principal }, this);
    });
  },

  /** 「今回は払わない」を取り消して、予定に戻す */
  unskipRecurring(occurrence) {
    return this.commit((data) => {
      const records = live(data.recurringPayments).filter((p) => p.recurringID === occurrence.recurringID && p.dueMonth === occurrence.dueMonth && p.isSkipped);
      if (!records.length) throw new LedgerError('取り消せる記録がありません。');
      const time = this.now();
      for (const record of records) Object.assign(record, { deletedAt: time, updatedAt: time });
    });
  },

  skipRecurring(occurrence) {
    return this.commit((data) => {
      checkUnpaid(data, occurrence);
      upsertPayment(data, occurrence, { entryID: null, isSkipped: true, principal: null }, this);
    });
  },
});

function upsertStatement(data, cardID, closingMonth, confirmedAmount, paymentDayOverride, store) {
  const time = store.now();
  const old = live(data.statements).find((s) => s.cardID === cardID && s.closingMonth === closingMonth);
  if (old) replace(data.statements, compact({ ...old, confirmedAmount, paymentDayOverride, updatedAt: time }));
  else if (confirmedAmount != null || paymentDayOverride) {
    data.statements.push(compact({ id: store.uuid(), cardID, closingMonth, confirmedAmount, paymentDayOverride, createdAt: time, updatedAt: time }));
  }
}

function checkUnpaid(data, occurrence) {
  if (!live(data.recurringCosts).some((c) => c.id === occurrence.recurringID)) throw new LedgerError('対象の固定費が見つかりません。');
  if (status(data, occurrence).type !== 'unpaid') throw new LedgerError('この回はすでに支払い済みです。');
}

function checkPrincipal(principal, amount) {
  if (principal != null && !(Number.isInteger(principal) && principal >= 0 && principal <= amount)) throw new LedgerError('元本は0円以上、支払額以下で入力してください。');
}

function upsertPayment(data, occurrence, fields, store) {
  const time = store.now();
  const old = live(data.recurringPayments).find((p) => p.recurringID === occurrence.recurringID && p.dueMonth === occurrence.dueMonth);
  const base = old ?? { id: store.uuid(), recurringID: occurrence.recurringID, dueMonth: occurrence.dueMonth, createdAt: time };
  replace(data.recurringPayments, compact({ ...base, ...fields, updatedAt: time }));
}

const optionalAmount = (v) => { if (!amountOK(v, { zero: true })) throw new LedgerError('金額が正しくありません。'); return v ?? null; };
const optionalDay = (v) => { if (v && !isDay(v)) throw new LedgerError('日付が正しくありません。'); return v || null; };

function subscriptionDetail(d = {}) {
  return compact({ plan: text(d.plan), trialEndDay: optionalDay(d.trialEndDay), purpose: text(d.purpose), usage: d.usage || null });
}
function insuranceDetail(d = {}) {
  const type = d.type ?? 'life';
  if (!INSURANCE[type]) throw new LedgerError('保険の種類を選んでください。');
  const strings = Object.fromEntries(['customType', 'company', 'policyholder', 'insured', 'target', 'coverage', 'riders', 'exclusions', 'contact'].map((k) => [k, text(d[k])]));
  return compact({ type, ...strings, coverageAmount: optionalAmount(d.coverageAmount), surrenderValue: optionalAmount(d.surrenderValue), renewalDay: optionalDay(d.renewalDay), reviewDay: optionalDay(d.reviewDay) });
}
function loanDetail(d = {}) {
  const rate = d.annualRateMilli ?? null;
  if (rate != null && !(Number.isInteger(rate) && rate >= 0 && rate <= 100999)) throw new LedgerError('年利が正しくありません。');
  return compact({ lender: text(d.lender), borrowedAmount: optionalAmount(d.borrowedAmount), borrowedDay: optionalDay(d.borrowedDay), annualRateMilli: rate,
    principalBalance: optionalAmount(d.principalBalance), balanceDay: optionalDay(d.balanceDay) });
}
