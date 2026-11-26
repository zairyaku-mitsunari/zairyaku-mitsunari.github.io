// 予算と貯蓄目標の画面。給料日までの見通し。
import { h, button, panel, row, note, sheet, confirmSheet, screenHead } from './dom.js';
import { textField, moneyField, dateField, selectField, checkField, accountField, editorSheet, requireValid } from './form.js';
import { periodBar } from './screens.js';
import { incomePanel, paydaySheet } from './payday.js';
import * as L from '../core/ledger.js';
import * as P from '../core/planning.js';
import { outlook } from '../core/payroll.js';
import { yen, signed } from '../core/money.js';
import { today, monthTitle } from '../core/date.js';

const title = (text, ...controls) => h('div', { className: 'panel-head' }, h('h2', {}, text), ...controls);
export const meter = (percent, over, label) => h('div', { className: 'track', role: 'img', 'aria-label': label }, h('div', { className: over ? 'fill over' : 'fill', style: { width: `${Math.min(100, Math.max(0, percent))}%` } }));

export function goalsView(app) {
  const tabs = [['budget', '予算'], ['goal', '貯蓄目標']];
  return h('div', { className: 'screen' }, screenHead(app.goalTab === 'goal' ? 'goals' : 'budget'), periodBar(app), outlookPanel(app), incomePanel(app, () => app.render()),
    h('div', { className: 'tabs two' }, tabs.map(([id, text]) => button(text, () => { app.goalTab = id; app.render(); }, id === app.goalTab ? 'gold' : 'outline', { 'aria-pressed': String(id === app.goalTab), 'data-goal-tab': id }))),
    app.goalTab === 'goal' ? goals(app) : budgets(app));
}

function outlookPanel(app) {
  const view = outlook(app.store.data, today());
  if (!view) {
    return panel('給料日までの見通し', note('給料日を設定すると、次の給料日までに使える目安を計算します。', 'message'),
      h('div', { className: 'actions start' }, button('給料日を設定', () => paydaySheet(app), 'outline', { id: 'setup-payday' })));
  }
  return panel('給料日までの見通し（予定からの目安）',
    row('次の給料日', `${view.payday.day}（あと${view.daysLeft}日）`),
    row('現金・口座の残高', view.balance == null ? '未入力' : yen(view.balance)),
    row('給料日の前日までの予定の支払い', yen(view.scheduled)),
    view.available == null ? note('口座の初期残高を入力すると、使える目安を計算します。', 'note warn')
      : [row(view.isShort ? '不足する見込み' : '使える目安', yen(Math.abs(view.available)), view.isShort ? 'large expense' : 'large income'), view.isShort ? null : row('1日あたり', yen(view.perDay))],
    view.unknownCount || view.unknownAccounts ? note(`金額未定の予定${view.unknownCount}件と、残高未入力の口座${view.unknownAccounts}件は含みません。`) : null);
}

function budgets(app) {
  const { data } = app.store;
  const states = P.budgetStatuses(data, app.month, app.scope, today());
  return h('div', { className: 'stack' },
    h('div', { className: 'actions start' }, button('予算を追加', () => budgetEditor(app), 'gold', { id: 'add-budget' })),
    states.length ? h('div', { className: 'cards' }, states.map((s) => {
      const b = s.budget;
      const name = b.categoryID ? L.categoryName(data, b.categoryID) : '支出全体';
      const yearly = b.period === 'yearly';
      return h('section', { className: 'panel' }, title(name, h('small', {}, `${P.PERIODS[b.period]}・${P.SCOPES[b.scope]}${b.month ? `・${monthTitle(b.month)}だけ` : ''}`),
        button('編集', () => budgetEditor(app, b), 'outline small', { 'aria-label': `${name}の予算を編集` })),
      row('使った金額', yen(s.used), 'large'), row('予算', yen(b.amount)), meter(s.percent, s.over > 0, `予算の${s.percent}%を使用`),
      row('消化率', `${s.percent}%`), s.over ? row('超過', yen(s.over), 'expense') : row('残り', yen(s.remaining), 'income'),
      s.forecast ? [row(`${yearly ? '年' : '期間'}末の予測`, yen(s.forecast.amount), s.willExceed ? 'net' : ''), s.willExceed ? note('このままだと予算を超える見込みです。', 'note warn') : null,
        note(`予測 ＝ 実績＋残りの予定 ${yen(s.forecast.planned)}＋ほかの支出の見込み ${yen(s.forecast.variableRest)}${s.forecast.unknown ? `（金額未定の予定${s.forecast.unknown}件を除く）` : ''}`)] : null,
      row(yearly ? '前の年' : '前の期間', `${yen(s.previous)}（差 ${signed(s.used - s.previous)}）`), note(`${s.range.start} 〜 ${s.range.end}`));
    })) : panel(null, note('予算はまだありません。支出全体や項目ごとに、月間・年間の予算を決められます。', 'message')));
}

