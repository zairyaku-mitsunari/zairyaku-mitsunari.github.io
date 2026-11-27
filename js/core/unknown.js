// 不明金：現金や口座の「帳簿の残高」と「実際の残高」の差を記録し、後から使途が分かったら直す。
// 記録の形式は変えない（項目「不明金」の収入・支出として保存する）。Swift版の Unaccounted と同じ規則。
//
// 二重計上を防ぐ考え方：残高を合わせた日より前の支払いは、記録していなければ差額（不明金）に含まれている。
// 後からその支払いを記録するときは、同じ額を不明金から差し引く。
import { live, find, includesScope, isUnknownCategory, UNKNOWN } from './ledger.js';
import { balance, periodRange } from './finance.js';
import { isDay, addMonths, inRange } from './date.js';
import { yen, MAXIMUM } from './money.js';
import { Store, LedgerError } from './store.js';

export { isUnknownCategory };
const { name: NAME, ids: IDS } = UNKNOWN;

/** 不明金の記録（収入・支出） */
export const isUnknown = (data, t) => t.deletedAt == null && (t.kind === 'expense' || t.kind === 'income') && isUnknownCategory(data, t.categoryID);

const refundedOf = (data, id) => live(data.transactions).filter((t) => t.kind === 'refund' && t.refundOfID === id).reduce((s, t) => s + t.amount, 0);

/** 差し引くことができる不明金（返金の記録があるものは触らない） */
function openEntries(data, accountID, kind, test) {
  return live(data.transactions).filter((t) => isUnknown(data, t) && t.kind === kind && t.accountID === accountID && test(t.day) && !refundedOf(data, t.id));
}
const total = (list) => list.reduce((s, t) => s + t.amount, 0);
const byDay = (a, b) => (a.day !== b.day ? (a.day < b.day ? -1 : 1) : a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));

/** 残高を合わせるときの下調べ。error があれば記録できない。 */
export function plan(data, accountID, day, actual, today) {
  const account = live(data.accounts).find((a) => a.id === accountID);
  if (!account) return { error: '口座が見つかりません。' };
  if (!isDay(day ?? '')) return { error: '日付を指定してください。' };
  if (day > today) return { error: '今日より後の日付は指定できません。' };
  if (account.openingBalance == null) return { error: '先に、この口座の初期残高を入力してください（帳簿の残高が分かりません）。', needsBalance: true };
  if (account.openingDay && day < account.openingDay) return { error: `基準日（${account.openingDay}）より前の日付は指定できません。` };
  const later = live(data.transactions).filter((t) => isUnknown(data, t) && t.accountID === accountID && t.day > day);
  if (later.length) return { error: 'この日より後に、不明金の記録があります。日付を新しくするか、先にその記録を直してください（二重になるのを防ぎます）。' };
  const book = balance(data, account, day);
  if (actual == null) return { book };
  const difference = actual - book;
  const kind = difference > 0 ? 'income' : 'expense';
  const opposite = kind === 'income' ? 'expense' : 'income';
  const reducible = difference ? Math.min(Math.abs(difference), total(openEntries(data, accountID, opposite, (d) => d <= day))) : 0;
  return { book, difference, kind, opposite, reducible };
}

/** list の記録を、順に amount まで減らす。0円になった記録は削除する。減らした額を返す。 */
function reduce(list, amount, time) {
  let left = amount;
  for (const t of list) {
    if (!left) break;
    const cut = Math.min(left, t.amount);
    left -= cut;
    if (cut === t.amount) Object.assign(t, { deletedAt: time, updatedAt: time });
    else Object.assign(t, { amount: t.amount - cut, updatedAt: time });
  }
  return amount - left;
}

/** 不明金の項目。なければ作る（以前から使っているデータにも、使うときに用意する）。 */
export function categoryFor(data, kind, defaults) {
  const found = live(data.categories).find((c) => c.kind === kind && c.id === IDS[kind] && !c.isGroup)
    ?? live(data.categories).find((c) => c.kind === kind && !c.isGroup && c.name === NAME);
  if (found) return found.id;
  const template = defaults.categories.find((c) => c.id === IDS[kind]);
  const old = data.categories.findIndex((c) => c.id === IDS[kind]);
  if (old >= 0) data.categories.splice(old, 1); // 削除した項目を、もう一度使えるようにする
  data.categories.push({ ...template });
  return template.id;
}

