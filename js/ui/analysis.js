// 分析・軍議の画面（収支分析／財務軍議／見直し／相談）
import { h, button, panel, row, note, screenHead } from './dom.js';
import { dateField } from './form.js';
import { periodBar } from './screens.js';
import { meter } from './goals.js';
import { councilView, adviceView, consultView } from './insight.js';
import { diagnosisView } from './diagnosis.js';
import { lineChart, donutChart, COLORS } from './chart.js';
import { csvSheet } from './export.js';
import { trends } from '../core/diagnosis.js';
import { compare as changes } from '../core/trends.js';
import { stop } from './voice.js';
import * as L from '../core/ledger.js';
import * as F from '../core/finance.js';
import { yen, signed } from '../core/money.js';
import { addDays, addMonths, daysBetween, isDay, today, monthTitle } from '../core/date.js';

export const TABS = [['report', '収支分析'], ['diagnosis', '診断'], ['council', '財務軍議'], ['advice', '見直し'], ['consult', '相談']];

export function analysisView(app) {
  const body = { report: reportView, diagnosis: diagnosisView, council: councilView, advice: adviceView, consult: consultView }[app.analysisTab] ?? reportView;
  const head = { report: 'analysis' }[app.analysisTab] ?? app.analysisTab;
  return h('div', { className: 'screen' },
    screenHead(head),
    h('div', { className: 'tabs five no-print' }, TABS.map(([id, text]) => button(text, () => { stop(); app.analysisTab = id; app.render(); }, id === app.analysisTab ? 'gold' : 'outline', { 'aria-pressed': String(id === app.analysisTab), 'data-analysis': id }))),
    body(app));
}

/** 表示する期間と、比べる前の期間 */
function selectedRange(app) {
  const { data } = app.store;
  const year = Number(app.month.slice(0, 4));
  if (app.span === 'year') {
    const range = (y) => ({ start: F.periodRange(`${y}-01`, data).start, end: F.periodRange(`${y}-12`, data).end });
    return { range: range(year), previous: range(year - 1), label: `${year}年` };
  }
  if (app.span === 'custom') {
    const { start, end } = app.custom;
    if (!isDay(start ?? '') || !isDay(end ?? '') || start > end) return null;
    const length = daysBetween(start, end);
    return { range: { start, end }, previous: { start: addDays(start, -length - 1), end: addDays(start, -1) }, label: `${start} 〜 ${end}` };
  }
  return { range: F.periodRange(app.month, data), previous: F.periodRange(addMonths(app.month, -1), data), label: `${monthTitle(app.month)}度` };
}

/** 支出の変化：月度の途中は、前の月度も同じ日数までで比べる */
function changePanel(app) {
  const r = changes(app.store.data, app.month, app.scope, today());
  if (!r.comparable || !r.rows.length) return null;
  const list = r.rows.slice(0, 6);
  return panel(app.scope === 'business' ? '経費の変化' : '支出の変化',
    row(r.now === r.past ? '前の月度と同じ' : r.now > r.past ? '前の月度より増加' : '前の月度より減少', signed(r.now - r.past), 'large'),
    list.map((x) => row(x.name, `${signed(x.diff)}（${yen(x.past)} → ${yen(x.now)}）`)),
    note(`${r.current.start}〜${r.current.end} と ${r.previous.start}〜${r.previous.end} を比べています。${r.partial ? '月度の途中のため、同じ日数までの比較です。' : ''}変化の大きい順に${list.length}項目。`));
}

