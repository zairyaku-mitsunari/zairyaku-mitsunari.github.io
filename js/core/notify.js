// お知らせ：支払い・入金の予定、予算、資金不足、契約の期限。記録と設定から都度作る。
import { addDays, daysBetween } from './date.js';
import { events, forecast, TYPES } from './calendar.js';
import { budgetStatuses } from './planning.js';
import { categoryName } from './ledger.js';
import { monthContaining } from './finance.js';
import { yen } from './money.js';

export const KINDS = { payment: '支払い・引き落としの予定', payday: '給料・入金の予定', overdue: '記録のない予定', budget: '予算の超過', shortage: '残高の不足の見込み', contract: '更新・無料期間の終了' };
export const DEFAULTS = { enabled: false, banner: false, amounts: false, daysBefore: 3, kinds: Object.keys(KINDS) };
export const DAYS = { 0: '当日', 1: '1日前から', 3: '3日前から', 7: '1週間前から', 14: '2週間前から' };

/** [{ key, kind, level(1が重要), day, title, detail, plain（金額を含まない文） }] */
export function alerts(data, today, prefs = DEFAULTS) {
  const p = { ...DEFAULTS, ...prefs };
  const result = [];
  const add = (kind, level, day, key, title, detail = '') => { if (p.kinds.includes(kind)) result.push({ kind, level, day, key: `${kind}:${key}`, title, detail }); };
  const when = (day) => { const n = daysBetween(today, day); return n === 0 ? '今日' : n === 1 ? '明日' : `${n}日後`; };
  const upcoming = events(data, { start: addDays(today, -62), end: addDays(today, Math.max(p.daysBefore, 30)) }, today);
  for (const e of upcoming) {
    const id = `${e.type}:${e.ref?.recurringID ?? e.ref?.cardID ?? e.ref?.occurrence?.sourceID}:${e.day}`;
    const money = e.amount == null ? '金額未定' : yen(e.amount);
    if (e.state === 'overdue') add('overdue', 1, e.day, id, `${e.title}：予定日を過ぎて記録がありません`, `${e.day}　${money}`);
    else if (e.state === 'planned' && daysBetween(today, e.day) <= p.daysBefore) {
      if (e.type === 'payday') add('payday', 3, e.day, id, `${when(e.day)}は ${e.title} の入金予定です`, `${e.day}　${money}`);
      else add('payment', daysBetween(today, e.day) <= 1 ? 1 : 2, e.day, id, `${when(e.day)}：${e.title}（${TYPES[e.type]}）`, `${e.day}　${money}${e.byCard ? '（カード払い）' : ''}`);
    } else if (e.state === 'info' && e.day >= today) {
      const limit = e.title.includes('無料期間') ? 7 : 30;
      if (daysBetween(today, e.day) <= limit) add('contract', 2, e.day, `${id}:${e.title}`, `${when(e.day)}：${e.title}`, e.day);
    }
  }
  const view = forecast(data, today, addDays(today, 45));
  if (view.shortage) add('shortage', 1, view.shortage.day, view.shortage.day, `${view.shortage.day}に現金・口座の残高が不足する見込みです`, `予定の支払いから計算した残高 ${yen(view.shortage.balance)}`);
  const month = monthContaining(today, data);
  for (const s of budgetStatuses(data, month, 'all', today)) {
    if (!s.over && !s.willExceed) continue;
    const name = s.budget.categoryID ? categoryName(data, s.budget.categoryID) : '支出全体';
    add('budget', s.over ? 1 : 2, today, `${s.budget.id}:${s.range.start}:${s.over ? 'over' : 'will'}`, s.over ? `${name}の予算を超えました` : `${name}の予算を超える見込みです`,
      s.over ? `超過 ${yen(s.over)}` : `予測 ${yen(s.forecast.amount)}／予算 ${yen(s.budget.amount)}`);
  }
  return result.sort((a, b) => a.level - b.level || (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** 端末の通知に出す文。金額を出さない設定では、金額を含む説明を省く。 */
export const bannerText = (alert, withAmounts) => (withAmounts && alert.detail ? `${alert.title}　${alert.detail}` : alert.title);
