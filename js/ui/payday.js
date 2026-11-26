// 給料日・締め日と、収支の集計期間の設定。入金の記録。
import { h, button, sheet, panel, row, note } from './dom.js';
import { textField, moneyField, dateField, selectField, checkField, accountField, editorSheet, requireValid } from './form.js';
import * as L from '../core/ledger.js';
import * as F from '../core/finance.js';
import { SHIFTS, BASES, status, pending, isReceiptLinked } from '../core/payroll.js';
import { yen } from '../core/money.js';
import { today, addDays, monthTitle, weekdayName } from '../core/date.js';

const days = Array.from({ length: 31 }, (_, i) => [String(i + 1), `${i + 1}日`]).concat([['32', '月末']]);
const dayText = (d) => (d === 32 ? '月末' : `${d}日`);

export function paydaySheet(app) {
  sheet('給料日・締め日と集計期間', (close) => {
    const body = h('div', { className: 'stack' });
    const failure = h('p', { className: 'error', role: 'alert' });
    const apply = async (changes) => {
      failure.textContent = '';
      try { await app.store.saveSettings(changes); app.month = F.monthContaining(today(), app.store.data); } catch (error) { failure.textContent = error.message; }
      draw();
    };
    function setting(field, key, convert = (v) => v) {
      field.input.addEventListener('change', () => apply({ [key]: convert(field.input.type === 'checkbox' ? field.input.checked : field.input.value) }));
      return field.element;
    }
    function draw() {
      const { data } = app.store;
      const s = data.settings;
      const sources = L.live(data.incomeSources).sort((a, b) => a.createdAt - b.createdAt);
      const usable = sources.filter((x) => x.isActive && (s.periodBasis !== 'closing' || x.closingDay != null));
      const current = F.monthContaining(today(), data);
      const range = F.periodRange(current, data);
      const needsSource = ['payday', 'closing'].includes(s.periodBasis);
      body.replaceChildren(
        panel('収支の集計期間',
          setting(selectField('集計期間の区切り方', Object.entries(BASES), s.periodBasis), 'periodBasis'),
          s.periodBasis === 'custom' ? setting(selectField('毎月の開始日', days, String(s.periodStartDay ?? 1)), 'periodStartDay', Number) : null,
          needsSource && !usable.length ? note(s.periodBasis === 'closing' ? '締め日を入力した勤務先がないため、暦の月で集計しています。' : '勤務先がないため、暦の月で集計しています。下で追加してください。', 'note warn') : null,
          needsSource && usable.length > 1 ? setting(selectField('基準にする勤務先', usable.map((x) => [x.id, x.name]), F.basisSource(data)?.id), 'basisSourceID') : null,
          ['custom', 'payday'].includes(s.periodBasis) ? setting(selectField('月度の呼び方', [['start', '始まる月で呼ぶ'], ['end', '終わる月で呼ぶ']], s.paydayLabel), 'paydayLabel') : null,
          s.periodBasis === 'payday' ? setting(checkField('休日で給料日がずれたら、集計期間もずらす', s.periodFollowsShift), 'periodFollowsShift') : null,
          note(`今の期間（${monthTitle(current)}度）`), h('p', { className: 'range' }, `${range.start} 〜 ${range.end}`),
          note('ホーム・分析・取引履歴・予算の期間に反映します。記録そのものは変わりません。')),
        panel('勤務先・収入源', h('div', { className: 'actions start' }, button('勤務先を追加', () => sourceEditor(app, null, draw), 'gold', { id: 'add-source' })),
          sources.length ? sources.map((x) => h('div', { className: 'due' }, h('span', {}, h('b', {}, x.name, x.isActive ? '' : '（停止中）'),
            h('small', {}, `給料日 ${dayText(x.payDay)}・締め日 ${x.closingDay == null ? '未入力' : dayText(x.closingDay)}・休日は${SHIFTS[x.shift]}${x.bonuses.length ? `・賞与 年${x.bonuses.length}回` : ''}`)),
          h('span', {}, x.expectedAmount == null ? '金額未定' : yen(x.expectedAmount)), button('編集', () => sourceEditor(app, x, draw), 'outline small', { 'aria-label': `勤務先${x.name}を編集` }))) : note('まだ登録がありません。')),
        incomePanel(app, draw) ?? '');
    }
    draw();
    return h('div', {}, body, failure, h('div', { className: 'actions' }, button('閉じる', () => { close(); app.render(); }, 'gold')));
  }, { className: 'full', head: 'settings' });
}