/**
 * 新しい記録（収入・支出・振替）が、すでに記録した不明金に含まれているかもしれない分。
 * certain は、残高を合わせた日より前の支払いで、確実に含まれている場合。
 */
export function overlap(data, draft) {
  if (!isDay(draft.day ?? '') || !(draft.amount > 0)) return [];
  const sides = draft.kind === 'transfer' ? [[draft.accountID, 'expense'], [draft.destinationAccountID, 'income']]
    : (draft.kind === 'expense' || draft.kind === 'income') && !isUnknownCategory(data, draft.categoryID) ? [[draft.accountID, draft.kind]] : [];
  return sides.flatMap(([accountID, kind]) => {
    if (!accountID) return [];
    const list = openEntries(data, accountID, kind, (d) => d >= draft.day);
    const amount = Math.min(draft.amount, total(list));
    return amount ? [{ accountID, kind, amount, certain: list.some((t) => t.day > draft.day) }] : [];
  });
}

/** overlap の分を、日付の早い不明金から差し引く */
export function offset(data, draft, time) {
  return overlap(data, draft).reduce((sum, side) => sum + reduce(openEntries(data, side.accountID, side.kind, (d) => d >= draft.day).sort(byDay), side.amount, time), 0);
}

/** drafts を登録するとき、不明金から差し引ける額（データは変えない） */
export function preview(data, drafts) {
  const copy = { ...data, transactions: data.transactions.map((t) => ({ ...t })) };
  let amount = 0, certain = false;
  for (const draft of drafts) {
    const found = overlap(copy, draft);
    certain ||= found.some((f) => f.certain);
    amount += offset(copy, draft, 0);
  }
  return { amount, certain };
}

/** 月度ごとの不明金の金額と件数（古い順に count か月度） */
export function monthly(data, month, count = 12, scope = 'all') {
  const entries = live(data.transactions).filter((t) => isUnknown(data, t) && includesScope(scope, t.scope));
  return Array.from({ length: count }, (_, i) => {
    const m = addMonths(month, i - count + 1);
    const range = periodRange(m, data);
    return { month: m, ...sums(entries.filter((t) => inRange(t.day, range))) };
  });
}

function sums(list) {
  const out = { expense: 0, expenseCount: 0, income: 0, incomeCount: 0 };
  for (const t of list) { out[t.kind] += t.amount; out[`${t.kind}Count`] += 1; }
  return out;
}

export function inRangeSums(data, range, scope = 'all') {
  return sums(live(data.transactions).filter((t) => isUnknown(data, t) && includesScope(scope, t.scope) && inRange(t.day, range)));
}
export const hasUnknown = (data, scope = 'all') => live(data.transactions).some((t) => isUnknown(data, t) && includesScope(scope, t.scope));

/** 不明金が前の期間より増えたときの指摘（増えていなければ空） */
export function warnings(data, range, previous, scope = 'all') {
  const now = inRangeSums(data, range, scope), before = inRangeSums(data, previous, scope);
  return [['支出', 'expense'], ['収入', 'income']].flatMap(([label, key]) => {
    const increased = now[key] > before[key] || (now[`${key}Count`] > before[`${key}Count`] && now[key] > 0);
    return increased ? [`不明金（${label}）が増えています：${yen(now[key])}・${now[`${key}Count`]}件（前の期間 ${yen(before[key])}・${before[`${key}Count`]}件）。`] : [];
  });
}
export const ADVICE = '残高を合わせた日の前後のレシートや通帳を確かめ、使途が分かったら不明金の記録を直してください。';

const checked = (amount) => {
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAXIMUM) throw new LedgerError('金額は1円以上の整数で入力してください。');
};
function unknownRecord(data, id) {
  const record = data.transactions.find((t) => t.id === id);
  if (!record || !isUnknown(data, record)) throw new LedgerError('対象の不明金の記録が見つかりません。');
  if (refundedOf(data, id)) throw new LedgerError('返金の記録がある支出です。先に返金を削除してください。');
  return record;
}
/** 使途が分かった分の日付は、残高を合わせた日まで（後の日付にすると、合わせた残高がずれる） */
function earlier(day, record) {
  if (!isDay(day ?? '')) throw new LedgerError('日付を指定してください。');
  if (day > record.day) throw new LedgerError(`日付は、不明金を記録した日（${record.day}）までにしてください。`);
}

