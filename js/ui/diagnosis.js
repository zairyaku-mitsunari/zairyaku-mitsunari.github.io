// 診断：指標、推移のグラフ、支出の分類
import { h, button, sheet, panel, row, note } from './dom.js';
import { lineChart, donutChart, COLORS } from './chart.js';
import { diagnose, trends, necessityBreakdown } from '../core/diagnosis.js';
import { NECESSITY } from '../core/category-store.js';
import { live, find, categoryPath } from '../core/ledger.js';
import { spent } from '../core/planning.js';
import { yen } from '../core/money.js';
import { today, addDays, parts } from '../core/date.js';

const LEVEL = { good: '良好', info: '参考', warn: '注意', unknown: '不明' };
const shortMonth = (m) => `${Number(m.slice(5))}月`;

export function diagnosisView(app) {
  const { data } = app.store;
  const now = today();
  const result = diagnose(data, now, app.scope);
  const series = trends(data, now, app.scope);
  const need = necessityBreakdown(data, now, app.scope);
  const labels = series.map((s) => shortMonth(s.month));
  return h('div', { className: 'stack' },
    h('div', { className: 'controls' }, app.scopeSelect()),
    panel('三成の財務診断', note('記録と設定から計算した指標です。生成AIは使っていません。目安は一般的な値で、あなたの家庭に合うとは限りません。', 'message')),
    h('div', { className: 'cards' }, result.metrics.map((m) => h('section', { className: 'panel metric', 'data-metric': m.id },
      h('p', { className: 'tags' }, h('span', { className: `badge level-${m.level}` }, LEVEL[m.level])), h('h2', {}, m.title), h('p', { className: 'metric-value' }, m.value), note(`根拠：${m.basis}`), m.comment ? note(m.comment, 'message') : null))),
    panel('収入と支出の推移（月度ごと）', lineChart({ title: '収入と支出の推移', labels, zero: true,
      series: [{ name: '収入', color: COLORS.blue, values: series.map((s) => s.income) }, { name: '支出', color: COLORS.gold, values: series.map((s) => s.expense) }] }),
      note('記録した実績です。今の月度は途中までの分です。')),
    panel('資産と負債の推移（月度の終わり）', lineChart({ title: '資産と負債の推移', labels, zero: true,
      series: [{ name: '総資産', color: COLORS.blue, values: series.map((s) => s.assets) }, { name: '負債', color: COLORS.gold, values: series.map((s) => s.debt) }] }),
      note('初期残高と記録から計算します。基準日より前など、分からない月は表示しません。負債はカードの未払いとローンの元本残高です。')),
    panel('支出の分類（直近3か月度）', donutChart({ title: '支出の分類', items: need.items.map((x) => ({ name: x.key ? NECESSITY[x.key] : '未分類', amount: x.amount })).sort((a, b) => b.amount - a.amount) }),
      note('分類はあなたが決めます。家族・健康・教育や事業の支出を、金額だけで無駄とは判断しません。'),
      h('div', { className: 'actions start' }, button('支出の分類をまとめて決める', () => classifySheet(app), 'outline', { id: 'open-classify' }))));
}

function classifySheet(app) {
  sheet('支出の分類', (close) => {
    const body = h('div', { className: 'stack' });
    const failure = h('p', { className: 'error', role: 'alert' });
    const draw = () => {
      const { data } = app.store;
      const range = { start: addDays(today(), -92), end: today() };
      const list = live(data.categories).filter((c) => c.kind === 'expense' && !c.isGroup).map((c) => ({ c, amount: spent(data, range, 'all', c.id) }))
        .filter((x) => x.amount > 0 || x.c.necessity).sort((a, b) => b.amount - a.amount);
      body.replaceChildren(...(list.length ? list.map(({ c, amount }) => {
        const select = h('select', { 'aria-label': `${c.name}の分類`, onchange: async () => { try { await app.store.updateCategory(c.id, { necessity: select.value }); failure.textContent = ''; } catch (error) { failure.textContent = error.message; } } },
          h('option', { value: '' }, '未分類'), Object.entries(NECESSITY).map(([v, t]) => h('option', { value: v }, t)));
        select.value = find(data.categories, c.id).necessity ?? '';
        return h('label', { className: 'field' }, h('span', {}, categoryPath(data, c.id), h('small', {}, `直近3か月 ${yen(amount)}`)), select);
      }) : [note('直近3か月の支出がありません。', 'message')]));
    };
    draw();
    return h('div', {}, note('支出の多い順です。ここで決めた分類は、見直しの候補と診断に使います。', 'message'), failure, body,
      h('div', { className: 'actions' }, button('閉じる', () => { close(); app.render(); }, 'gold')));
  }, { className: 'full', head: 'diagnosis' });
}