/** 入金の予定（45日先まで）と、記録のない過去の予定 */
export function incomePanel(app, done) {
  const { data } = app.store;
  const now = today();
  const list = pending(data, { start: addDays(now, -62), end: addDays(now, 45) });
  if (!list.length) return null;
  return panel('入金の予定（実績ではありません）', list.slice(0, 12).map((o) => {
    const source = L.find(data.incomeSources, o.sourceID);
    return h('div', { className: 'due' }, h('span', {}, h('b', {}, source.name, o.bonusID ? '（賞与）' : ''),
      h('small', { className: o.day < now ? 'warn-text' : '' }, `${o.day}（${weekdayName(o.day)}）${o.day < now ? '・記録がありません' : ''}`)),
    h('span', {}, o.expectedAmount == null ? '金額未定' : yen(o.expectedAmount)),
    button('入金', () => incomeSheet(app, o, done), 'outline small', { 'aria-label': `${source.name} ${o.day}の入金を記録` }));
  }));
}

function sourceEditor(app, source, done) {
  const { data } = app.store;
  editorSheet(app, source ? '勤務先の編集' : '勤務先の追加', () => {
    const name = textField('勤務先・収入源の名前', source?.name);
    const payDay = selectField('給料日', days, String(source?.payDay ?? 25));
    const closing = selectField('締め日', [['', '未入力'], ...days], source?.closingDay != null ? String(source.closingDay) : '');
    const shift = selectField('給料日が休日のとき', Object.entries(SHIFTS), source?.shift ?? 'previous');
    const amount = moneyField('毎月の予定額（手取り・円）', source?.expectedAmount);
    const account = accountField(app, '入金先の口座', source?.accountID);
    const incomes = L.selectable(data, 'income');
    const category = selectField('収入の項目', [['', '未入力'], ...incomes.map((c) => [c.id, c.name])], source?.categoryID ?? incomes.find((c) => c.name === '給料')?.id ?? '');
    const scope = selectField('区分', [['personal', '個人用'], ['business', '事業用']], source?.scope ?? 'personal');
    const start = dateField('この日以降の予定を作る', source?.startDay ?? today());
    const active = checkField('利用する（入金の予定を作る）', source?.isActive ?? true);
    const bonuses = [];
    const bonusArea = h('div', {});
    function addBonus(bonus = null) {
      const month = selectField('賞与の月', Array.from({ length: 12 }, (_, i) => [String(i + 1), `${i + 1}月`]), String(bonus?.month ?? 6));
      const day = selectField('賞与の日', days, String(bonus?.day ?? 10));
      const money = moneyField('賞与の予定額（円）', bonus?.expectedAmount);
      const entry = { id: bonus?.id, month, day, money };
      const element = h('div', { className: 'subform' }, month.element, day.element, money.element,
        button('この賞与を外す', () => { bonuses.splice(bonuses.indexOf(entry), 1); element.remove(); }, 'outline small'));
      bonuses.push(entry);
      bonusArea.append(element);
    }
    (source?.bonuses ?? []).forEach(addBonus);
    return {
      content: [name.element, payDay.element, closing.element, shift.element, amount.element, account.element, category.element, scope.element, start.element, source ? active.element : null,
        h('h3', {}, '賞与（毎年）'), bonusArea, button('賞与を追加', () => addBonus(), 'outline small', { id: 'add-bonus' })],
      save: async () => {
        requireValid(amount, ...bonuses.map((b) => b.money));
        await app.store.saveIncomeSource({ name: name.value(), payDay: Number(payDay.value()), closingDay: closing.value() ? Number(closing.value()) : null, shift: shift.value(),
          expectedAmount: amount.value(), accountID: account.value(), categoryID: category.value(), scope: scope.value(), startDay: start.value(), isActive: source ? active.value() : true,
          bonuses: bonuses.map((b) => ({ id: b.id, month: Number(b.month.value()), day: Number(b.day.value()), expectedAmount: b.money.value() })) }, source?.id);
        done();
      },
      remove: source ? { title: `「${source.name}」の設定を削除しますか？`, message: '予定を作らなくなります。受け取った収入の記録は残ります。',
        run: async () => { await app.store.deleteIncomeSource(source.id); done(); } } : null,
    };
  }, { head: 'settings' });
}

