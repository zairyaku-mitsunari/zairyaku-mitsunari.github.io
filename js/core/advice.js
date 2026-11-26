// 見直し候補と改善提案。記録と設定からの計算だけで、AIの推測は使わない。
// 「不要」と断定せず、理由と金額を示して、利用者が判断する。削減できる額が分からないものは null。
import { addDays, addMonths, daysBetween, monthOf, monthTitle } from './date.js';
import { live, find, inPeriod, categoryName } from './ledger.js';
import { periodRange, monthContaining, balance, bills } from './finance.js';
import { occurrences, status, unpaid, CYCLE_MONTHS, INSURANCE } from './schedule.js';
import { outlook } from './payroll.js';
import { spent, budgetStatuses, goalStatus, activeGoals, baseline, SCOPES } from './planning.js';
import { yen } from './money.js';
import { Store, LedgerError } from './store.js';

export const STATUS = { planned: '実行する', done: '実行した', dismissed: '対象外にする' };
const CAREFUL_GROUPS = ['家族・教育', '健康・医療', '住宅関連', '税金・手数料', 'AI・事業関連'];
const FEES = ['振込手数料', 'カード手数料', 'その他手数料'];

export const monthlyAmount = (cost) => (cost.plannedAmount == null || !CYCLE_MONTHS[cost.cycle] ? null : Math.round(cost.plannedAmount / CYCLE_MONTHS[cost.cycle]));
const activeCosts = (data, today, scope) => live(data.recurringCosts).filter((c) => c.isActive && (!c.endDay || c.endDay >= today) && (scope === 'all' || c.scope === scope));
const careful = (data, categoryID) => {
  const c = find(data.categories, categoryID);
  const group = find(data.categories, c?.parentID)?.name;
  return c?.necessity === 'essential' || c?.necessity === 'investment' || CAREFUL_GROUPS.includes(group);
};
const CARE_TEXT = '必要な支出や将来への投資の可能性があります。金額だけで無駄とは判断しません。';

function item(values) {
  return { priority: 3, current: null, currentMonthly: null, monthlySaving: null, caution: '', assumption: '', categoryID: null, recurringID: null, ...values,
    yearlySaving: values.yearlySaving ?? (values.monthlySaving != null ? values.monthlySaving * 12 : null) };
}

/** 終わった直近の月度（新しい順、n個） */
function pastMonths(data, today, n) {
  const current = monthContaining(today, data);
  return Array.from({ length: n }, (_, i) => addMonths(current, -(i + 1)));
}

