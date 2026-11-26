// 三成の財務診断：記録と設定から指標を計算する。AIは使わない。
// 目安は一般的に言われる値で、家庭ごとに違う。計算に必要な記録がないものは「分かりません」とする。
import { addMonths, addDays } from './date.js';
import { live, find, inPeriod } from './ledger.js';
import { periodRange, monthContaining, balance, totalAssets, isConfigured } from './finance.js';
import { liabilities, plannedTotal } from './schedule.js';
import { baseline, spent } from './planning.js';
import { yen } from './money.js';

const percent = (a, b) => `${(Math.round((a * 1000) / b) / 10).toFixed(1)}%`;
const SAVINGS_TYPES = ['cash', 'bank', 'savings', 'timeDeposit', 'emoney', 'paypay', 'other'];
export const NECESSITY_ORDER = ['essential', 'investment', 'enrich', 'review', 'waste'];

const expenses = (data, range, scope) => inPeriod(data, range, scope).filter((t) => t.kind === 'expense' || t.kind === 'refund');
const total = (list) => list.reduce((s, t) => s + (t.kind === 'refund' ? -t.amount : t.amount), 0);

/** 直近12か月度の推移。記録が始まる前は null（0円と区別する）。 */
export function trends(data, today, scope = 'all', count = 12) {
  const current = monthContaining(today, data);
  const first = live(data.transactions).reduce((a, t) => (a === null || t.day < a ? t.day : a), null);
  return Array.from({ length: count }, (_, i) => {
    const month = addMonths(current, i - count + 1);
    const range = periodRange(month, data);
    const end = range.end > today ? today : range.end;
    const list = inPeriod(data, range, scope);
    const recorded = first !== null && range.end >= first;
    const accounts = live(data.accounts).filter((a) => a.openingBalance != null);
    const assetsKnown = recorded && accounts.length > 0 && accounts.every((a) => !a.openingDay || a.openingDay <= end);
    let debt = null;
    if (recorded) {
      debt = 0;
      for (const card of live(data.cards).filter(isConfigured)) {
        const mine = live(data.transactions).filter((t) => t.cardID === card.id && t.day <= end);
        debt += Math.max(0, mine.reduce((s, t) => s + (t.kind === 'expense' ? t.amount : t.kind === 'refund' || t.kind === 'cardPayment' ? -t.amount : 0), 0));
      }
      for (const loan of live(data.recurringCosts).filter((c) => c.kind === 'loan')) {
        const d = loan.loan;
        if (!d || d.principalBalance == null || (d.balanceDay && end < d.balanceDay)) { debt = null; break; }
        const repaid = live(data.recurringPayments).filter((p) => p.recurringID === loan.id && p.principal != null)
          .map((p) => ({ p, t: live(data.transactions).find((t) => t.id === p.entryID) }))
          .filter((x) => x.t && x.t.day <= end && (!d.balanceDay || x.t.day >= d.balanceDay)).reduce((s, x) => s + x.p.principal, 0);
        debt += Math.max(0, d.principalBalance - repaid);
      }
    }
    return { month, income: recorded ? list.filter((t) => t.kind === 'income').reduce((s, t) => s + t.amount, 0) : null,
      expense: recorded ? total(list.filter((t) => t.kind === 'expense' || t.kind === 'refund')) : null,
      assets: assetsKnown ? accounts.reduce((s, a) => s + balance(data, a, end), 0) : null, debt };
  });
}

/** 直近3か月度の支出を、利用者が決めた分類ごとに合計する */
export function necessityBreakdown(data, today, scope = 'all') {
  const current = monthContaining(today, data);
  const range = { start: periodRange(addMonths(current, -2), data).start, end: today };
  const sums = new Map();
  for (const t of expenses(data, range, scope)) {
    const key = find(data.categories, t.categoryID)?.necessity ?? '';
    sums.set(key, (sums.get(key) ?? 0) + (t.kind === 'refund' ? -t.amount : t.amount));
  }
  return { range, items: [...NECESSITY_ORDER, ''].map((key) => ({ key, amount: sums.get(key) ?? 0 })).filter((x) => x.amount > 0) };
}