function incomeSheet(app, occurrence, done) {
  const { data } = app.store;
  const source = L.find(data.incomeSources, occurrence.sourceID);
  editorSheet(app, '入金の記録', () => {
    const now = today();
    const method = selectField('記録のしかた', [['new', '新しく記録する'], ['link', '登録済みの収入を使う'], ['skip', 'この回は入金なし']], 'new');
    const amount = moneyField('入金された金額（円）', occurrence.expectedAmount);
    const day = dateField('入金された日', occurrence.day < now ? occurrence.day : now);
    const account = accountField(app, '入金先の口座', source.accountID);
    const incomes = L.selectable(data, 'income');
    const category = selectField('収入の項目', [['', '選んでください'], ...incomes.map((c) => [c.id, c.name])],
      source.categoryID ?? incomes.find((c) => c.name === (occurrence.bonusID ? '賞与' : '給料'))?.id ?? '');
    if (occurrence.bonusID) category.input.value = incomes.find((c) => c.name === '賞与')?.id ?? category.input.value;
    const from = addDays(occurrence.day, -20), to = addDays(occurrence.day, 20);
    const candidates = L.live(data.transactions).filter((t) => t.kind === 'income' && t.day >= from && t.day <= to && !isReceiptLinked(data, t.id)).sort(L.newestFirst);
    const linked = selectField('収入の記録', [['', '選んでください'], ...candidates.map((t) => [t.id, `${t.day}　${L.categoryName(data, t.categoryID)}　${yen(t.amount)}`])]);
    const parts = {
      new: h('div', {}, amount.element, day.element, account.element, category.element, note('すでに収入を登録している場合は「登録済みの収入を使う」を選んでください。')),
      link: h('div', {}, linked.element, candidates.length ? null : note('予定日の前後20日に、使える収入の記録がありません。')),
      skip: h('div', {}, note('収入は記録せず、この回の予定だけを済みにします。', 'message')),
    };
    const area = h('div', {}, parts.new);
    method.input.addEventListener('change', () => area.replaceChildren(parts[method.input.value]));
    return {
      saveText: '記録する',
      content: [note(`${source.name}　予定日 ${occurrence.day}`, 'message'), method.element, area],
      save: async () => {
        if (status(app.store.data, occurrence).type !== 'pending') throw new Error('この回は、すでに記録されています。');
        if (method.value() === 'new') {
          requireValid(amount);
          await app.store.receiveIncome(occurrence, { kind: 'income', day: day.value(), amount: amount.value() ?? 0, categoryID: category.value(), scope: source.scope, accountID: account.value(), storeName: source.name, memo: '' });
        } else if (method.value() === 'link') {
          if (!linked.value()) throw new Error('収入の記録を選んでください。');
          await app.store.linkIncome(occurrence, linked.value());
        } else await app.store.skipIncome(occurrence);
        done();
      },
    };
  }, { head: 'payments' });
}
