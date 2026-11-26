// 予算と貯蓄目標。使った金額・達成率・予測は、保存せず記録から都度計算する。
import { addDays, addMonths, daysBetween, monthOf, parts, isDay } from './date.js';
import { live, find, inPeriod } from './ledger.js';
import { periodRange, monthContaining, balance, totalAssets } from './finance.js';
import { occurrences, status } from './schedule.js';
import { Store, LedgerError } from './store.js';
import { MAXIMUM } from './money.js';

export const PERIODS = { monthly: '月間', yearly: '年間' };
export const SCOPES = { all: '全体', personal: '個人', business: '事業' };

/** 項目（大項目なら中の項目も）に当てはまるか。null は全体。 */
export function inCategory(data, categoryID, id) {
  if (!categoryID) return true;
  return id === categoryID || find(data.categories, id)?.parentID === categoryID;
}

/** 支出の合計（返金は引く） */
export function spent(data, range, scope = 'all', categoryID = null) {
  return inPeriod(data, range, scope).filter((t) => (t.kind === 'expense' || t.kind === 'refund') && inCategory(data, categoryID, t.categoryID))
    .reduce((s, t) => s + (t.kind === 'refund' ? -t.amount : t.amount), 0);
}

/** 年の期間：1月度の始まりから12月度の終わりまで */
export const yearRange = (data, year) => ({ start: periodRange(`${year}-01`, data).start, end: periodRange(`${year}-12`, data).end });

/** month に有効な予算。同じ対象では、その月だけの予算を優先する。 */
export function effectiveBudgets(data, month, scope = 'all') {
  const chosen = new Map();
  for (const b of live(data.budgets)) {
    if (scope !== 'all' && b.scope !== scope) continue;
    if (b.month && b.month !== month) continue;
    const key = `${b.period}/${b.scope}/${b.categoryID ?? ''}`;
    if (!chosen.has(key) || b.month) chosen.set(key, b);
  }
  return [...chosen.values()].sort((a, b) => a.period.localeCompare(b.period) || Number(!!a.categoryID) - Number(!!b.categoryID) || b.amount - a.amount);
}

/**
 * 期間末の支出の予測 ＝ これまでの実績 ＋ 残りの予定（金額のある固定費など）＋ 固定費以外の1日平均 × 残り日数。
 * 固定費（予定から記録したもの、区分が固定費のもの）は日割りで増やさない。
 * 期間の始まりから十分な日数がたつまでは予測しない（null）。
 */
export function forecast(data, range, scope, categoryID, today, minimumDays = 7) {
  if (today < range.start || today > range.end) return null;
  const elapsed = daysBetween(range.start, today) + 1;
  if (elapsed < minimumDays) return null;
  const total = daysBetween(range.start, range.end) + 1;
  const linked = new Set(live(data.recurringPayments).map((p) => p.entryID).filter(Boolean));
  const soFar = inPeriod(data, { start: range.start, end: today }, scope)
    .filter((t) => (t.kind === 'expense' || t.kind === 'refund') && inCategory(data, categoryID, t.categoryID));
  const sum = (list) => list.reduce((s, t) => s + (t.kind === 'refund' ? -t.amount : t.amount), 0);
  const fixed = (t) => (t.costNature ?? find(data.categories, t.categoryID)?.costNature) === 'fixed';
  const variable = Math.max(0, sum(soFar.filter((t) => !linked.has(t.id) && !fixed(t))));
  let planned = 0;
  let unknown = 0;
  for (const cost of live(data.recurringCosts)) {
    if ((scope !== 'all' && cost.scope !== scope) || !inCategory(data, categoryID, cost.categoryID)) continue;
    for (const o of occurrences(cost, range.end)) {
      if (o.dueDay < range.start || status(data, o).type !== 'unpaid') continue;
      if (cost.plannedAmount == null) unknown += 1; else planned += cost.plannedAmount;
    }
  }
  // 期間内で今日より後の日付の支出（先に入力したもの）も含める
  const future = spent(data, { start: addDays(today, 1), end: range.end }, scope, categoryID);
  const rest = Math.round((variable * (total - elapsed)) / elapsed);
  return { amount: sum(soFar) + future + planned + rest, planned, variableRest: rest, unknown, elapsed, total };
}

export function budgetStatus(data, budget, month, today) {
  const yearly = budget.period === 'yearly';
  const year = Number(month.slice(0, 4));
  const range = yearly ? yearRange(data, year) : periodRange(month, data);
  const before = yearly ? yearRange(data, year - 1) : periodRange(addMonths(month, -1), data);
  const used = spent(data, range, budget.scope, budget.categoryID);
  const predicted = forecast(data, range, budget.scope, budget.categoryID, today, yearly ? 60 : 7);
  return {
    budget, range, used, remaining: budget.amount - used, percent: Math.floor((Math.max(0, used) * 100) / budget.amount),
    over: Math.max(0, used - budget.amount), forecast: predicted, willExceed: !!predicted && predicted.amount > budget.amount && used <= budget.amount,
    previous: spent(data, before, budget.scope, budget.categoryID),
  };
}

