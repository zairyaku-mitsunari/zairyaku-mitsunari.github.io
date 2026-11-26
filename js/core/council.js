// 財務軍議：記録と予定から計算した報告。AIは使わない。
import { addDays, addMonths, daysBetween, monthTitle, shortRange } from './date.js';
import { live, find, summary, expenseByCategory, categoryName } from './ledger.js';
import { periodRange, monthContaining, totalAssets, bills, isConfigured } from './finance.js';
import { unpaid, liabilities } from './schedule.js';
import { pending, outlook } from './payroll.js';
import { budgetStatuses, goalStatus, activeGoals, SCOPES } from './planning.js';
import { findings } from './advice.js';
import { yen, signed } from './money.js';
import { Store, LedgerError } from './store.js';

export const COUNCILS = { daily: '日次軍議', weekly: '週次軍議', monthly: '月次軍議', yearly: '年次軍議' };
const AHEAD = { daily: 7, weekly: 14, monthly: 31, yearly: 60 };

/** 対象の期間と、比べる前の期間（同じ日数） */
export function councilRange(data, kind, today) {
  if (kind === 'daily') return { range: { start: today, end: today }, previous: { start: addDays(today, -1), end: addDays(today, -1) } };
  if (kind === 'weekly') return { range: { start: addDays(today, -6), end: today }, previous: { start: addDays(today, -13), end: addDays(today, -7) } };
  const year = Number(today.slice(0, 4));
  const month = monthContaining(today, data);
  const start = kind === 'yearly' ? periodRange(`${year}-01`, data).start : periodRange(month, data).start;
  const before = kind === 'yearly' ? periodRange(`${year - 1}-01`, data).start : periodRange(addMonths(month, -1), data).start;
  const limit = addDays(start, -1);
  const end = addDays(before, daysBetween(start, today));
  return { range: { start, end: today }, previous: { start: before, end: kind === 'monthly' && end > limit ? limit : end } };
}

