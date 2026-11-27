// 不明金の画面：残高を合わせる／使途が分かったら直す／二重計上の注意／月ごとの表。使わなければ何も表示しない。
import { h, button, panel, row, note } from './dom.js';
import { moneyField, textField, dateField, selectField, checkField, accountField, editorSheet, requireValid } from './form.js';
import { categoryPicker } from './picker.js';
import { lineChart, COLORS } from './chart.js';
import * as L from '../core/ledger.js';
import * as U from '../core/unknown.js';
import { yen, signed } from '../core/money.js';
import { today, monthTitle } from '../core/date.js';
import { monthContaining, periodRange } from '../core/finance.js';

export function reconcileSheet(app, account) {
  editorSheet(app, '残高を合わせる', () => {
    const day = dateField('残高を確かめた日', today());
    day.input.max = today();
    const actual = moneyField('実際の残高（円）', null, { negative: true });
    const scope = selectField('区分', [['personal', '個人用'], ['business', '事業用']], app.scope === 'business' ? 'business' : 'personal');
    const useOpposite = checkField('以前の逆向きの不明金を先に減らして相殺する（おすすめ）', true);
    const result = h('div', { id: 'reconcile-result' });
    const data = () => app.store.data;
    const update = () => {
      const value = actual.value();
      const p = U.plan(data(), account.id, day.value(), value, today());
      useOpposite.element.hidden = !p.reducible;
      if (p.error) { result.replaceChildren(note(p.error, 'note warn')); return; }
      if (value == null) { result.replaceChildren(row('帳簿の残高', yen(p.book), 'large'), note('財布や通帳で確かめた残高を入力してください。')); return; }
      const offset = useOpposite.value() ? p.reducible : 0;
      const rest = Math.abs(p.difference) - offset;
      useOpposite.element.querySelector('span').textContent = `以前の不明金（${L.kindTitle[p.opposite]}）を先に ${yen(p.reducible)} 減らして相殺する（おすすめ）`;
      result.replaceChildren(row('帳簿の残高', yen(p.book)), row('差（実際 − 帳簿）', signed(p.difference), 'large'),
        note(!p.difference ? '差はありません。保存しても、何も記録しません。'
          : [offset ? `以前の不明金を ${yen(offset)} 減らします。` : '', rest ? `不明金（${L.kindTitle[p.kind]}）を ${yen(rest)} 記録します。` : '新しい記録は増えません。'].join(''), 'message'));
    };
    for (const input of [day.input, actual.input, useOpposite.input]) input.addEventListener('input', update);
    update();
    return {
      content: [note(`${account.name}の帳簿の残高と、実際の残高の差を「不明金」として記録します。使途が分かったら、記録を開いて直せます。`), day.element, actual.element, result, useOpposite.element, scope.element,
        note('先に、分かっている支払いや振替を記録すると、不明金を小さくできます。')],
      saveText: '残高を合わせる',
      save: async () => {
        requireValid(actual);
        if (actual.value() == null) throw new Error('実際の残高を入力してください。');
        const done = await app.store.reconcile({ accountID: account.id, day: day.value(), actual: actual.value(), scope: scope.value(), useOpposite: useOpposite.value() }, today());
        app.toast(!done.difference ? '差はありませんでした。' : done.recorded ? `不明金 ${yen(done.recorded)} を記録しました。` : `以前の不明金 ${yen(done.offset)} を相殺しました。`);
        if (done.difference) app.month = monthContaining(day.value(), app.store.data);
      },
    };
  }, { head: 'accounts' });
}

/** 使途が分かった分を、正しい項目の記録にする */
export function identifySheet(app, entry) {
  editorSheet(app, '使途が分かった分を直す', () => {
    const amount = moneyField('分かった金額（円）', entry.amount);
    const day = dateField('支払った日（入金日）', entry.day);
    day.input.max = entry.day;
    let categoryID = null;
    const category = button('項目を選んでください ›', () => categoryPicker(app, entry.kind, categoryID, (id) => {
      categoryID = id;
      category.textContent = L.categoryPath(app.store.data, id);
    }), 'select', { id: 'identify-category' });
    const store = textField('店舗名・入金元', '');
    const memo = textField('メモ', '');
    return {
      content: [note(`不明金（${L.kindTitle[entry.kind]}）${yen(entry.amount)}　${entry.day}`, 'message'), amount.element, day.element,
        h('div', { className: 'field' }, h('span', {}, '項目'), category), store.element, memo.element,
        note('一部だけ分かった場合は、残りは不明金のままです。合計と口座の残高は変わりません。レシートから登録し直す必要はありません（登録すると二重になります）。')],
      save: async () => {
        requireValid(amount);
        await app.store.identifyUnknown(entry.id, { amount: amount.value(), categoryID, day: day.value(), storeName: store.value(), memo: memo.value() });
        app.toast('不明金を直しました。');
      },
    };
  }, { head: 'input' });
}