export const budgetStatuses = (data, month, scope, today) => effectiveBudgets(data, month, scope).map((b) => budgetStatus(data, b, month, today));

export const deposits = (data, goalID) => live(data.goalDeposits).filter((d) => d.goalID === goalID).sort((a, b) => (a.day < b.day ? 1 : -1));

/** 目標の現在の状況。現在金額が分からない場合は saved が null。 */
export function goalStatus(data, goal, today) {
  const account = goal.accountID ? find(data.accounts, goal.accountID) : null;
  const list = deposits(data, goal.id);
  const saved = account ? balance(data, account, today) : list.reduce((s, d) => s + d.amount, 0);
  if (saved == null) return { goal, account, saved: null, remaining: null, percent: null, monthsLeft: null, required: null, pace: null, reachMonth: null, overdue: false };
  const remaining = Math.max(0, goal.targetAmount - saved);
  const percent = Math.floor((Math.max(0, saved) * 100) / goal.targetAmount);
  let monthsLeft = null;
  let overdue = false;
  if (goal.targetDay) {
    overdue = goal.targetDay < today && remaining > 0;
    const [ty, tm, td] = parts(goal.targetDay);
    const [y, m, d] = parts(today);
    monthsLeft = Math.max(1, (ty - y) * 12 + (tm - m) + (td >= d ? 1 : 0));
  }
  const required = remaining === 0 ? 0 : monthsLeft && !overdue ? Math.ceil(remaining / monthsLeft) : null;
  // 直近90日の増え方（実績）。記録が90日に満たないときは出さない。
  const from = addDays(today, -90);
  let pace = null;
  if (account) {
    const history = live(data.transactions).some((t) => t.day <= from && (t.accountID === account.id || t.destinationAccountID === account.id));
    if ((account.openingDay && account.openingDay <= from) || history) {
      const past = balance(data, account, from);
      if (past != null) pace = Math.floor((saved - past) / 3);
    }
  } else if (list.some((d) => d.day <= addDays(today, -60))) {
    pace = Math.floor(list.filter((d) => d.day > from && d.day <= today).reduce((s, d) => s + d.amount, 0) / 3);
  }
  const months = remaining > 0 && pace > 0 ? Math.ceil(remaining / pace) : null;
  const reachMonth = remaining === 0 ? monthOf(today) : months != null && months <= 1200 ? addMonths(monthOf(today), months) : null;
  return { goal, account, saved, remaining, percent, monthsLeft, required, pace, reachMonth, overdue };
}

export const activeGoals = (data) => live(data.goals).filter((g) => !g.isArchived).sort((a, b) => a.createdAt - b.createdAt);

/** 目標に割り当てた金額の合計と、総資産。合計が総資産を超えていれば重複の可能性がある。 */
export function allocation(data, today) {
  const states = activeGoals(data).map((g) => goalStatus(data, g, today));
  const allocated = states.reduce((s, x) => s + Math.max(0, x.saved ?? 0), 0);
  const assets = totalAssets(data, today);
  return { allocated, assets: assets.amount, unknownAccounts: assets.unknown, isOver: assets.amount != null && allocated > assets.amount };
}

/** 記録がある直近の「終わった月度」（最大3つ）の収支の平均。なければ null。 */
export function baseline(data, today, scope = 'all', count = 3) {
  const current = monthContaining(today, data);
  const months = [];
  for (let i = 1; i <= 12 && months.length < count; i++) {
    const month = addMonths(current, -i);
    const list = inPeriod(data, periodRange(month, data), scope).filter((t) => ['income', 'expense', 'refund'].includes(t.kind));
    if (!list.length) continue;
    const income = list.filter((t) => t.kind === 'income').reduce((s, t) => s + t.amount, 0);
    const expense = list.reduce((s, t) => s + (t.kind === 'expense' ? t.amount : t.kind === 'refund' ? -t.amount : 0), 0);
    months.push({ month, income, expense });
  }
  if (!months.length) return null;
  const average = (key) => Math.round(months.reduce((s, m) => s + m[key], 0) / months.length);
  return { months: months.map((m) => m.month), income: average('income'), expense: average('expense'), net: average('income') - average('expense') };
}

/** 条件を変えた試算：毎月の積立 ＝ 基準 ＋ 収入の増加 ＋ 支出の削減。届かないときは months が null。 */
export function simulate(remaining, base, extraIncome = 0, cut = 0, today) {
  const monthly = base + extraIncome + cut;
  const months = remaining <= 0 ? 0 : monthly > 0 ? Math.ceil(remaining / monthly) : null;
  return { monthly, months: months != null && months <= 1200 ? months : null, month: months != null && months <= 1200 ? addMonths(monthOf(today), months) : null };
}

// ---- 保存

const compact = (object) => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== null && v !== undefined));
const positive = (v) => Number.isInteger(v) && v > 0 && v <= MAXIMUM;
const find_ = (list, id, message) => { const r = live(list).find((x) => x.id === id); if (!r) throw new LedgerError(message); return r; };
const upsert = (list, value) => { const i = list.findIndex((x) => x.id === value.id); if (i < 0) list.push(value); else list[i] = value; return value; };