export function report(data, kind, today, scope = 'all') {
  const { range, previous } = councilRange(data, kind, today);
  const sections = [];
  const add = (title, lines) => { if (lines.length) sections.push({ title, lines }); };
  const now = summary(data, range, scope);
  const before = summary(data, previous, scope);
  const business = scope === 'business';
  const [inName, outName, netName] = business ? ['売上', '経費', '利益'] : ['収入', '支出', '収支'];
  const records = live(data.transactions).filter((t) => t.day >= range.start && t.day <= range.end && (scope === 'all' || t.scope === scope));

  add('結論', [
    !records.length ? 'この期間の記録がないため、収支の評価はできません。' : now.net >= 0 ? `この期間の${netName}は ${signed(now.net)} の黒字です。` : `この期間の${netName}は ${yen(now.net)} の赤字です。`,
  ]);
  const compared = live(data.transactions).some((t) => t.day >= previous.start && t.day <= previous.end && ['income', 'expense', 'refund'].includes(t.kind) && (scope === 'all' || t.scope === scope));
  const against = (value, old) => (compared ? `（前の期間 ${yen(old)}、差 ${signed(value - old)}）` : '');
  add('収支の実績', [
    `${inName} ${yen(now.income)}${against(now.income, before.income)}`,
    `${outName} ${yen(now.expense)}${against(now.expense, before.expense)}`,
    `${netName} ${signed(now.net)}${compared ? `（前の期間 ${signed(before.net)}）` : ''}`,
    compared ? `比べた期間：${previous.start}〜${previous.end}（同じ日数）` : `前の期間（${previous.start}〜${previous.end}）の記録がないため、比較はできません。`,
  ]);
  const top = expenseByCategory(data, range, scope).filter((x) => x.amount > 0).slice(0, 3);
  add(`${outName}の多い項目`, top.map((x, i) => `${i + 1}. ${categoryName(data, x.categoryID)} ${yen(x.amount)}`));

  const assets = totalAssets(data, today);
  const debt = liabilities(data);
  add('資産と負債（全体・今日時点）', [
    `総資産 ${assets.amount == null ? '未入力' : yen(assets.amount)}`,
    `負債 ${yen(debt.total)}（カード未払い ${yen(debt.cards)}、ローン ${yen(debt.loans)}）`,
    assets.amount == null ? null : `純資産 ${yen(assets.amount - debt.total)}`,
  ].filter(Boolean));

  const month = monthContaining(today, data);
  add('予算の状況', budgetStatuses(data, month, scope, today).map((s) => {
    const name = s.budget.categoryID ? categoryName(data, s.budget.categoryID) : '支出全体';
    const state = s.over ? `超過 ${yen(s.over)}` : s.willExceed ? `超える見込み（予測 ${yen(s.forecast.amount)}）` : `残り ${yen(s.remaining)}`;
    return `${s.budget.period === 'yearly' ? '年間' : '月間'}・${name}（${SCOPES[s.budget.scope]}）：${yen(s.used)} ／ ${yen(s.budget.amount)}（${s.percent}%）${state}`;
  }));
  add('貯蓄目標', activeGoals(data).map((g) => {
    const s = goalStatus(data, g, today);
    if (s.saved == null) return `${g.name}：口座の残高が未入力のため分かりません。`;
    return `${g.name}：${yen(s.saved)} ／ ${yen(g.targetAmount)}（${s.percent}%）${s.remaining ? `、残り ${yen(s.remaining)}${s.required ? `、毎月の必要額 ${yen(s.required)}` : ''}` : '、達成'}`;
  }));

  const until = addDays(today, AHEAD[kind]);
  const schedule = [];
  for (const o of pending(data, { start: today, end: until })) {
    const source = find(data.incomeSources, o.sourceID);
    if (scope === 'all' || source.scope === scope) schedule.push([o.day, `入金予定 ${source.name}${o.bonusID ? '（賞与）' : ''} ${o.expectedAmount == null ? '金額未定' : yen(o.expectedAmount)}`]);
  }
  for (const card of live(data.cards)) {
    for (const b of bills(data, card)) if (!b.settled && b.remaining > 0 && b.paymentDay >= today && b.paymentDay <= until) schedule.push([b.paymentDay, `引き落とし ${card.name} ${yen(b.remaining)}${b.confirmed == null ? '（未確定）' : ''}`]);
  }
  for (const o of unpaid(data, until, (c) => c.deletedAt == null && (scope === 'all' || c.scope === scope))) {
    const cost = find(data.recurringCosts, o.recurringID);
    if (o.dueDay >= today) schedule.push([o.dueDay, `支払い予定 ${cost.name} ${cost.plannedAmount == null ? '金額未定' : yen(cost.plannedAmount)}${cost.cardID ? '（カード払い）' : ''}`]);
  }
  schedule.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  add(`今後${AHEAD[kind]}日の予定（実績ではありません）`, schedule.slice(0, 20).map(([day, text]) => `${day} ${text}`).concat(schedule.length > 20 ? [`ほか${schedule.length - 20}件`] : []));

  const view = outlook(data, today);
  add('資金の見通し', view ? [
    view.available == null ? '口座の残高が未入力のため、不足するかどうかは分かりません。'
      : view.isShort ? `次の給料日（${view.payday.day}）までに ${yen(-view.available)} 不足する予定です。`
        : `次の給料日（${view.payday.day}）まで${view.daysLeft}日。予定の支払い後に使える目安は ${yen(view.available)}（1日あたり ${yen(view.perDay)}）。`,
  ] : []);

  const advice = findings(data, today, scope);
  add('見直しの候補', advice.items.slice(0, 5).map((f) => `【${f.type}】${f.title}${f.yearlySaving ? `（年間の削減可能額 ${yen(f.yearlySaving)}）` : ''}`));
  if (advice.yearlySaving) add('削減の目標', [`候補をすべて実行した場合：月 ${yen(advice.monthlySaving)}、年 ${yen(advice.yearlySaving)}（推定。同じ対象は1回だけ数えています）`]);

  const actions = advice.items.slice(0, 3).map((f, i) => `${i + 1}. ${f.action}（${f.target}）`);
  if (!live(data.budgets).length) actions.push('予算を設定すると、使いすぎを早く見つけられます。');
  if (!activeGoals(data).length) actions.push('貯蓄目標を決めると、毎月の必要額を計算できます。');
  add('次の作戦', actions.length ? actions : ['大きな問題は見つかりません。記録を続けてください。']);

  const missing = [];
  if (assets.unknown) missing.push(`初期残高が未入力の口座：${assets.unknown}件`);
  const cards = live(data.cards).filter((c) => !c.isArchived && !isConfigured(c)).length;
  if (cards) missing.push(`締め日が未設定のカード：${cards}件`);
  if (!live(data.incomeSources).length) missing.push('給料日の設定がないため、給料日までの見通しは出せません。');
  if (debt.unknownLoans) missing.push(`元本残高が未入力のローン：${debt.unknownLoans}件`);
  add('足りない情報', missing);
  add('おわりに', ['数字は登録された記録と予定だけから計算しています。最後のご判断は、あなたにお任せします。']);
  return { kind, scope, start: range.start, end: range.end, createdDay: today, sections };
}

export const reportTitle = (r) => `${COUNCILS[r.kind] ?? '軍議'}（${r.start === r.end ? r.start : `${r.start}〜${r.end}`}・${SCOPES[r.scope]}）`;
export const reportText = (r) => [reportTitle(r), ...r.sections.flatMap((s) => [`【${s.title}】`, ...s.lines])].join('\n');

Object.assign(Store.prototype, {
  saveCouncil(value) {
    return this.commit((data) => {
      const time = this.now();
      const record = { id: this.uuid(), kind: value.kind, scope: value.scope, start: value.start, end: value.end, createdDay: value.createdDay,
        sections: value.sections.map((s) => ({ title: s.title, lines: [...s.lines] })), createdAt: time, updatedAt: time };
      data.councils.push(record);
      return record;
    });
  },
  deleteCouncil(id) {
    return this.commit((data) => {
      const record = live(data.councils).find((c) => c.id === id);
      if (!record) throw new LedgerError('対象の軍議が見つかりません。');
      Object.assign(record, { sections: [], deletedAt: this.now(), updatedAt: this.now() });
    });
  },
});
