// 支払い予定の管理：期限切れとこれからの支払い・引き落とし、一回だけの予定、見送りの取り消し、カレンダーへの書き出し。
import { h, button, panel, row, note, saveFile } from './dom.js';
import { selectField } from './form.js';
import { paymentSheet, cardDetail, recurringEditor } from './assets.js';
import { alertsPanel, icsSheet } from './notify.js';
import { events, TYPES } from '../core/calendar.js';
import { yen } from '../core/money.js';
import { today, addDays, weekdayName } from '../core/date.js';

export function eventRow(app, e, now) {
  const money = e.amount == null ? '金額未定' : `${e.flow === 'in' ? '+' : ''}${yen(e.amount)}`;
  const state = { planned: '予定', overdue: '記録がありません', done: '実績', skipped: '今回はなし', info: 'お知らせ' }[e.state];
  let action = null;
  if (['planned', 'overdue'].includes(e.state) && e.ref?.recurringID) action = button('支払い', () => paymentSheet(app, e.ref.occurrence), 'outline small', { 'aria-label': `${e.title} ${e.day}の支払いを記録` });
  else if (['planned', 'overdue'].includes(e.state) && e.ref?.cardID) action = button('請求', () => cardDetail(app, e.ref.cardID), 'outline small', { 'aria-label': `${e.title}の請求を開く` });
  else if (e.state === 'skipped' && e.ref?.recurringID) action = button('取り消す', async () => { await app.perform(() => app.store.unskipRecurring(e.ref.occurrence)); app.render(); }, 'outline small', { 'aria-label': `${e.title} ${e.day}の見送りを取り消す` });
  return h('div', { className: `due event ${e.type} ${e.state}` }, h('span', {}, h('b', {}, e.title),
    h('small', { className: e.state === 'overdue' ? 'warn-text' : '' }, `${e.day}（${weekdayName(e.day)}）・${TYPES[e.type]}・${state}${e.byCard ? '・カード払い' : ''}${e.estimate ? '・未確定' : ''}`)),
  e.state === 'info' ? null : h('span', { className: e.flow === 'in' ? 'money income' : '' }, money), action);
}

export function paymentsView(app) {
  const now = today();
  const { data } = app.store;
  const span = selectField('表示する範囲', [['7', '7日先まで'], ['30', '30日先まで'], ['90', '90日先まで'], ['365', '1年先まで']], String(app.paymentSpan));
  span.input.addEventListener('change', () => { app.paymentSpan = Number(span.input.value); app.render(); });
  const all = events(data, { start: addDays(now, -62), end: addDays(now, app.paymentSpan) }, now, app.scope);
  const out = all.filter((e) => e.flow === 'out');
  const overdue = out.filter((e) => e.state === 'overdue');
  const upcoming = out.filter((e) => e.state === 'planned');
  const done = out.filter((e) => e.state === 'done' || e.state === 'skipped').reverse();
  // カード払いの固定費は引き落としに含まれるので、合計では二重に数えない
  const sum = (list) => list.filter((e) => !e.byCard).reduce((s, e) => s + (e.amount ?? 0), 0);
  const byCard = upcoming.filter((e) => e.byCard).reduce((s, e) => s + (e.amount ?? 0), 0);
  const unknown = upcoming.filter((e) => e.amount == null).length;
  return h('div', { className: 'stack' },
    alertsPanel(app),
    h('div', { className: 'actions start' },
      button('一回だけの予定を追加', () => recurringEditor(app, 'fixed', null, '', { cycle: 'once' }), 'gold', { id: 'add-once' }),
      button('カレンダーアプリに書き出す', () => icsSheet(app), 'outline', { id: 'export-ics' })),
    h('div', { className: 'controls' }, span.element, app.scopeSelect()),
    panel('これからの支払い（予定）', row('口座・現金から払う予定', yen(sum(upcoming)), 'large'), byCard ? row('カード払いの予定（引き落としは後日）', yen(byCard)) : null,
      overdue.length ? row('予定日を過ぎて記録がない分', yen(sum(overdue)), 'expense') : null,
      note(`予定の金額です。支払った記録ではありません。${unknown ? `金額が未定の${unknown}件は含みません。` : ''}カードの引き落とし額は、記録した利用の分です。`)),
    overdue.length ? panel('記録がない予定（支払い忘れか、記録もれ）', overdue.map((e) => eventRow(app, e, now))) : null,
    panel('これからの予定', upcoming.length ? upcoming.slice(0, 200).map((e) => eventRow(app, e, now)) : note('この範囲の予定はありません。')),
    done.length ? panel('最近の支払いと見送り（62日分）', done.slice(0, 60).map((e) => eventRow(app, e, now))) : null);
}
