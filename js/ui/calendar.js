// 財務カレンダー：日ごとの予定と実績、残高の見通し
import { h, button, panel, row, note } from './dom.js';
import { eventRow } from './payments.js';
import { lineChart, COLORS, short } from './chart.js';
import { events, forecast } from '../core/calendar.js';
import { holidays } from '../core/holidays.js';
import { yen } from '../core/money.js';
import { today, addDays, addMonths, monthRange, monthTitle, weekday, parts, daysBetween } from '../core/date.js';

export function calendarView(app) {
  const { data } = app.store;
  const now = today();
  const month = app.calendarMonth ?? now.slice(0, 7);
  const range = monthRange(month);
  const list = events(data, range, now);
  const byDay = list.reduce((m, e) => m.set(e.day, [...(m.get(e.day) ?? []), e]), new Map());
  const selected = app.calendarDay && app.calendarDay.startsWith(month) ? app.calendarDay : now.startsWith(month) ? now : range.start;
  const end = range.end > addDays(now, 60) ? range.end : addDays(now, 60);
  const view = forecast(data, now, daysBetween(now, end) > 400 ? addDays(now, 400) : end);
  const balances = new Map(view.days.map((d) => [d.day, d]));
  const move = (n) => { app.calendarMonth = addMonths(month, n); app.calendarDay = null; app.render(); };
  const cells = [];
  for (let i = 0; i < weekday(range.start); i++) cells.push(h('span', { className: 'cell empty' }));
  for (let day = range.start; day <= range.end; day = addDays(day, 1)) {
    const items = byDay.get(day) ?? [];
    const sum = (flow) => items.filter((e) => e.flow === flow && e.state !== 'skipped' && !e.byCard).reduce((s, e) => s + (e.amount ?? 0), 0);
    const holiday = holidays(Number(day.slice(0, 4))).get(day);
    const forecastDay = balances.get(day);
    const short_ = forecastDay?.balance != null && forecastDay.balance < 0;
    const income = sum('in'), expense = sum('out');
    const label = `${parts(day)[1]}月${parts(day)[2]}日${holiday ? `（${holiday}）` : ''}${items.length ? `、予定と実績${items.length}件` : ''}${short_ ? '、残高不足の見込み' : ''}`;
    const day_ = day;
    cells.push(h('button', { type: 'button', className: ['cell', day === selected ? 'selected' : '', day === now ? 'today' : '', weekday(day) === 0 || holiday ? 'sunday' : weekday(day) === 6 ? 'saturday' : '', short_ ? 'short' : ''].join(' '),
      'data-day': day, 'aria-label': label, 'aria-pressed': String(day === selected), onclick: () => { app.calendarDay = day_; app.render(); } },
    h('b', {}, String(parts(day)[2]), short_ ? ' !' : ''),
    income ? h('small', { className: 'in' }, `+${short(income)}`) : null, expense ? h('small', { className: 'out' }, `-${short(expense)}`) : null,
    !income && !expense && items.length ? h('small', {}, '●') : null));
  }
  const items = byDay.get(selected) ?? [];
  const day = balances.get(selected);
  const chartDays = view.days.filter((d, i) => i % Math.max(1, Math.floor(view.days.length / 60)) === 0 || i === view.days.length - 1 || d.balance < 0);
  return h('div', { className: 'stack' },
    h('div', { className: 'panel periodbar' }, button('‹', () => move(-1), 'step', { 'aria-label': 'カレンダーの前の月' }), h('strong', {}, monthTitle(month)), button('›', () => move(1), 'step', { 'aria-label': 'カレンダーの次の月' }),
      button('今日', () => { app.calendarMonth = null; app.calendarDay = null; app.render(); }, 'link')),
    h('div', { className: 'panel calendar' }, h('div', { className: 'weekdays' }, [...'日月火水木金土'].map((d) => h('span', {}, d))), h('div', { className: 'grid' }, cells),
      note('+は入金、−は支払い（予定と実績）。! は予定から計算した残高が不足する日です。')),
    panel(`${parts(selected)[1]}月${parts(selected)[2]}日の予定と実績`, items.length ? items.map((e) => eventRow(app, e, now)) : note('予定はありません。'),
      day && day.balance != null ? row('この日の終わりの残高の見通し', yen(day.balance), day.balance < 0 ? 'large expense' : 'large') : null),
    panel('残高の見通し（予定からの計算）',
      view.shortage ? note(`${view.shortage.day}に、現金・口座の残高が ${yen(-view.shortage.balance)} 不足する見込みです。`, 'note warn') : view.start != null ? note(`${view.days.at(-1).day}まで、不足する日はありません。`) : null,
      view.start == null ? note('口座の初期残高を入力すると、残高を見通せます。', 'note warn')
        : lineChart({ title: '残高の見通し', labels: chartDays.map((d) => `${parts(d.day)[1]}/${parts(d.day)[2]}`), series: [{ name: '残高の見通し', color: COLORS.blue, values: chartDays.map((d) => d.balance) }] }),
      note(`今日の残高に、給料の予定、固定費など、カードの引き落としを足し引きした予測です。日々の買い物などの支出は含みません。${view.unknownAccounts ? `初期残高が未入力の口座${view.unknownAccounts}件は含みません。` : ''}${view.unknownAmounts ? `金額が分からない予定${view.unknownAmounts}件は含みません。` : ''}`)));
}
