// 給料日・入金の予定と、給料日までの見通し（Swift版の Payroll と同じ規則）
import { addDays, addMonths, daysBetween, inRange, monthDay, monthOf, parts, isDay } from './date.js';
import { shiftDay } from './holidays.js';
import { live, find } from './ledger.js';
import { bills, totalAssets } from './finance.js';
import { unpaid } from './schedule.js';
import { Store, LedgerError } from './store.js';
import { MAXIMUM } from './money.js';

export const SHIFTS = { none: '変更なし', previous: '前の営業日', next: '次の営業日' };
export const BASES = { calendar: '暦の月（1日〜月末）', custom: '指定した日から', payday: '給料日から', closing: '会社の締め日まで' };

/** 期間内（支給日が range に入る）の給料と賞与の予定。古い順。 */
export function occurrences(source, range) {
  if (!source.isActive || source.deletedAt != null) return [];
  const result = [];
  let month = addMonths(monthOf(range.start > source.startDay ? range.start : source.startDay), -1);
  const last = addMonths(monthOf(range.end), 1);
  for (let steps = 0; month <= last && steps < 600; steps++, month = addMonths(month, 1)) {
    const add = (day, amount, bonusID) => {
      const nominal = monthDay(month, day);
      const actual = shiftDay(nominal, source.shift);
      if (nominal >= source.startDay && inRange(actual, range)) {
        result.push({ sourceID: source.id, month, bonusID, nominalDay: nominal, day: actual, expectedAmount: amount ?? null });
      }
    };
    add(source.payDay, source.expectedAmount, null);
    for (const bonus of source.bonuses) if (bonus.month === parts(month)[1]) add(bonus.day, bonus.expectedAmount, bonus.id);
  }
  return result.sort(order);
}
const order = (a, b) => (a.day !== b.day ? (a.day < b.day ? -1 : 1) : `${a.sourceID}${a.month}${a.bonusID}` < `${b.sourceID}${b.month}${b.bonusID}` ? -1 : 1);

export function status(data, occurrence) {
  const record = live(data.incomeReceipts).filter((r) => r.sourceID === occurrence.sourceID && r.month === occurrence.month
    && (r.bonusID ?? null) === occurrence.bonusID).at(-1);
  if (!record) return { type: 'pending' };
  if (record.isSkipped) return { type: 'skipped' };
  if (record.entryID && live(data.transactions).some((t) => t.id === record.entryID)) return { type: 'received', entryID: record.entryID };
  return { type: 'pending' };
}

export const pending = (data, range) => data.incomeSources.flatMap((s) => occurrences(s, range)).filter((o) => status(data, o).type === 'pending').sort(order);
export const nextPayday = (data, today) => pending(data, { start: today, end: addDays(today, 100) }).find((o) => !o.bonusID) ?? null;

/** 給料日までの見通し（予定からの目安）。給料の予定がなければ null。 */
export function outlook(data, today) {
  const payday = nextPayday(data, today);
  if (!payday) return null;
  const before = addDays(payday.day, -1);
  const until = before > today ? before : today;
  // カード払いの固定費は、カードの引き落とし日に口座から出るので、ここでは数えない（二重計上の防止）
  const due = unpaid(data, before).map((o) => find(data.recurringCosts, o.recurringID)).filter((c) => c && !c.cardID);
  const cards = live(data.cards).flatMap((c) => bills(data, c))
    .filter((b) => !b.settled && b.remaining > 0 && b.paymentDay < payday.day).reduce((s, b) => s + b.remaining, 0);
  const liquid = ['cash', 'bank', 'emoney', 'paypay', 'other'];
  const balance = totalAssets(data, until, (a) => liquid.includes(a.type));
  const days = Math.max(0, daysBetween(today, payday.day));
  const scheduled = cards + due.reduce((s, c) => s + (c.plannedAmount ?? 0), 0);
  const available = balance.amount == null ? null : balance.amount - scheduled;
  return { payday, daysLeft: days, scheduled, unknownCount: due.filter((c) => c.plannedAmount == null).length, balance: balance.amount,
    unknownAccounts: balance.unknown, available, isShort: (available ?? 0) < 0,
    perDay: available == null ? null : Math.floor(Math.max(0, available) / Math.max(1, days)) };
}

export const isReceiptLinked = (data, entryID) => live(data.incomeReceipts).some((r) => r.entryID === entryID);

const compact = (object) => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== null && v !== undefined));
const dayChoice = (d) => Number.isInteger(d) && d >= 1 && d <= 32;
const amountOK = (v) => v == null || (Number.isInteger(v) && v > 0 && v <= MAXIMUM);

function upsertReceipt(store, data, occurrence, entryID, skipped, time) {
  const record = live(data.incomeReceipts).find((r) => r.sourceID === occurrence.sourceID && r.month === occurrence.month && (r.bonusID ?? null) === occurrence.bonusID);
  if (record) {
    if (entryID) record.entryID = entryID; else delete record.entryID;
    Object.assign(record, { isSkipped: skipped, updatedAt: time });
  } else {
    data.incomeReceipts.push(compact({ id: store.uuid(), sourceID: occurrence.sourceID, month: occurrence.month, bonusID: occurrence.bonusID,
      entryID, isSkipped: skipped, createdAt: time, updatedAt: time }));
  }
}