Object.assign(Store.prototype, {
  /**
   * 残高を合わせる。差がなければ何も記録しない。
   * useOpposite なら、逆向きの不明金（以前の記録）を先に減らして相殺する。
   */
  reconcile({ accountID, day, actual, scope = 'personal', useOpposite = true }, today) {
    return this.commit((data) => {
      if (!Number.isInteger(actual) || Math.abs(actual) > MAXIMUM) throw new LedgerError('実際の残高を整数で入力してください。');
      const p = plan(data, accountID, day, actual, today);
      if (p.error) throw new LedgerError(p.error);
      if (!p.difference) return { book: p.book, difference: 0, offset: 0, recorded: 0 };
      const time = this.now();
      let rest = Math.abs(p.difference);
      let offsetAmount = 0;
      if (useOpposite) {
        offsetAmount = reduce(openEntries(data, accountID, p.opposite, (d) => d <= day).sort(byDay).reverse(), rest, time);
        rest -= offsetAmount;
      }
      let record = null;
      if (rest) {
        record = { id: this.uuid(), kind: p.kind, day, amount: rest, categoryID: categoryFor(data, p.kind, this.defaults), scope, accountID,
          storeName: '', memo: `残高合わせ（帳簿 ${yen(p.book)}／実際 ${yen(actual)}）`, createdAt: time, updatedAt: time };
        if (p.kind === 'expense') record.costNature = 'variable';
        data.transactions.push(record);
      }
      return { book: p.book, difference: p.difference, offset: offsetAmount, recorded: rest, id: record?.id ?? null };
    });
  },

  /** 使途が分かった。全額なら元の記録の項目を直し、一部なら分ける（合計は変わらない）。 */
  identifyUnknown(id, { amount, categoryID, day, storeName = '', memo = '', scope }) {
    return this.commit((data) => {
      const record = unknownRecord(data, id);
      checked(amount);
      if (amount > record.amount) throw new LedgerError(`不明金の金額（${yen(record.amount)}）を超えています。`);
      earlier(day, record);
      const category = find(data.categories, categoryID);
      if (!category || category.deletedAt != null || category.isGroup || category.kind !== record.kind || isUnknownCategory(data, categoryID)) {
        throw new LedgerError('分かった使途の項目を選んでください。');
      }
      const time = this.now();
      const found = { day, amount, categoryID, scope: scope ?? record.scope, storeName: storeName.trim(), memo: memo.trim(), updatedAt: time };
      if (amount === record.amount) {
        Object.assign(record, found, { memo: found.memo || record.memo });
        return record;
      }
      Object.assign(record, { amount: record.amount - amount, updatedAt: time });
      const { receiptID, costNature, ...base } = record;
      const made = { ...base, ...found, id: this.uuid(), createdAt: time };
      if (record.kind === 'expense') made.costNature = category.costNature ?? 'variable';
      data.transactions.push(made);
      return made;
    });
  },

  /** 口座の間の移動だった。全額なら元の記録を振替にし、一部なら分ける。相手の口座の不明金も同じ額まで減らせる。 */
  unknownToTransfer(id, { otherID, amount, day, useCounterpart = true }) {
    return this.commit((data) => {
      const record = unknownRecord(data, id);
      checked(amount);
      if (amount > record.amount) throw new LedgerError(`不明金の金額（${yen(record.amount)}）を超えています。`);
      earlier(day, record);
      if (!record.accountID) throw new LedgerError('口座のない記録は、振替にできません。');
      if (!find(data.accounts, otherID)) throw new LedgerError('相手の口座を選んでください。');
      if (otherID === record.accountID) throw new LedgerError('振替元と振替先には別の口座を選んでください。');
      const out = record.kind === 'expense'; // 支出の不明金＝この口座から出た
      const time = this.now();
      const transfer = { id: record.id, kind: 'transfer', day, amount, scope: 'personal', storeName: '', memo: '不明金から直した振替',
        accountID: out ? record.accountID : otherID, destinationAccountID: out ? otherID : record.accountID, createdAt: record.createdAt, updatedAt: time };
      const counterpart = useCounterpart ? reduce(openEntries(data, otherID, out ? 'income' : 'expense', (d) => d >= day).filter((t) => t.id !== record.id).sort(byDay), amount, time) : 0;
      if (amount === record.amount) data.transactions[data.transactions.indexOf(record)] = transfer;
      else {
        Object.assign(record, { amount: record.amount - amount, updatedAt: time });
        data.transactions.push({ ...transfer, id: this.uuid(), createdAt: time });
      }
      return { counterpart };
    });
  },
});
