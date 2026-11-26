// CSV出力。表計算ソフトで開ける形（先頭にBOM、改行はCRLF）。
import { live, find, inPeriod, categoryName, kindTitle, sourceName, expenseByCategory, summary, newestFirst } from './ledger.js';
import { balance, bills, totalAssets } from './finance.js';
import { loanBalance } from './schedule.js';
import { events, TYPES } from './calendar.js';
import { budgetStatuses, SCOPES, PERIODS } from './planning.js';
import { addDays } from './date.js';

/** 文字の先頭が式と解釈される記号なら、' を付けて文字として扱わせる（数値はそのまま） */
export function cell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  let text = String(value);
  if (/^[\s]*[=+\-@\t\r＝＋－＠]/.test(text)) text = `'${text}`;
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
export const toCSV = (rows) => `\ufeff${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;

const parentName = (data, id) => find(data.categories, find(data.categories, id)?.parentID)?.name ?? '';
const signedAmount = (t) => (t.kind === 'income' ? t.amount : t.kind === 'expense' ? -t.amount : t.kind === 'refund' ? t.amount : 0);

export function transactionRows(data, range, scope = 'all') {
  const list = (range ? inPeriod(data, range, scope) : live(data.transactions).filter((t) => scope === 'all' || t.scope === scope)).sort(newestFirst).reverse();
  return [['日付', '種類', '大項目', '項目', '金額', '収支への影響', '区分', '支払い方法・入金先', '店舗名・入金元', 'メモ'],
    ...list.map((t) => [t.day, kindTitle[t.kind], t.categoryID ? parentName(data, t.categoryID) : '', t.categoryID ? categoryName(data, t.categoryID) : '', t.amount, signedAmount(t),
      SCOPES[t.scope], sourceName(data, t), t.storeName ?? '', t.memo ?? ''])];
}

export function summaryRows(data, range, scope = 'all') {
  const sum = summary(data, range, scope);
  return [['期間', `${range.start}〜${range.end}`], ['区分', SCOPES[scope]], ['収入', sum.income], ['支出', sum.expense], ['収支', sum.net], [],
    ['大項目', '項目', '支出'], ...expenseByCategory(data, range, scope).map((x) => [parentName(data, x.categoryID), categoryName(data, x.categoryID), x.amount])];
}

export function scheduleRows(data, today, days = 90) {
  const state = { planned: '予定', overdue: '記録なし（予定日超過）', done: '実績', skipped: 'なし', info: 'お知らせ' };
  return [['日付', '種類', '名前', '金額', '入出金', '状態'],
    ...events(data, { start: addDays(today, -31), end: addDays(today, days) }, today).map((e) => [e.day, TYPES[e.type], e.title, e.amount, e.flow === 'in' ? '入金' : e.flow === 'out' ? '支払い' : '', state[e.state]])];
}

export function assetRows(data, today) {
  const rows = [['基準日', today], [], ['区分', '名前', '金額']];
  for (const a of live(data.accounts)) rows.push(['資産（口座）', a.name, balance(data, a, today) ?? '未入力']);
  for (const c of live(data.cards)) rows.push(['負債（カード未払い）', c.name, bills(data, c).filter((b) => !b.settled).reduce((s, b) => s + b.remaining, 0)]);
  for (const c of live(data.recurringCosts).filter((x) => x.kind === 'loan')) rows.push(['負債（ローン残高）', c.name, loanBalance(data, c)?.amount ?? '未入力']);
  rows.push([], ['総資産', '', totalAssets(data, today).amount ?? '未入力']);
  return rows;
}

export function budgetRows(data, month, today) {
  return [['期間', '区分', '対象', '予算', '使用額', '残り', '消化率(%)'],
    ...budgetStatuses(data, month, 'all', today).map((s) => [PERIODS[s.budget.period], SCOPES[s.budget.scope], s.budget.categoryID ? categoryName(data, s.budget.categoryID) : '支出全体', s.budget.amount, s.used, s.remaining, s.percent])];
}
