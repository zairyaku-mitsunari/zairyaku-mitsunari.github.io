// CSV出力
import { h, button, sheet, note, saveFile } from './dom.js';
import { selectField, dateField } from './form.js';
import * as C from '../core/csv.js';
import { periodRange } from '../core/finance.js';
import { today, isDay, monthTitle } from '../core/date.js';

const KINDS = { transactions: '取引の明細', summary: '収支と項目別の集計', schedule: '支払い・入金の予定（90日先まで）', assets: '資産と負債（今日時点）', budgets: '予算の状況' };

export function csvSheet(app) {
  sheet('CSV出力', (close) => {
    const { data } = app.store;
    const kind = selectField('内容', Object.entries(KINDS), 'transactions');
    const span = selectField('期間', [['month', `${monthTitle(app.month)}度`], ['year', `${app.month.slice(0, 4)}年`], ['all', 'すべて'], ['custom', '期間を指定']], 'month');
    const current = periodRange(app.month, data);
    const start = dateField('出力の開始日', current.start), end = dateField('出力の終了日', current.end);
    const custom = h('div', {}, start.element, end.element);
    const status = h('p', { className: 'note', role: 'status' });
    const update = () => {
      span.element.hidden = !['transactions', 'summary'].includes(kind.value());
      custom.hidden = span.element.hidden || span.value() !== 'custom';
    };
    kind.input.addEventListener('change', update);
    span.input.addEventListener('change', update);
    update();
    function build() {
      const now = today();
      const year = app.month.slice(0, 4);
      const range = span.value() === 'month' ? current : span.value() === 'year' ? { start: periodRange(`${year}-01`, data).start, end: periodRange(`${year}-12`, data).end }
        : span.value() === 'custom' ? { start: start.value(), end: end.value() } : null;
      if (range && (!isDay(range.start ?? '') || !isDay(range.end ?? '') || range.start > range.end)) throw new Error('開始日と終了日を正しく指定してください。');
      const id = kind.value();
      const rows = id === 'transactions' ? C.transactionRows(data, range, app.scope) : id === 'summary' ? C.summaryRows(data, range ?? { start: '0000-01-01', end: '9999-12-31' }, app.scope)
        : id === 'schedule' ? C.scheduleRows(data, now) : id === 'assets' ? C.assetRows(data, now) : C.budgetRows(data, app.month, now);
      return { text: C.toCSV(rows), rows: rows.length, name: `zairyaku-${id}-${now}.csv` };
    }
    app.buildCSV = build; // テストで中身を確かめる
    return h('div', {}, kind.element, span.element, custom,
      note('CSVは暗号化されません。店舗名やメモも含みます。保存した場所と、人に渡すかどうかに注意してください。', 'note warn'), status,
      h('div', { className: 'actions' }, button('閉じる', close), button('書き出す', async () => {
        try { const file = build(); if (await saveFile(file.text, file.name, 'text/csv')) status.textContent = `書き出しました：${file.name}`; } catch (error) { status.textContent = error.message; }
      }, 'gold', { id: 'save-csv' })));
  }, { head: 'analysis' });
}