function budgetEditor(app, budget = null) {
  const { data } = app.store;
  editorSheet(app, budget ? '予算の編集' : '予算の追加', () => {
    const options = [['', '支出全体'], ...L.groups(data, 'expense').map((g) => [g.id, `【大項目】${g.name}`]), ...L.selectable(data, 'expense').map((c) => [c.id, L.categoryPath(data, c.id)])];
    if (budget?.categoryID && !options.some(([id]) => id === budget.categoryID)) options.push([budget.categoryID, L.categoryPath(data, budget.categoryID)]);
    const period = selectField('期間', Object.entries(P.PERIODS), budget?.period ?? 'monthly');
    const scope = selectField('区分', Object.entries(P.SCOPES), budget?.scope ?? (app.scope === 'all' ? 'personal' : app.scope));
    const category = selectField('対象', options, budget?.categoryID ?? '');
    const amount = moneyField('予算の金額（円）', budget?.amount);
    const month = budget?.month ?? app.month;
    const only = checkField(`${monthTitle(month)}だけの予算にする`, !!budget?.month);
    const onlyRow = h('div', {}, only.element);
    const toggle = () => { onlyRow.hidden = period.input.value !== 'monthly'; };
    period.input.addEventListener('change', toggle);
    toggle();
    return {
      content: [period.element, scope.element, category.element, amount.element, onlyRow, note('同じ対象の予算がある場合は、新しい金額に置き換えます。その月だけの予算は、毎月の予算より優先します。')],
      save: async () => {
        requireValid(amount);
        await app.store.saveBudget({ period: period.value(), scope: scope.value(), categoryID: category.value(), amount: amount.value() ?? 0, month: period.value() === 'monthly' && only.value() ? month : null }, budget?.id);
      },
      remove: budget ? { title: 'この予算を削除しますか？', message: '支出の記録は残ります。', run: () => app.store.deleteBudget(budget.id) } : null,
    };
  }, { head: 'budget' });
}

function goals(app) {
  const { data } = app.store;
  const now = today();
  const list = P.activeGoals(data);
  const hidden = L.live(data.goals).filter((g) => g.isArchived);
  const share = P.allocation(data, now);
  const card = (goal) => {
    const s = P.goalStatus(data, goal, now);
    return h('section', { className: 'panel' }, title(goal.name, goal.isArchived ? h('small', {}, '終了') : null, button('編集', () => goalEditor(app, goal), 'outline small', { 'aria-label': `目標${goal.name}を編集` })),
      s.saved == null ? note('口座の初期残高が未入力のため、現在の金額が分かりません。', 'note warn') : [
        row('現在の金額', yen(s.saved), 'large'), row('目標の金額', yen(goal.targetAmount)), meter(s.percent, false, `目標の${s.percent}%`), row('達成率', `${s.percent}%`), row('残り', yen(s.remaining)),
        goal.targetDay ? row('期限', `${goal.targetDay}${s.overdue ? '（過ぎています）' : s.monthsLeft ? `（あと${s.monthsLeft}か月）` : ''}`) : null,
        s.required ? row('毎月の必要額', yen(s.required)) : null,
        row('直近3か月の増え方（月平均）', s.pace == null ? '記録が足りません' : signed(s.pace)),
        s.remaining ? row('このペースの達成予定', s.reachMonth ? monthTitle(s.reachMonth) : '計算できません') : note('達成しました。')],
      s.account ? note(`口座「${s.account.name}」の残高を現在の金額にしています。`) : null,
      h('div', { className: 'actions start' }, goal.accountID ? null : button('積み立てを記録', () => depositSheet(app, goal.id), 'outline', { 'aria-label': `${goal.name}の積み立てを記録` }),
        s.remaining ? button('試算する', () => simulationSheet(app, goal, s), 'outline', { 'aria-label': `${goal.name}を試算` }) : null));
  };
  return h('div', { className: 'stack' },
    h('div', { className: 'actions start' }, button('目標を追加', () => goalEditor(app), 'gold', { id: 'add-goal' })),
    share.isOver ? note(`目標に割り当てた金額の合計（${yen(share.allocated)}）が、総資産（${yen(share.assets)}）を超えています。同じお金を2回数えていないか確認してください。`, 'note warn') : null,
    list.length ? h('div', { className: 'cards' }, list.map(card)) : panel(null, note('目標はまだありません。緊急予備資金、旅行、教育などの目標を作れます。', 'message')),
    hidden.length ? [h('h3', {}, '終了した目標'), h('div', { className: 'cards' }, hidden.map(card))] : null);
}

const NAMES = ['緊急予備資金', '月間貯蓄', '年間貯蓄', '旅行資金', '教育資金', '住宅ローン返済', '自動車購入資金', 'AI事業資金', '独立資金', '老後資金'];

