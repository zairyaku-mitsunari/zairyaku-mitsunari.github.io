// 利用者が直した商品名を覚え、次の読み取りで使う。覚えた内容はこの端末の中だけに置く（記録の形式は変えない）。
import { normalize } from './receipt.js';
import { live } from './ledger.js';

export const LIMIT = 500;
/** 読み取った名前の比較用の形（空白と大文字小文字の違いは無視。数字は残す） */
export const readKey = (name) => normalize(name).replace(/\s/g, '').toLowerCase();

/**
 * 確認画面の結果を覚える。pairs は [{ read: 読み取った名前, name: 登録した名前 }]。
 * 読み取りのままに戻した名前は忘れる。古いものから LIMIT 件まで。
 */
export function remember(table, pairs) {
  const entries = new Map(table);
  for (const { read, name } of pairs) {
    const key = readKey(read ?? ''), value = (name ?? '').trim();
    if (!key || !value) continue;
    entries.delete(key);
    if (readKey(value) !== key) entries.set(key, value);
  }
  return [...entries].slice(-LIMIT);
}

const digits = (text) => (text.match(/\d+/g) ?? []).join(',');

/** 以前の記録にある名前のうち、1文字だけ違い（数字は同じ）、候補が1つに決まるもの */
function fromHistory(data, key) {
  if (key.length < 7) return null; // 短い名前は、別の商品と取り違えやすい
  const found = new Map();
  for (const receipt of live(data.receipts)) {
    for (const line of receipt.lines ?? []) {
      const other = readKey(line.name);
      if (other === key) return null; // 同じ名前を使ったことがある
      if (other.length !== key.length || digits(other) !== digits(key)) continue;
      let differences = 0;
      for (let i = 0; i < key.length && differences < 2; i++) if (key[i] !== other[i]) differences += 1;
      if (differences === 1) found.set(other, line.name);
    }
  }
  return found.size === 1 ? [...found.values()][0] : null;
}

/** 読み取った名前に使う名前。from は 'learned'（直した名前）・'history'（以前の記録）・null（読み取りのまま） */
export function apply(table, data, read) {
  const key = readKey(read);
  const learned = new Map(table).get(key);
  if (learned) return { name: learned, from: 'learned' };
  const past = fromHistory(data, key);
  return past ? { name: past, from: 'history' } : { name: read, from: null };
}