Object.assign(Store.prototype, {
  /** 同じ対象（期間・区分・項目・月）の予算があれば上書きする */
  saveBudget(draft, id = null) {
    return this.commit((data) => {
      if (!PERIODS[draft.period]) throw new LedgerError('月間か年間を選んでください。');
      if (!SCOPES[draft.scope]) throw new LedgerError('区分を選んでください。');
      if (!positive(draft.amount)) throw new LedgerError('予算は1円以上の整数で入力してください。');
      const categoryID = draft.categoryID || null;
      if (categoryID && !live(data.categories).some((c) => c.id === categoryID && c.kind === 'expense')) throw new LedgerError('支出の項目を選んでください。');
      const month = draft.period === 'monthly' ? draft.month || null : null;
      if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new LedgerError('月の指定が正しくありません。');
      const same = live(data.budgets).find((b) => b.id !== id && b.period === draft.period && b.scope === draft.scope && (b.categoryID ?? null) === categoryID && (b.month ?? null) === month);
      if (same && id) throw new LedgerError('同じ対象の予算がすでにあります。');
      const old = id ? find_(data.budgets, id, '対象の予算が見つかりません。') : same;
      const time = this.now();
      return upsert(data.budgets, compact({ ...(old ?? { id: this.uuid(), createdAt: time }), period: draft.period, scope: draft.scope, categoryID, month, amount: draft.amount, updatedAt: time }));
    });
  },
  deleteBudget(id) {
    return this.commit((data) => { const r = find_(data.budgets, id, '対象の予算が見つかりません。'); r.deletedAt = r.updatedAt = this.now(); });
  },

  saveGoal(draft, id = null) {
    return this.commit((data) => {
      const old = id ? find_(data.goals, id, '対象の目標が見つかりません。') : null;
      const name = String(draft.name ?? '').trim();
      if (!name) throw new LedgerError('名前を入力してください。');
      if (live(data.goals).some((g) => g.id !== id && g.name === name)) throw new LedgerError('同じ名前の目標がすでにあります。');
      if (!positive(draft.targetAmount)) throw new LedgerError('目標金額は1円以上の整数で入力してください。');
      if (draft.targetDay && !isDay(draft.targetDay)) throw new LedgerError('期限の日付が正しくありません。');
      const accountID = draft.accountID || null;
      const isArchived = draft.isArchived ?? old?.isArchived ?? false;
      if (accountID) {
        if (!live(data.accounts).some((a) => a.id === accountID)) throw new LedgerError('選んだ口座が見つかりません。');
        // 同じ資産を複数の目標に重複して数えない
        const other = live(data.goals).find((g) => g.id !== id && !g.isArchived && g.accountID === accountID);
        if (other && !isArchived) throw new LedgerError(`この口座は目標「${other.name}」で使っています。1つの口座は1つの目標にだけ使えます。`);
      }
      const time = this.now();
      return upsert(data.goals, compact({ ...(old ?? { id: this.uuid(), createdAt: time }), name, targetAmount: draft.targetAmount, targetDay: draft.targetDay || null,
        accountID, memo: String(draft.memo ?? '').trim(), isArchived, updatedAt: time }));
    });
  },
  /** 目標と、その積み立ての記録を削除する。支出・収入や口座は変わらない。 */
  deleteGoal(id) {
    return this.commit((data) => {
      const goal = find_(data.goals, id, '対象の目標が見つかりません。');
      const time = this.now();
      goal.deletedAt = goal.updatedAt = time;
      for (const d of live(data.goalDeposits).filter((x) => x.goalID === id)) d.deletedAt = d.updatedAt = time;
    });
  },
  addDeposit(goalID, { day, amount, memo = '' }) {
    return this.commit((data) => {
      const goal = find_(data.goals, goalID, '対象の目標が見つかりません。');
      if (goal.accountID) throw new LedgerError('口座の残高を使う目標には、積み立ての記録は追加できません。');
      if (!isDay(day ?? '')) throw new LedgerError('日付を指定してください。');
      if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > MAXIMUM) throw new LedgerError('金額を整数で入力してください。');
      const total = deposits(data, goalID).reduce((s, d) => s + d.amount, 0);
      if (total + amount < 0) throw new LedgerError('積み立てた金額より多くは取り崩せません。');
      const time = this.now();
      data.goalDeposits.push({ id: this.uuid(), goalID, day, amount, memo: String(memo).trim(), createdAt: time, updatedAt: time });
    });
  },
  deleteDeposit(id) {
    return this.commit((data) => {
      const record = find_(data.goalDeposits, id, '対象の記録が見つかりません。');
      if (deposits(data, record.goalID).reduce((s, d) => s + d.amount, 0) - record.amount < 0) throw new LedgerError('この記録を消すと残りがマイナスになります。');
      record.deletedAt = record.updatedAt = this.now();
    });
  },
});