export function diagnose(data, today, scope = 'all') {
  const metrics = [];
  const add = (id, title, value, level, basis, comment = '') => metrics.push({ id, title, value, level, basis, comment });
  const unknown = (id, title, reason) => add(id, title, '分かりません', 'unknown', reason);
  const base = baseline(data, today, scope);
  const income = base && base.income > 0 ? base.income : null;
  const months = base ? `記録がある直近${base.months.length}か月度の平均` : '';

  if (income) {
    add('savings', '貯蓄率（収入のうち残る割合）', percent(base.net, income), base.net < 0 ? 'warn' : base.net >= income * 0.1 ? 'good' : 'info',
      `${months}：収入 ${yen(base.income)}、支出 ${yen(base.expense)}`, base.net < 0 ? '支出が収入を上回っています。固定費から順に確認してください。' : '一般には1〜2割を残すことが目安とされます（家庭の事情で異なります）。');
  } else unknown('savings', '貯蓄率', '収入の記録がある終わった月度がまだありません。');

  if (income && base) {
    const sums = base.months.map((m) => total(expenses(data, periodRange(m, data), scope).filter((t) => (t.costNature ?? find(data.categories, t.categoryID)?.costNature) === 'fixed')));
    const fixed = Math.round(sums.reduce((a, b) => a + b, 0) / sums.length);
    add('fixed', '固定費の割合（収入に対して）', percent(fixed, income), fixed >= income * 0.5 ? 'warn' : 'info', `${months}：固定費 ${yen(fixed)}`, '固定費は一度見直すと効果が続きます。');
  } else unknown('fixed', '固定費の割合', '収入と支出の記録が足りません。');

  const reserveAccounts = live(data.accounts).filter((a) => SAVINGS_TYPES.includes(a.type) && a.openingBalance != null);
  if (reserveAccounts.length && base && base.expense > 0) {
    const reserve = reserveAccounts.reduce((s, a) => s + balance(data, a, today), 0);
    const cover = Math.max(0, Math.floor((reserve * 10) / base.expense) / 10);
    add('reserve', '生活防衛資金（支出の何か月分か）', `${cover.toFixed(1)}か月分`, cover < 3 ? 'warn' : 'good', `現金・預金 ${yen(reserve)} ÷ 月の支出 ${yen(base.expense)}`,
      '生活費の3〜6か月分が目安とされることがあります。収入の安定の度合いで必要な額は変わります。');
  } else unknown('reserve', '生活防衛資金', '口座の初期残高と、支出の記録が必要です。');

  const assets = totalAssets(data, today).amount;
  const debt = liabilities(data);
  if (assets != null && assets > 0) {
    add('debt', '資産に対する負債の割合', percent(debt.total, assets), debt.total > assets ? 'warn' : 'info', `負債 ${yen(debt.total)} ÷ 総資産 ${yen(assets)}`,
      debt.unknownLoans ? `元本残高が未入力のローン${debt.unknownLoans}件は含みません。` : '住宅ローンがある場合は、割合が大きくなるのが普通です。');
  } else unknown('debt', '資産に対する負債の割合', '口座の初期残高が未入力です。');

  const costs = (kind) => live(data.recurringCosts).filter((c) => c.kind === kind && (scope === 'all' || c.scope === scope));
  for (const [id, kind, title] of [['loan', 'loan', 'ローン返済'], ['subscription', 'subscription', 'サブスク'], ['insurance', 'insurance', '保険料']]) {
    const sum = plannedTotal(costs(kind), today);
    if (!sum.count) { add(id, `${title}の負担`, '登録なし', 'info', `${title}の予定は登録されていません。`); continue; }
    const warn = kind === 'loan' && income && sum.monthly > income * 0.25;
    add(id, `${title}の負担（月あたりの予定額）`, `${yen(sum.monthly)}${income ? `（収入の${percent(sum.monthly, income)}）` : ''}`, warn ? 'warn' : 'info', `年間 ${yen(sum.yearly)}（${sum.count}件の予定額）`,
      sum.unknown ? `金額が未入力の${sum.unknown}件は含みません。` : warn ? '返済の割合が高めです。借り換えや返済計画の確認を検討してください。' : '');
  }

  const series = trends(data, today, scope, 7).slice(0, 6); // 終わった6か月度
  const recent = series.slice(3).filter((m) => m.expense != null && m.expense > 0);
  const older = series.slice(0, 3).filter((m) => m.expense != null && m.expense > 0);
  if (recent.length >= 2 && older.length >= 2) {
    const a = Math.round(recent.reduce((s, m) => s + m.expense, 0) / recent.length), b = Math.round(older.reduce((s, m) => s + m.expense, 0) / older.length);
    add('trend', '支出の傾向（直近とその前）', `${a >= b ? '+' : '-'}${percent(Math.abs(a - b), b)}`, a > b * 1.15 ? 'warn' : 'info', `直近 ${yen(a)}／その前 ${yen(b)}（月平均）`, a > b * 1.15 ? '増えた項目を「収支分析」で確認してください。' : '');
  } else unknown('trend', '支出の傾向', '比べるには、前後それぞれ2か月度以上の記録が必要です。');

  const year = { start: addDays(today, -364), end: today };
  const sales = inPeriod(data, year, 'business').filter((t) => t.kind === 'income').reduce((s, t) => s + t.amount, 0);
  const costsOfBusiness = spent(data, year, 'business');
  if (scope !== 'personal' && (sales || costsOfBusiness)) {
    add('business', '事業の収支（直近1年）', yen(sales - costsOfBusiness), sales - costsOfBusiness < 0 ? 'warn' : 'good', `売上 ${yen(sales)}、経費 ${yen(costsOfBusiness)}${sales ? `、利益率 ${percent(sales - costsOfBusiness, sales)}` : ''}`,
      '立ち上げの時期は赤字になることがあります。金額だけで投資の良し悪しは判断しません。');
  }

  if (base && base.months.length >= 2) {
    const costs_ = live(data.recurringCosts).filter((c) => scope === 'all' || c.scope === scope);
    const linked = new Set(live(data.recurringPayments).map((p) => p.entryID));
    // 予定でも数える分は平均から除く（二重に数えない）：予定から記録した支払いと、予定のある項目の固定費
    const covered = new Set(costs_.filter((c) => c.isActive && c.plannedAmount != null).map((c) => c.categoryID));
    const planned_ = (t) => linked.has(t.id) || (covered.has(t.categoryID) && (t.costNature ?? find(data.categories, t.categoryID)?.costNature) === 'fixed');
    const variable = Math.round(base.months.reduce((s, m) => s + total(expenses(data, periodRange(m, data), scope).filter((t) => !planned_(t))), 0) / base.months.length);
    const planned = plannedTotal(costs_, today);
    add('forecast', 'この先1年の支出の見込み（予測）', yen(variable * 12 + planned.yearly), 'info', `予定にない支出の月平均 ${yen(variable)}×12＋予定額の年間 ${yen(planned.yearly)}`,
      `予測です。一時的な支出や値上がりは考えていません。${planned.unknown ? `金額が未入力の予定${planned.unknown}件は含みません。` : ''}`);
  } else unknown('forecast', 'この先1年の支出の見込み', '2か月度以上の記録が必要です。');
  return { metrics, months: base?.months ?? [] };
}