function allFindings(data, today, scope) {
  const result = [];
  const add = (v) => result.push(item(v));
  const costs = activeCosts(data, today, scope);

  // ---- 資金と予定
  const view = outlook(data, today);
  if (view?.isShort) {
    add({ key: `short:${view.payday.day}`, type: '資金不足', priority: 1, title: '給料日までに資金が足りなくなる予定です', target: `次の給料日 ${view.payday.day}`,
      current: `残高 ${yen(view.balance)}、予定の支払い ${yen(view.scheduled)}`, problem: `${yen(-view.available)} 不足する計算です。`,
      basis: '現金・口座の残高から、給料日の前日までの固定費とカード引き落としを引いた結果', action: '支払い日の変更、口座間の振替、支出の延期を検討してください。',
      assumption: view.unknownCount || view.unknownAccounts ? `金額未定の予定${view.unknownCount}件、残高未入力の口座${view.unknownAccounts}件は含みません。` : '登録した予定と残高だけで計算しています。' });
  }
  for (const account of live(data.accounts)) {
    const due = live(data.cards).filter((c) => c.withdrawalAccountID === account.id).flatMap((c) => bills(data, c))
      .filter((b) => !b.settled && b.remaining > 0 && b.paymentDay >= today && b.paymentDay <= addDays(today, 45));
    const total = due.reduce((s, b) => s + b.remaining, 0);
    const now = balance(data, account, today);
    if (total > 0 && now != null && now < total) {
      add({ key: `account:${account.id}:${due.map((b) => b.paymentDay).sort()[0]}`, type: '資金不足', priority: 1, title: `${account.name}の残高が引き落とし額より少なくなっています`, target: account.name,
        current: `残高 ${yen(now)}、45日以内の引き落とし ${yen(total)}`, problem: `${yen(total - now)} 足りません。`, basis: '登録したカードの請求と口座の残高',
        action: '引き落とし日までに入金か振替をしてください。', assumption: 'この後の入金予定は含みません。' });
    }
  }
  const overdue = unpaid(data, addDays(today, -1), (c) => costs.includes(c));
  if (overdue.length) {
    add({ key: `overdue:${overdue[0].recurringID}:${overdue[0].dueDay}`, type: '記録もれ', priority: 1, title: `支払いの記録がない予定が${overdue.length}件あります`, target: '固定費・保険・サブスク・負債',
      current: `最も古い予定日 ${overdue[0].dueDay}`, problem: '支払い忘れか、記録もれの可能性があります。', basis: '予定日を過ぎて、支払いも見送りも記録されていない予定',
      action: '資産管理の各タブで「支払い」を記録してください。' });
  }

  // ---- 予算と目標
  const month = monthContaining(today, data);
  for (const s of budgetStatuses(data, month, scope, today)) {
    if (!s.over && !s.willExceed) continue;
    const name = s.budget.categoryID ? categoryName(data, s.budget.categoryID) : '支出全体';
    add({ key: `budget:${s.budget.id}:${s.range.start}`, type: '予算', priority: s.over ? 1 : 2, title: s.over ? `${name}の予算を超えています` : `${name}の予算を超える見込みです`,
      target: `${name}（${SCOPES[s.budget.scope]}）`, current: `使用 ${yen(s.used)} ／ 予算 ${yen(s.budget.amount)}`, categoryID: s.budget.categoryID,
      problem: s.over ? `${yen(s.over)} の超過です。` : `期間末の予測は ${yen(s.forecast.amount)} です。`,
      basis: s.over ? `${s.range.start}〜${s.range.end}の記録` : '実績＋残りの予定＋固定費以外の1日平均×残り日数（予測）',
      action: '残りの期間の支出を確認し、予算か使い方を見直してください。', assumption: s.over ? '' : '予測は目安です。' });
  }
  const base = baseline(data, today, scope);
  // 収入の記録がない場合は、記録もれと区別できないので赤字とは判断しない
  if (base && base.income > 0 && base.net < 0) {
    add({ key: `deficit:${base.months[0]}`, type: '貯蓄不足', priority: 1, title: '支出が収入を上回っています', target: '毎月の収支',
      current: `平均で収入 ${yen(base.income)}、支出 ${yen(base.expense)}`, problem: `毎月 ${yen(-base.net)} の赤字です。`,
      basis: `記録がある直近${base.months.length}か月度の平均`, action: '固定費から順に見直してください。', assumption: '記録もれがあると実際と違います。' });
  }
  for (const goal of activeGoals(data)) {
    const s = goalStatus(data, goal, today);
    if (s.saved == null || s.remaining === 0) continue;
    if (s.overdue) {
      add({ key: `goal-over:${goal.id}`, type: '貯蓄不足', priority: 2, title: `目標「${goal.name}」の期限が過ぎています`, target: goal.name, current: `現在 ${yen(s.saved)} ／ 目標 ${yen(goal.targetAmount)}`,
        problem: `あと ${yen(s.remaining)} です。`, basis: `期限 ${goal.targetDay}`, action: '期限か目標金額を見直してください。' });
    } else if (s.required != null && base && base.income > 0 && s.required > Math.max(0, base.net)) {
      add({ key: `goal:${goal.id}`, type: '貯蓄不足', priority: 2, title: `目標「${goal.name}」は今のペースでは届かない可能性があります`, target: goal.name,
        current: `毎月の必要額 ${yen(s.required)}`, problem: `直近の毎月の黒字（${yen(base.net)}）より多く必要です。`, basis: `残り ${yen(s.remaining)} ÷ ${s.monthsLeft}か月`,
        action: '支出の見直し、収入を増やす、期限を延ばすのいずれかを検討してください。', assumption: '黒字をすべてこの目標に回した場合の比較です。' });
    }
  }

  // ---- 契約
  for (const cost of costs) {
    const monthly = monthlyAmount(cost);
    const sub = cost.subscription;
    if (sub?.trialEndDay && sub.trialEndDay >= today && daysBetween(today, sub.trialEndDay) <= 14) {
      add({ key: `trial:${cost.id}:${sub.trialEndDay}`, type: '無料期間', priority: 1, title: `${cost.name}の無料期間がもうすぐ終わります`, target: cost.name, recurringID: cost.id,
        current: cost.plannedAmount == null ? '料金は未入力' : `予定額 ${yen(cost.plannedAmount)}`, problem: `${sub.trialEndDay} に終了します。`, basis: '登録した無料期間の終了日',
        action: '続けない場合は、終了日より前に契約先で解約してください。', caution: 'このアプリは解約しません。' });
    }
    if (cost.kind === 'subscription' && sub?.usage === 'rarely') {
      add({ key: `rarely:${cost.id}`, type: 'サブスク', priority: 2, title: `${cost.name}はほとんど使っていません`, target: cost.name, recurringID: cost.id,
        current: monthly == null ? '料金は未入力' : `月あたり ${yen(monthly)}`, currentMonthly: monthly, monthlySaving: monthly,
        problem: '利用頻度に対して料金がかかっています。', basis: '登録した利用頻度「ほとんど使わない」', action: '解約か、安いプランへの変更を検討してください。',
        caution: '必要な理由があれば「対象外」にしてください。このアプリは解約しません。', assumption: monthly == null ? '' : '解約した場合の削減額（予定額の月換算）。違約金は含みません。' });
    }
    if (cost.insurance) {
      const day = [cost.insurance.reviewDay, cost.insurance.renewalDay].filter((d) => d && d >= today && daysBetween(today, d) <= 60).sort()[0];
      if (day) {
        add({ key: `insurance-date:${cost.id}:${day}`, type: '保険', priority: 2, title: `${cost.name}の見直し・更新の時期が近づいています`, target: cost.name, recurringID: cost.id,
          current: monthly == null ? '保険料は未入力' : `月あたり ${yen(monthly)}`, problem: `${day} が予定日です。`, basis: '登録した見直し日・更新日',
          action: '保障の内容と保険料を、保険会社や担当者に確認してください。', caution: '保障を減らすと、万一の備えが不足することがあります。' });
      }
    }
  }
  const groupBy = (list, key) => list.reduce((map, x) => { const k = key(x); if (k) map.set(k, [...(map.get(k) ?? []), x]); return map; }, new Map());
  for (const [key, list] of groupBy(costs, (c) => c.name.trim().toLowerCase())) {
    if (list.length < 2) continue;
    add({ key: `same-name:${key}`, type: '重複', priority: 2, title: `「${list[0].name}」の予定が${list.length}件あります`, target: list[0].name,
      current: list.map((c) => (c.plannedAmount == null ? '未入力' : yen(c.plannedAmount))).join('、'), problem: '同じ契約を二重に登録している可能性があります。',
      basis: '名前が同じ予定', action: '内容を確認し、不要な方を削除してください。', caution: '別の契約なら「対象外」にしてください。' });
  }
  for (const [categoryID, list] of groupBy(costs.filter((c) => c.kind === 'subscription'), (c) => c.categoryID)) {
    if (list.length < 2) continue;
    add({ key: `same-category:${categoryID}`, type: '重複', title: `${categoryName(data, categoryID)}のサブスクが${list.length}件あります`, target: list.map((c) => c.name).join('、'), categoryID,
      current: `月あたり合計 ${yen(list.reduce((s, c) => s + (monthlyAmount(c) ?? 0), 0))}`, problem: '役割が重なっている可能性があります。', basis: '同じ項目の契約中サブスク',
      action: '使い分けを確認し、まとめられるものがないか検討してください。', caution: CARE_TEXT });
  }
  for (const [key, list] of groupBy(costs.filter((c) => c.insurance?.insured), (c) => `${c.insurance.type}/${c.insurance.insured}`)) {
    if (list.length < 2) continue;
    add({ key: `insurance-overlap:${key}`, type: '保険', title: `${INSURANCE[list[0].insurance.type]}が同じ被保険者で${list.length}件あります`, target: list.map((c) => c.name).join('、'),
      current: `月あたり合計 ${yen(list.reduce((s, c) => s + (monthlyAmount(c) ?? 0), 0))}`, problem: '保障が重なっていないか確認する価値があります。', basis: '保険の種類と被保険者が同じ',
      action: '保障内容を並べて確認してください。', caution: '重複かどうかは保障内容によります。節約できる額は、見積もりがないと分かりません。' });
  }

  // 支払いの金額が上がった契約
  for (const cost of costs) {
    const paid = live(data.recurringPayments).filter((p) => p.recurringID === cost.id && p.entryID)
      .map((p) => ({ month: p.dueMonth, entry: live(data.transactions).find((t) => t.id === p.entryID) })).filter((p) => p.entry).sort((a, b) => (a.month < b.month ? -1 : 1));
    if (paid.length < 2) continue;
    const [before, after] = paid.slice(-2);
    if (after.entry.amount <= before.entry.amount) continue;
    add({ key: `raise:${cost.id}:${after.month}`, type: '値上がり', title: `${cost.name}の支払いが増えています`, target: cost.name, recurringID: cost.id,
      current: `${monthTitle(before.month)} ${yen(before.entry.amount)} → ${monthTitle(after.month)} ${yen(after.entry.amount)}`,
      problem: `${yen(after.entry.amount - before.entry.amount)} 増えました。`, basis: '直近2回の支払いの記録', action: '料金改定か利用量の増加かを確認してください。' });
  }

  // ---- 支出の記録
  const [last, ...previous] = pastMonths(data, today, 4);
  const range = periodRange(last, data);
  const compared = previous.map((m) => periodRange(m, data)).filter((r) => inPeriod(data, r, scope).some((t) => t.kind === 'expense'));
  if (compared.length >= 2) {
    for (const category of live(data.categories).filter((c) => c.kind === 'expense' && !c.isGroup)) {
      const now = spent(data, range, scope, category.id);
      const average = Math.round(compared.reduce((s, r) => s + spent(data, r, scope, category.id), 0) / compared.length);
      if (average <= 0 || now - average < 3000 || now < average * 1.3) continue;
      add({ key: `surge:${category.id}:${last}`, type: '急増', title: `${category.name}が増えています`, target: category.name, categoryID: category.id,
        current: `${monthTitle(last)}度 ${yen(now)}（それ以前の平均 ${yen(average)}）`, problem: `平均より ${yen(now - average)} 多くなっています。`,
        basis: `直前の月度と、その前の${compared.length}か月度の平均の比較（3割以上かつ3,000円以上）`, action: '内訳を確認してください。', caution: careful(data, category.id) ? CARE_TEXT : '一時的な支出なら問題ありません。' });
    }
  }
  const recent = [last, ...previous.slice(0, 2)].map((m) => periodRange(m, data));
  const months3 = recent.filter((r) => inPeriod(data, r, scope).some((t) => t.kind === 'expense'));
  const countedRecurring = new Set(result.filter((f) => f.monthlySaving != null && f.recurringID).map((f) => f.recurringID));
  const countedEntries = new Set(live(data.recurringPayments).filter((p) => countedRecurring.has(p.recurringID)).map((p) => p.entryID));
  for (const category of live(data.categories).filter((c) => c.kind === 'expense' && !c.isGroup)) {
    const fee = FEES.includes(category.name);
    if (!fee && !['review', 'waste'].includes(category.necessity)) continue;
    const list = months3.flatMap((r) => inPeriod(data, r, scope)).filter((t) => (t.kind === 'expense' || t.kind === 'refund') && t.categoryID === category.id);
    // 契約の提案で数えた支払いは、ここでは数えない（削減額の二重計上を防ぐ）
    const total = list.filter((t) => !countedEntries.has(t.id)).reduce((s, t) => s + (t.kind === 'refund' ? -t.amount : t.amount), 0);
    if (total <= 0 || !months3.length) continue;
    const average = Math.round(total / months3.length);
    const waste = category.necessity === 'waste';
    add({ key: `${fee ? 'fee' : 'marked'}:${category.id}`, type: fee ? '手数料' : '見直し', priority: waste ? 2 : 3, categoryID: category.id,
      title: fee ? `${category.name}がかかっています` : waste ? `${category.name}は「不要な支出の候補」です` : `${category.name}は「見直し可能な支出」です`, target: category.name,
      current: `月平均 ${yen(average)}`, currentMonthly: average, monthlySaving: waste ? average : null, problem: fee ? '手数料は工夫で減らせることがあります。' : '分類にもとづく見直しの候補です。',
      basis: `直近${months3.length}か月度の記録の平均${fee ? '' : '（分類はあなたの設定）'}`, action: fee ? '手数料のかからない方法や時間帯、口座を確認してください。' : '必要かどうかを確認し、減らせる分を決めてください。',
      assumption: waste ? 'この項目の支出をすべてなくした場合の額です。' : '' });
  }
  const from = addDays(today, -90);
  const same = groupBy(live(data.transactions).filter((t) => t.kind === 'expense' && t.day >= from && t.day <= today && t.storeName && (scope === 'all' || t.scope === scope)),
    (t) => `${t.day}/${t.amount}/${t.storeName}`);
  for (const list of same.values()) {
    // 1枚のレシートを項目に分けた記録は除く
    if (new Set(list.map((t) => t.receiptID ?? t.id)).size < 2) continue;
    const t = list[0];
    add({ key: `double:${list.map((x) => x.id).sort()[0]}`, type: '二重登録', priority: 2, title: '同じ支払いが2回記録されている可能性があります', target: `${t.day} ${t.storeName}`,
      current: `${yen(t.amount)} × ${list.length}件`, problem: '日付・金額・店舗名が同じ記録があります。', basis: '直近90日の記録', action: '取引履歴で確認し、重複なら削除してください。', caution: '別々の買い物なら「対象外」にしてください。' });
  }
  // 同じ店での少額の支払いの繰り返し
  const small = groupBy(inPeriod(data, range, scope).filter((t) => t.kind === 'expense' && t.storeName && t.amount <= 1500), (t) => t.storeName);
  for (const [store, list] of small) {
    if (list.length < 8) continue;
    const sum = list.reduce((s, t) => s + t.amount, 0);
    add({ key: `often:${store}:${last}`, type: '少額の繰り返し', title: `${store}での少額の支払いが${list.length}回あります`, target: store, current: `${monthTitle(last)}度の合計 ${yen(sum)}（1回の平均 ${yen(Math.round(sum / list.length))}）`,
      problem: '1回は小さくても、まとまった金額になります。', basis: '直前の月度に、同じ店で1,500円以下の支払いが8回以上', action: '回数か、1回の金額の目安を決めてみてください。', caution: careful(data, list[0].categoryID) ? CARE_TEXT : '必要な買い物なら「対象外」にしてください。' });
  }
  // 金利の高い借入
  for (const cost of costs.filter((c) => c.loan?.annualRateMilli >= 5000 && c.loan.principalBalance > 0)) {
    const rate = cost.loan.annualRateMilli;
    add({ key: `interest:${cost.id}`, type: '金利', priority: 2, title: `${cost.name}の金利が高めです`, target: cost.name, recurringID: cost.id,
      current: `年利 ${Math.floor(rate / 1000)}.${String(rate % 1000).padStart(3, '0')}%`, problem: '利息の負担が大きくなりやすい借入です。', basis: '登録した年利が5%以上',
      action: '繰り上げ返済、借り換え、返済額の見直しを、借入先などに確認してください。', caution: '手数料や条件によっては、得にならないことがあります。節約できる額は、条件が分からないと計算できません。' });
  }
  // 固定費の割合
  if (base && base.income > 0) {
    const fixed = costs.map((c) => ({ c, m: monthlyAmount(c) })).filter((x) => x.m);
    const sum = fixed.reduce((s, x) => s + x.m, 0);
    if (sum >= base.income * 0.5) {
      add({ key: `fixed-heavy:${base.months[0]}`, type: '固定費', priority: 2, title: '固定費などの予定が収入の半分以上です', target: fixed.sort((a, b) => b.m - a.m).slice(0, 3).map((x) => x.c.name).join('、'),
        current: `予定額 月 ${yen(sum)}／収入の平均 ${yen(base.income)}`, problem: '自由に使えるお金と貯蓄が残りにくくなります。', basis: '固定費・保険・サブスク・返済の予定額の月換算と、直近の収入の平均',
        action: '金額の大きい順に、料金プランや契約内容を確認してください。', caution: CARE_TEXT });
    }
  }

  const year = { start: addDays(today, -365), end: today };
  for (const card of live(data.cards)) {
    if (card.isArchived || !card.annualFee) continue;
    const used = inPeriod(data, year).some((t) => t.cardID === card.id && t.kind === 'expense');
    const old = card.createdAt <= Date.parse(`${addDays(today, -180)}T00:00:00Z`);
    if (used || !old) continue;
    add({ key: `card-fee:${card.id}`, type: '手数料', priority: 3, title: `${card.name}は利用の記録がなく、年会費がかかります`, target: card.name,
      current: `年会費 ${yen(card.annualFee)}`, currentMonthly: Math.round(card.annualFee / 12), yearlySaving: card.annualFee, monthlySaving: Math.round(card.annualFee / 12),
      problem: '使っていないカードの費用です。', basis: '直近1年の利用記録がない', action: '継続の必要性を確認してください。', caution: '付帯サービスや支払いの設定先を確認してから判断してください。', assumption: '解約した場合の年会費' });
  }
  return result.sort((a, b) => a.priority - b.priority || (b.yearlySaving ?? 0) - (a.yearlySaving ?? 0) || (a.key < b.key ? -1 : 1));
}

