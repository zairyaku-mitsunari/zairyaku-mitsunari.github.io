// 商品名から支出項目の候補を出す（Swift版の ItemClassifier と同じ規則。言葉の表は data/classifier.json）。
// 利用者の修正（itemRules）を覚えて優先する。外部には送らない。
import { live } from './ledger.js';
import { normalize } from './receipt.js';

export const sourceTitle = { learned: '前回の分類', custom: '独自の項目', keyword: '自動で推定', weak: '要確認', unknown: '要確認' };

/** 1文字の違い（抜け・余分・取り違え）以内か */
export function nearly(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (i === a.length && i === b.length) return true;
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i) || a.slice(i) === b.slice(i + 1);
}

/** text のどこかに word と1文字違いの並びがあるか */
const containsNearly = (text, word) => {
  for (const length of [word.length, word.length + 1, word.length - 1]) {
    for (let i = 0; i + length <= text.length; i++) if (nearly(text.slice(i, i + length), word)) return true;
  }
  return false;
};

/** 比較用の名前（数量・容量・記号・空白を除く） */
export const itemKey = (name) => normalize(name).toLowerCase()
  .replace(/\d+(\.\d+)?\s*(ml|l|g|kg|枚|本|個|コ|点|箱|袋|切|パック)/g, '')
  .replace(/[^\p{L}\p{M}]/gu, '');

/** 比較のために、半角・全角をそろえ、ひらがなをカタカナにする（Swift版の fold と同じ） */
export const fold = (text) => normalize(text).replace(/[\u3041-\u3096]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60)).toLowerCase();

// 3文字以下のカタカナの言葉は、別の言葉の一部に当たりやすい（ブ「ラック」、「パン」パース）。
// 前後がカタカナのときは、よくある組み合わせの言葉だけを認める。
const KATAKANA = /[ァ-ヺー]/;
const words = (text) => new Set(text.split(' ').map((w) => fold(w)));
/** 前にカタカナが付いてもよい言葉（メロン「パン」、レモン「サワー」） */
const TAILS = () => words('パン サンド ビール ワイン サワー シャツ ケーキ プリン ゼリー アイス コーラ ハム ガム グミ カレー ジャム チョコ サラダ チーズ トマト レタス レモン メロン ココア ラムネ パスタ バター ミンチ ナッツ サプリ マスク ノート インク トナー マイク マウス チェア ベルト ブーツ パンツ ズボン デニム ネイル コスメ カイロ タイヤ ゲーム ホエイ');
/** 後ろにカタカナが付いてもよい言葉（「カレー」ルウ、「チョコ」レート） */
const HEADS = () => words('アイス カレー チーズ チョコ サラダ トマト サンド サワー ゼリー グミ ココア レタス レモン メロン パスタ バター デニム ゲーム サプリ ハム ポカリ');
let tails = null, heads = null;

/** 言葉が、名前の中で意味のある位置にあるか。original は、折りたたむ前の同じ長さの文字列 */
function standsAlone(original, at, word) {
  const end = at + word.length;
  const span = original.slice(at, end);
  if (word.length > 3 || ![...span].every((c) => KATAKANA.test(c))) return true;
  tails ??= TAILS(); heads ??= HEADS();
  if (at > 0 && KATAKANA.test(original[at - 1]) && !tails.has(word)) return false;
  return !(end < original.length && KATAKANA.test(original[end]) && !heads.has(word));
}

export class Classifier {
  constructor(data, table) {
    this.categories = live(data.categories).filter((c) => !c.isHidden && !c.isGroup && c.kind === 'expense');
    this.rules = live(data.itemRules).sort((a, b) => b.updatedAt - a.updatedAt);
    this.table = table;
  }

  named(name) { return this.categories.find((c) => c.name === name)?.id; }

  longest(text, table) {
    // 別の言葉の一部に反応しないように、先に取り除く（位置がずれないよう、同じ長さの空白にする）
    const original = normalize(text);
    const target = (this.table.ignored ?? []).reduce((s, w) => s.split(fold(w)).join(' '.repeat(fold(w).length)), fold(text));
    // 長い言葉を優先する。同じ長さなら、後ろにある言葉（日本語では品物の種類）を優先する
    let best = null;
    for (const name of Object.keys(table).sort()) {
      const id = this.named(name);
      if (!id) continue;
      for (const word of table[name]) {
        const part = fold(word);
        let at = target.lastIndexOf(part);
        while (at >= 0 && !standsAlone(original, at, part)) at = at ? target.lastIndexOf(part, at - 1) : -1;
        if (at < 0) continue;
        const end = at + part.length;
        if (word.length > (best?.length ?? 0) || (word.length === best?.length && end > best.end)) best = { length: word.length, end, id };
      }
    }
    return best?.id;
  }

  /** 文字認識の読み違いを考えた推定。4文字以上の言葉が1文字違いで含まれ、候補の項目が1つに決まるときだけ。 */
  similar(name) {
    const found = new Set();
    const target = (this.table.ignored ?? []).reduce((s, w) => s.split(fold(w)).join(' '), fold(name));
    for (const [categoryName, words] of Object.entries(this.table.keywords)) {
      const id = this.named(categoryName);
      if (id && words.some((w) => w.length >= 4 && containsNearly(target, fold(w)))) found.add(id);
    }
    return found.size === 1 ? [...found][0] : null;
  }

  /** restaurant は、レシートにテーブル番号がある（飲食店）とき */
  suggest(name, store = null, { fuzzy = false, restaurant = false } = {}) {
    const key = itemKey(name);
    const usable = new Set(this.categories.map((c) => c.id));
    if (key) {
      const rule = this.rules.find((r) => r.key === key && usable.has(r.categoryID))
        ?? this.rules.find((r) => r.key.length >= 4 && key.includes(r.key) && usable.has(r.categoryID))
        // 画像の読み取りでは、直した言葉と1文字違いも同じ商品とみなす
        ?? (fuzzy ? this.rules.find((r) => r.key.length >= 5 && nearly(r.key, key) && usable.has(r.categoryID)) : undefined);
      if (rule) return { categoryID: rule.categoryID, source: 'learned' };
    }
    const defaults = new Set(this.table.defaultIDs);
    const own = this.categories.filter((c) => !defaults.has(c.id) && c.name.length >= 2 && normalize(name).toLowerCase().includes(normalize(c.name).toLowerCase()))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (own) return { categoryID: own.id, source: 'custom' };
    const dining = restaurant ? this.named('外食費') : null;
    if (dining) return { categoryID: dining, source: 'keyword' };
    // 飲食店や理美容・医療の店では、商品の言葉より店の種類を優先する
    if (store) {
      const shop = fold(store);
      for (const kind of this.table.serviceStores ?? []) {
        const found = this.named(kind);
        if (found && this.table.stores[kind].some((w) => shop.includes(fold(w)))) return { categoryID: found, source: 'keyword' };
      }
    }
    const id = this.longest(name, this.table.keywords);
    if (id) return { categoryID: id, source: 'keyword' };
    // ここからは自信がないので決めず、候補だけを示して利用者に確かめる
    const close = fuzzy ? this.similar(name) : null;
    if (close) return { categoryID: null, source: 'weak', candidate: close };
    const shop = store ? this.longest(store, this.table.stores) : null;
    if (!shop) return { categoryID: null, source: 'unknown' };
    // 給油所や書店には、ほかの品物もある。ほかの店の種類は、店で決める
    const mixed = [this.named('ガソリン代'), this.named('書籍')].includes(shop);
    return mixed ? { categoryID: null, source: 'weak', candidate: shop } : { categoryID: shop, source: 'keyword' };
  }
}