/** 口座の間の移動（引き出し・チャージなど）だった */
export function toTransferSheet(app, entry) {
  editorSheet(app, '口座の移動（振替）に直す', () => {
    const out = entry.kind === 'expense';
    const other = accountField(app, out ? 'お金が移った先の口座' : 'お金が出た口座', '');
    const amount = moneyField('金額（円）', entry.amount);
    const day = dateField('移動した日', entry.day);
    day.input.max = entry.day;
    const counterpart = checkField('相手の口座の不明金も、同じ額まで減らす（おすすめ）', true);
    return {
      content: [note(`${L.sourceName(app.store.data, entry)} の不明金（${L.kindTitle[entry.kind]}）${yen(entry.amount)}`, 'message'), other.element, amount.element, day.element, counterpart.element,
        note('振替は、収入にも支出にも数えません。')],
      save: async () => {
        requireValid(amount);
        const done = await app.store.unknownToTransfer(entry.id, { otherID: other.value(), amount: amount.value(), day: day.value(), useCounterpart: counterpart.value() });
        app.toast(done.counterpart ? `振替に直し、相手の不明金 ${yen(done.counterpart)} も減らしました。` : '振替に直しました。');
      },
    };
  }, { head: 'input' });
}

/**
 * 新しい記録が不明金に含まれていそうなときの注意。drafts() は登録しようとしている記録の配列。
 * checked() が true なら、保存のとき alongside を渡して差し引く。
 */
export function overlapField(app, drafts) {
  const box = h('div', { className: 'overlap', hidden: true });
  const input = h('input', { type: 'checkbox', 'aria-label': '不明金から差し引く', id: 'offset-unknown' });
  let chosen = null;
  input.addEventListener('change', () => { chosen = input.checked; });
  const update = () => {
    const found = U.preview(app.store.data, drafts());
    box.hidden = !found.amount;
    if (!found.amount) { box.replaceChildren(); return; }
    input.checked = chosen ?? found.certain;
    box.replaceChildren(note('この支払いは、すでに記録した不明金に含まれている可能性があります。', 'note warn'),
      h('label', { className: 'check' }, input, h('span', {}, `不明金から ${yen(found.amount)} を差し引いて登録する（二重計上を防ぐ）`)),
      found.certain ? null : note('残高を合わせた日と同じ日の記録です。合わせる前の支払いなら、チェックしてください。'));
  };
  return { element: box, update, checked: () => !box.hidden && input.checked };
}

/** 不明金の記録を開いたときの、直し方のボタン */
export function unknownActions(app, entry, close) {
  return h('div', { className: 'panel' }, note('この記録は不明金です。使途が分かったら、ここから直せます。全部分かった場合は、下の項目を選び直して保存しても直せます。', 'message'),
    h('div', { className: 'actions start' }, button('使途が分かった分を直す', () => { close(); identifySheet(app, entry); }, 'outline', { id: 'identify-unknown' }),
      entry.accountID ? button('口座の移動（振替）だった', () => { close(); toTransferSheet(app, entry); }, 'outline', { id: 'unknown-transfer' }) : null));
}

/** 収支分析の「不明金」。不明金を使っていなければ何も出さない。 */
export function unknownPanel(app, range) {
  const { data } = app.store;
  if (!U.hasUnknown(data, app.scope)) return null;
  const now = U.inRangeSums(data, range, app.scope);
  const month = app.span === 'month' ? app.month : app.span === 'year' ? `${app.month.slice(0, 4)}-12` : monthContaining(today(), data);
  const series = U.monthly(data, month, 12, app.scope);
  const list = L.live(data.transactions).filter((t) => U.isUnknown(data, t) && L.includesScope(app.scope, t.scope) && t.day >= range.start && t.day <= range.end).sort(L.newestFirst);
  const cell = (amount, count) => (count ? `${yen(amount)}（${count}件）` : '—');
  return panel('不明金',
    row('支出の不明金', cell(now.expense, now.expenseCount), 'expense'), row('収入の不明金', cell(now.income, now.incomeCount), 'income'),
    list.slice(0, 8).map((t) => h('div', { className: 'row' }, h('span', {}, `${t.day}　${L.sourceName(data, t)}　${L.kindTitle[t.kind]} ${yen(t.amount)}`),
      button('直す', () => app.edit(t), 'outline small', { 'aria-label': `${t.day}の不明金 ${yen(t.amount)}を直す` }))),
    list.length > 8 ? note(`ほか${list.length - 8}件は、取引履歴で「不明金」を検索してください。`) : null,
    lineChart({ title: '不明金の推移', labels: series.map((s) => `${Number(s.month.slice(5))}月`), zero: true,
      series: [{ name: '支出の不明金', color: COLORS.gold, values: series.map((s) => s.expense) }, { name: '収入の不明金', color: COLORS.blue, values: series.map((s) => s.income) }] }),
    h('details', { id: 'unknown-table' }, h('summary', {}, '月ごとの金額と件数'),
      series.slice().reverse().map((s) => row(`${monthTitle(s.month)}度`, `支出 ${cell(s.expense, s.expenseCount)}　収入 ${cell(s.income, s.incomeCount)}`)),
      note(`${periodRange(series[0].month, data).start} 以降の12か月度です。`)));
}
