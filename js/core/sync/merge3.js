// 同期の合わせ方：前回そろえた状態と比べる「3方向の合体」。
// ・片方だけが変えた項目は、その変更を採る（時計のずれに左右されない）
// ・両方が変えた項目は、更新が新しい方を採り、採らなかった内容を「競合の控え」に残す
// ・記録を消さない（削除は「削除した」という印として伝わる）
import { LISTS, suspectedDuplicates } from '../merge.js';
import { live, find, categoryName, kindTitle } from '../ledger.js';
import { yen } from '../money.js';

/** 欄の順番に左右されない文字列 */
export const stable = (value) => (Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`
    : JSON.stringify(value));

/** 短い指紋（変わったかどうかの判定用） */
export function mark(value) {
  const s = stable(value);
  let a = 0xdeadbeef, b = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 2654435761); b = Math.imul(b ^ c, 1597334677); }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return `${s.length.toString(36)}.${(4294967296 * (2097151 & b) + (a >>> 0)).toString(36)}`;
}

/** 前回そろえた状態の印 */
export function indexOf(data) {
  const base = { settings: mark(data.settings) };
  for (const key of LISTS) base[key] = Object.fromEntries(data[key].map((x) => [x.id, mark(x)]));
  return base;
}

export const sameData = (a, b) => LISTS.every((k) => a[k].length === b[k].length && (() => { const m = new Map(b[k].map((x) => [x.id, stable(x)])); return a[k].every((x) => m.get(x.id) === stable(x)); })()) && stable(a.settings) === stable(b.settings);

const untouched = (x) => x.updatedAt === x.createdAt;
const sameContent = ({ updatedAt: a, ...x }, { updatedAt: b, ...y }) => stable(x) === stable(y);

/** { data, conflicts: [{list, id, kept, discarded}], added, updated, suspects: [[端末側のID, 相手側のID]] } */
export function mergeSync(local, remote, base = null) {
  const data = { ...local };
  const conflicts = [];
  let added = 0, updated = 0;
  for (const key of LISTS) {
    const merged = new Map(local[key].map((x) => [x.id, x]));
    for (const theirs of remote[key]) {
      const mine = merged.get(theirs.id);
      if (!mine) { merged.set(theirs.id, theirs); added += 1; continue; }
      if (stable(mine) === stable(theirs)) continue;
      const before = base?.[key]?.[theirs.id];
      const mineChanged = before === undefined || mark(mine) !== before;
      const theirsChanged = before === undefined || mark(theirs) !== before;
      if (mineChanged && !theirsChanged) continue;
      if (theirsChanged && !mineChanged) { merged.set(theirs.id, theirs); updated += 1; continue; }
      const takeTheirs = (theirs.updatedAt ?? 0) >= (mine.updatedAt ?? 0);
      const [kept, discarded] = takeTheirs ? [theirs, mine] : [mine, theirs];
      if (takeTheirs) { merged.set(theirs.id, theirs); updated += 1; }
      // 一度も直していない初期値と、更新日時だけが違うものは控えにしない
      if (!untouched(discarded) && !sameContent(kept, discarded)) conflicts.push({ list: key, id: theirs.id, kept, discarded });
    }
    data[key] = [...merged.values()];
  }
  if (stable(local.settings) !== stable(remote.settings)) {
    const mineChanged = !base || mark(local.settings) !== base.settings;
    const theirsChanged = !base || mark(remote.settings) !== base.settings;
    const takeTheirs = theirsChanged && (!mineChanged || (remote.settings.updatedAt ?? 0) >= (local.settings.updatedAt ?? 0));
    if (takeTheirs) data.settings = remote.settings;
    if (mineChanged && theirsChanged && base) conflicts.push({ list: 'settings', id: 'settings', kept: takeTheirs ? remote.settings : local.settings, discarded: takeTheirs ? local.settings : remote.settings });
  }
  // 前回の後に、両方の端末で別々に追加した「同じ金額の支払い」（二重登録の疑い）
  const fresh = (list) => ({ transactions: list.filter((t) => base?.transactions?.[t.id] === undefined) });
  const remoteIDs = new Set(remote.transactions.map((t) => t.id));
  const localIDs = new Set(local.transactions.map((t) => t.id));
  const suspects = suspectedDuplicates({ transactions: fresh(local.transactions).transactions.filter((t) => !remoteIDs.has(t.id)) },
    { transactions: fresh(remote.transactions).transactions.filter((t) => !localIDs.has(t.id)) }).map((s) => [s.local.id, s.incoming.id]);
  return { data, conflicts, added, updated, suspects };
}

/** 合わせた後に、利用者に確かめてもらうこと */
export function reviewItems(data, suspects = []) {
  const items = [];
  const entry = (t) => `${t.day} ${kindTitle[t.kind]} ${yen(t.amount)} ${t.storeName || (t.categoryID ? categoryName(data, t.categoryID) : '')}`;
  const alive = new Map(live(data.transactions).map((t) => [t.id, t]));
  for (const [a, b] of suspects) {
    if (!alive.has(a) || !alive.has(b)) continue;
    items.push({ key: `twice:${[a, b].sort().join(':')}`, type: 'duplicate', title: '同じ支払いが両方の端末で登録された可能性があります', detail: [entry(alive.get(a)), entry(alive.get(b))], ids: [a, b] });
  }
  const groups = (list, key) => [...list.reduce((m, x) => { const k = key(x); if (k) m.set(k, [...(m.get(k) ?? []), x]); return m; }, new Map()).values()].filter((g) => g.length > 1);
  const paid = live(data.recurringPayments).filter((p) => p.isSkipped || alive.has(p.entryID));
  for (const g of groups(paid, (p) => `${p.recurringID}/${p.dueMonth}`)) {
    const name = find(data.recurringCosts, g[0].recurringID)?.name ?? '固定費';
    items.push({ key: `paid:${g.map((p) => p.id).sort().join(':')}`, type: 'payment', title: `${name}（${g[0].dueMonth}）の支払いが${g.length}件あります`,
      detail: g.map((p) => (p.isSkipped ? '今回は払わない' : entry(alive.get(p.entryID)))), ids: g.map((p) => p.id) });
  }
  const received = live(data.incomeReceipts).filter((r) => r.isSkipped || alive.has(r.entryID));
  for (const g of groups(received, (r) => `${r.sourceID}/${r.month}/${r.bonusID ?? ''}`)) {
    items.push({ key: `received:${g.map((r) => r.id).sort().join(':')}`, type: 'income', title: `${find(data.incomeSources, g[0].sourceID)?.name ?? '収入'}（${g[0].month}）の入金が${g.length}件あります`,
      detail: g.map((r) => (r.isSkipped ? '入金なし' : entry(alive.get(r.entryID)))), ids: g.map((r) => r.id) });
  }
  const add = (type, g, title, detail) => items.push({ key: `${type}:${g.map((x) => x.id).sort().join(':')}`, type, title, detail, ids: g.map((x) => x.id) });
  for (const g of groups(live(data.budgets), (b) => `${b.period}/${b.scope}/${b.categoryID ?? ''}/${b.month ?? ''}`)) add('budget', g, '同じ対象の予算が2つあります', g.map((b) => yen(b.amount)));
  for (const g of groups(live(data.goals).filter((x) => !x.isArchived), (x) => x.accountID)) add('goal', g, '1つの口座を複数の目標が使っています', g.map((x) => x.name));
  for (const key of ['accounts', 'cards']) for (const g of groups(live(data[key]), (x) => x.name)) add(key, g, `同じ名前の${key === 'accounts' ? '口座' : 'カード'}が${g.length}件あります`, [g[0].name]);
  for (const g of groups(live(data.categories), (c) => `${c.kind}/${c.isGroup}/${c.name}`)) add('category', g, '同じ名前の項目が複数あります', [g[0].name]);
  for (const t of alive.values()) {
    const refunds = live(data.transactions).filter((r) => r.kind === 'refund' && r.refundOfID === t.id);
    const total = refunds.reduce((s, r) => s + r.amount, 0);
    if (total > t.amount) add('refund', [t, ...refunds], '返金の合計が支払額を超えています', [entry(t), `返金 ${yen(total)}`]);
    if (t.categoryID && find(data.categories, t.categoryID)?.deletedAt != null) add('gone', [t], '削除した項目を使っている記録があります', [entry(t)]);
  }
  return items;
}

/**
 * 過去の状態（置き場の版や端末の控え）に戻した内容を作る。戻した内容は「今の変更」として、ほかの端末にも伝わる。
 * 記録は消さない：控えにない記録は「削除した」印を付ける（後で戻せる）。
 */
export function revertTo(current, snapshot, now) {
  const data = { ...current };
  let changed = 0;
  for (const key of LISTS) {
    const old = new Map((snapshot[key] ?? []).map((x) => [x.id, x]));
    const result = current[key].map((item) => {
      const was = old.get(item.id);
      old.delete(item.id);
      if (!was) { if (item.deletedAt != null) return item; changed += 1; return { ...item, deletedAt: now, updatedAt: now }; }
      if (stable(was) === stable(item)) return item;
      changed += 1;
      return { ...was, updatedAt: now };
    });
    for (const item of old.values()) { result.push({ ...item, updatedAt: now }); changed += 1; }
    data[key] = result;
  }
  if (stable(current.settings) !== stable(snapshot.settings)) { data.settings = { ...snapshot.settings, updatedAt: now }; changed += 1; }
  return { data, changed };
}

/** 大きく減っていないか（誤って消した内容や壊れた内容を、そのまま取り込まないため） */
export function shrink(previousCounts, data) {
  const lost = [];
  const counts = liveCounts(data);
  for (const [key, before] of Object.entries(previousCounts ?? {})) {
    const gone = before - (counts[key] ?? 0);
    if (gone > Math.max(10, Math.floor(before * 0.3))) lost.push({ list: key, before, after: counts[key] ?? 0 });
  }
  return lost;
}
export const liveCounts = (data) => Object.fromEntries(LISTS.map((k) => [k, live(data[k]).length]));