function goalEditor(app, goal = null) {
  editorSheet(app, goal ? '目標の編集' : '目標の追加', () => {
    const name = textField('目標の名前', goal?.name);
    const preset = selectField('候補から名前を選ぶ', [['', '—'], ...NAMES.map((n) => [n, n])]);
    preset.input.addEventListener('change', () => { if (preset.input.value) name.input.value = preset.input.value; });
    const amount = moneyField('目標の金額（円）', goal?.targetAmount);
    const day = dateField('達成したい日（任意）', goal?.targetDay);
    const account = accountField(app, '口座の残高を使う（任意）', goal?.accountID);
    const memo = textField('メモ', goal?.memo);
    const archived = checkField('終了した目標にする', goal?.isArchived);
    return {
      content: [name.element, goal ? null : preset.element, amount.element, day.element, account.element,
        note('口座を選ぶと、その残高が現在の金額になります（1つの口座は1つの目標にだけ使えます）。選ばない場合は、積み立てを記録します。'), memo.element, goal ? archived.element : null],
      save: async () => {
        requireValid(amount);
        await app.store.saveGoal({ name: name.value(), targetAmount: amount.value() ?? 0, targetDay: day.value(), accountID: account.value(), memo: memo.value(), isArchived: goal ? archived.value() : false }, goal?.id);
      },
      remove: goal ? { title: `目標「${goal.name}」を削除しますか？`, message: '目標と積み立ての記録を削除します。収入・支出や口座は変わりません。', run: () => app.store.deleteGoal(goal.id) } : null,
    };
  }, { head: 'goals' });
}

function depositSheet(app, goalID) {
  sheet('積み立ての記録', (close) => {
    const body = h('div', {});
    function draw() {
      const { data } = app.store;
      const goal = L.find(data.goals, goalID);
      const amount = moneyField('金額（円。取り崩しは -1000 のように）', null, { negative: true });
      const day = dateField('日付', today());
      const memo = textField('メモ');
      const failure = h('p', { className: 'error', role: 'alert' });
      const list = P.deposits(data, goalID);
      body.replaceChildren(note(goal.name, 'message'), amount.element, day.element, memo.element, failure,
        h('div', { className: 'actions start' }, button('記録する', async () => {
          try { requireValid(amount); await app.store.addDeposit(goalID, { day: day.value(), amount: amount.value() ?? 0, memo: memo.value() }); draw(); } catch (error) { failure.textContent = error.message; }
        }, 'gold', { id: 'add-deposit' })),
        note('目標のための記録です。収入・支出や口座の残高は変わりません。'),
        panel('これまでの記録', list.length ? list.map((d) => h('div', { className: 'due' }, h('span', {}, d.day, d.memo ? h('small', {}, d.memo) : null), h('span', {}, signed(d.amount)),
          button('削除', async () => {
            if (!(await confirmSheet('この積み立ての記録を削除しますか？', `${d.day}　${signed(d.amount)}`, '削除する'))) return;
            try { await app.store.deleteDeposit(d.id); draw(); } catch (error) { failure.textContent = error.message; }
          }, 'outline small', { 'aria-label': `${d.day}の積み立てを削除` }))) : note('記録はありません。')));
    }
    draw();
    return h('div', {}, body, h('div', { className: 'actions' }, button('閉じる', () => { close(); app.render(); }, 'gold')));
  }, { className: 'full', head: 'goals' });
}

function simulationSheet(app, goal, state) {
  sheet('条件を変えた試算', (close) => {
    const base = P.baseline(app.store.data, today());
    const current = moneyField('今の毎月の積立（円）', state.pace > 0 ? state.pace : base && base.net > 0 ? base.net : 0);
    const extra = moneyField('収入が毎月これだけ増えたら（円）', null);
    const cut = moneyField('支出を毎月これだけ減らしたら（円）', null);
    const result = h('div', { className: 'panel', id: 'simulation' });
    function draw() {
      const s = P.simulate(state.remaining, current.value() ?? 0, extra.value() ?? 0, cut.value() ?? 0, today());
      result.replaceChildren(row('毎月の積立', yen(s.monthly)), row('達成までの期間', s.months == null ? '届きません' : `${s.months}か月`, 'large'),
        row('達成の目安', s.month ? monthTitle(s.month) : '—'));
    }
    for (const f of [current, extra, cut]) f.input.addEventListener('input', draw);
    draw();
    return h('div', {}, note(`${goal.name}　残り ${yen(state.remaining)}`, 'message'), current.element, extra.element, cut.element, result,
      note('利息や値上がりは考えない単純な計算です。この試算は保存しません。'), h('div', { className: 'actions' }, button('閉じる', close, 'gold')));
  }, { head: 'goals' });
}