function reportView(app) {
  const { data } = app.store;
  const span = h('select', { 'aria-label': '期間の種類', onchange: () => {
    app.span = span.value;
    if (span.value === 'custom' && !app.custom.start) app.custom = F.periodRange(app.month, data);
    app.render();
  } }, [['month', '月度ごと'], ['year', '1年ごと'], ['custom', '期間を指定']].map(([v, t]) => h('option', { value: v }, t)));
  span.value = app.span;
  const selected = selectedRange(app);
  const custom = () => {
    const start = dateField('開始日', app.custom.start), end = dateField('終了日', app.custom.end);
    for (const [key, f] of [['start', start], ['end', end]]) f.input.addEventListener('change', () => { app.custom = { ...app.custom, [key]: f.value() }; app.render(); });
    return panel(null, start.element, end.element, app.scopeSelect());
  };
  const head = [h('div', { className: 'controls' }, span), app.span === 'month' ? periodBar(app) : app.span === 'custom' ? custom()
    : h('div', { className: 'panel periodbar' }, button('‹', () => app.shiftMonth(-12), 'step', { 'aria-label': '前の年' }), h('strong', {}, selected.label), button('›', () => app.shiftMonth(12), 'step', { 'aria-label': '次の年' }), app.scopeSelect())];
  if (!selected) return h('div', { className: 'stack' }, head, note('開始日と終了日を正しく指定してください。', 'note warn'));
  const { range, previous } = selected;
  const sum = L.summary(data, range, app.scope);
  const before = L.summary(data, previous, app.scope);
  const totals = L.expenseByCategory(data, range, app.scope).filter((x) => x.amount > 0);
  const max = totals[0]?.amount ?? 1;
  const whole = totals.reduce((s, x) => s + x.amount, 0);
  const business = app.scope === 'business';
  const [inName, outName, netName] = business ? ['売上', '経費', '利益'] : ['収入', '支出', '収支'];
  // 固定費・変動費（記録の指定がなければ項目の初期値）
  const nature = { fixed: 0, variable: 0, unknown: 0 };
  for (const t of L.inPeriod(data, range, app.scope)) {
    if (t.kind !== 'expense' && t.kind !== 'refund') continue;
    nature[t.costNature ?? L.find(data.categories, t.categoryID)?.costNature ?? 'unknown'] += t.kind === 'refund' ? -t.amount : t.amount;
  }
  const series = trends(data, today(), app.scope);
  const cards = L.live(data.cards).map((c) => [c.name, L.cardUsage(data, range, app.scope, c.id)]).filter(([, v]) => v);
  // 前の期間に記録がないときは、差を出さない
  const hasBefore = L.inPeriod(data, previous, app.scope).some((t) => ['income', 'expense', 'refund'].includes(t.kind));
  const compare = (label, now, old, className) => [row(label, yen(now), className), hasBefore ? h('p', { className: 'diff' }, `前の期間との差 ${signed(now - old)}`) : null];
  return h('div', { className: 'stack' }, head,
    panel(netName, compare(inName, sum.income, before.income, 'income'), compare(outName, sum.expense, before.expense, 'expense'), row(netName, yen(sum.net), 'large net'),
      note(`${range.start} 〜 ${range.end} に記録した実績です。${hasBefore ? `前の期間は ${previous.start} 〜 ${previous.end}。` : '前の期間の記録はありません。'}`)),
    app.span === 'month' ? changePanel(app) : null,
    panel(`項目別の${outName}`, totals.length ? totals.map((x) => {
      const share = `${(Math.round((x.amount * 1000) / whole) / 10).toFixed(1)}%`;
      return h('div', { className: 'bar' }, h('div', { className: 'row' }, h('span', {}, L.categoryName(data, x.categoryID)), h('span', {}, `${yen(x.amount)}　${share}`)),
        meter((x.amount / max) * 100, false, `${L.categoryName(data, x.categoryID)} ${share}`));
    }) : note(`この期間の${outName}はまだありません。`)),
    whole ? panel('固定費と変動費', row('固定費', yen(nature.fixed)), row('変動費', yen(nature.variable)), nature.unknown ? row('区分が未設定', yen(nature.unknown)) : null) : null,
    cards.length ? panel('カード別の利用額', cards.map(([name, value]) => row(name, yen(value)))) : null,
    whole ? panel(`${outName}の割合`, donutChart({ title: `${outName}の割合`, items: totals.map((x) => ({ name: L.categoryName(data, x.categoryID), amount: x.amount })) })) : null,
    panel('直近12か月度の推移', lineChart({ title: `${inName}と${outName}の推移`, labels: series.map((s) => `${Number(s.month.slice(5))}月`), zero: true,
      series: [{ name: inName, color: COLORS.blue, values: series.map((s) => s.income) }, { name: outName, color: COLORS.gold, values: series.map((s) => s.expense) }] })),
    h('div', { className: 'actions start' }, button('CSV出力', () => csvSheet(app), 'outline', { id: 'open-csv' })));
}