/** 見直し候補。利用者が「対象外」にしたものは hidden に分ける。 */
export function findings(data, today, scope = 'all') {
  const judged = new Map(live(data.improvements).map((i) => [i.key, i]));
  const all = allFindings(data, today, scope).map((f) => ({ ...f, judgment: judged.get(f.key) ?? null }));
  const items = all.filter((f) => f.judgment?.status !== 'dismissed' && f.judgment?.status !== 'done');
  // 同じ対象の削減額は1回だけ数える
  const savings = new Map();
  for (const f of items) {
    if (f.yearlySaving == null) continue;
    const key = f.recurringID ?? f.categoryID ?? f.key;
    savings.set(key, Math.max(savings.get(key) ?? 0, f.yearlySaving));
  }
  const yearly = [...savings.values()].reduce((s, v) => s + v, 0);
  return { items, hidden: all.filter((f) => f.judgment?.status === 'dismissed'), yearlySaving: yearly, monthlySaving: Math.round(yearly / 12) };
}

/**
 * 「実行した」提案の、実行した月より後の終わった月度の実績。削減額 ＝ 実行前の月額 − 実行後の実績。
 * ほかの理由で増減した分も含まれる。
 */
export function results(data, today) {
  const current = monthContaining(today, data);
  return live(data.improvements).filter((i) => i.status === 'done').map((improvement) => {
    const months = [];
    for (let m = addMonths(improvement.startMonth ?? current, 1); m < current && months.length < 60; m = addMonths(m, 1)) months.push(m);
    if (improvement.baselineMonthly == null || (!improvement.recurringID && !improvement.categoryID) || !months.length) return { improvement, months: months.length, saved: null };
    const ids = new Set(live(data.recurringPayments).filter((p) => p.recurringID === improvement.recurringID).map((p) => p.entryID));
    const actual = months.reduce((s, m) => {
      const range = periodRange(m, data);
      if (!improvement.recurringID) return s + spent(data, range, 'all', improvement.categoryID);
      return s + inPeriod(data, range).filter((t) => ids.has(t.id)).reduce((a, t) => a + t.amount, 0);
    }, 0);
    return { improvement, months: months.length, saved: improvement.baselineMonthly * months.length - actual };
  });
}

const compact = (object) => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== null && v !== undefined));

Object.assign(Store.prototype, {
  /** 提案への判断を覚える。実行前の月額は、最初に記録した値を保つ。 */
  setImprovement(finding, newStatus, today) {
    return this.commit((data) => {
      if (!STATUS[newStatus]) throw new LedgerError('判断を選んでください。');
      const time = this.now();
      const old = live(data.improvements).find((i) => i.key === finding.key);
      const value = compact({ ...(old ?? { id: this.uuid(), createdAt: time, baselineMonthly: finding.currentMonthly, categoryID: finding.categoryID, recurringID: finding.recurringID }),
        key: finding.key, title: finding.title, status: newStatus, startMonth: newStatus === 'done' ? monthContaining(today, data) : old?.startMonth, updatedAt: time });
      const i = data.improvements.findIndex((x) => x.id === value.id);
      if (i < 0) data.improvements.push(value); else data.improvements[i] = value;
    });
  },
  clearImprovement(id) {
    return this.commit((data) => {
      const record = live(data.improvements).find((i) => i.id === id);
      if (!record) throw new LedgerError('対象の記録が見つかりません。');
      record.deletedAt = record.updatedAt = this.now();
    });
  },
});