function checkPending(data, occurrence) {
  if (!live(data.incomeSources).some((s) => s.id === occurrence.sourceID)) throw new LedgerError('対象の勤務先が見つかりません。');
  if (status(data, occurrence).type !== 'pending') throw new LedgerError('この回は、すでに記録されています。');
}

Object.assign(Store.prototype, {
  saveIncomeSource(draft, id = null) {
    return this.commit((data) => {
      const old = id ? live(data.incomeSources).find((s) => s.id === id) : null;
      if (id && !old) throw new LedgerError('対象の勤務先が見つかりません。');
      const name = String(draft.name ?? '').trim();
      if (!name) throw new LedgerError('名前を入力してください。');
      const bonuses = (draft.bonuses ?? []).map((b) => compact({ id: b.id ?? this.uuid(), month: b.month, day: b.day, expectedAmount: b.expectedAmount }));
      if (!dayChoice(draft.payDay) || (draft.closingDay != null && !dayChoice(draft.closingDay))
        || !bonuses.every((b) => b.month >= 1 && b.month <= 12 && dayChoice(b.day))) throw new LedgerError('日付の指定が正しくありません。');
      if (![draft.expectedAmount, ...bonuses.map((b) => b.expectedAmount)].every(amountOK)) throw new LedgerError('金額は1円以上の整数で入力してください。');
      if (!isDay(draft.startDay ?? '')) throw new LedgerError('予定を作り始める日を指定してください。');
      if (!SHIFTS[draft.shift]) throw new LedgerError('休日の扱いを選んでください。');
      if (draft.categoryID) {
        const c = live(data.categories).find((x) => x.id === draft.categoryID);
        if (!c || c.isGroup || c.kind !== 'income') throw new LedgerError('収入の項目を選んでください。');
      }
      const time = this.now();
      const value = compact({ ...(old ?? { id: this.uuid(), createdAt: time }), name, payDay: draft.payDay, closingDay: draft.closingDay ?? null, shift: draft.shift,
        expectedAmount: draft.expectedAmount ?? null, accountID: draft.accountID || null, categoryID: draft.categoryID || null, scope: draft.scope ?? 'personal',
        bonuses, startDay: draft.startDay, isActive: draft.isActive ?? true, updatedAt: time });
      const index = data.incomeSources.findIndex((s) => s.id === value.id);
      if (index < 0) data.incomeSources.push(value); else data.incomeSources[index] = value;
      return value;
    });
  },

  /** 勤務先の設定を削除する。受け取った収入の記録は残る。 */
  deleteIncomeSource(id) {
    return this.commit((data) => {
      const record = live(data.incomeSources).find((s) => s.id === id);
      if (!record) throw new LedgerError('対象の勤務先が見つかりません。');
      record.deletedAt = record.updatedAt = this.now();
    });
  },

  /** 集計期間の設定。記録は変わらない。 */
  saveSettings(changes) {
    return this.commit((data) => {
      const next = { ...data.settings, ...changes, updatedAt: this.now() };
      if (!BASES[next.periodBasis]) throw new LedgerError('集計期間の区切り方を選んでください。');
      if (!['start', 'end'].includes(next.paydayLabel)) throw new LedgerError('月度の呼び方を選んでください。');
      if (!dayChoice(next.periodStartDay ?? 1)) throw new LedgerError('開始日の指定が正しくありません。');
      if (!next.basisSourceID) delete next.basisSourceID;
      data.settings = next;
    });
  },

  /** 実際の入金を記録する（収入を1件作り、この回につなぐ） */
  receiveIncome(occurrence, input) {
    return this.commit((data) => {
      checkPending(data, occurrence);
      if (input.kind !== 'income') throw new LedgerError('収入として記録してください。');
      const draft = this.normalized(data, input);
      this.validate(data, draft);
      const time = this.now();
      const entry = compact({ id: this.uuid(), ...this.fields(draft), createdAt: time, updatedAt: time });
      data.transactions.push(entry);
      upsertReceipt(this, data, occurrence, entry.id, false, time);
      return entry;
    });
  },

  linkIncome(occurrence, entryID) {
    return this.commit((data) => {
      checkPending(data, occurrence);
      if (!live(data.transactions).some((t) => t.id === entryID && t.kind === 'income')) throw new LedgerError('収入の記録を選んでください。');
      if (isReceiptLinked(data, entryID)) throw new LedgerError('この記録は、すでに別の回につながっています。');
      upsertReceipt(this, data, occurrence, entryID, false, this.now());
    });
  },

  skipIncome(occurrence) {
    return this.commit((data) => { checkPending(data, occurrence); upsertReceipt(this, data, occurrence, null, true, this.now()); });
  },
});
