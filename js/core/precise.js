// 高精度の文字認識の結果を解析する。行のまとめ方を何通りか試し、金額のつじつまが合うものを使う。
import { layoutLines, cleanOCRLine, parseDocument } from './receipt.js';
import { combine, quality } from './combine.js';

/** 読み取り1回分（layouts＝行のまとめ方ごとの断片）を解析する */
export function analyses(read, today) {
  return read.layouts.map((fragments) => {
    const lines = layoutLines(fragments).map(cleanOCRLine);
    return { lines, parsed: parseDocument(lines, today), fragments };
  });
}

/** 何通りかの解析を1つにする。値は、どれかで実際に読めたものだけ。 */
export function settle(attempts) {
  const parsed = combine(attempts.map((a) => a.parsed));
  const shown = [...attempts].sort((a, b) => quality(b.parsed) - quality(a.parsed))[0];
  return { lines: shown.lines, parsed };
}

/** 自信の低い断片に含まれる商品の名前 */
export function doubtful(parsed, fragments, limit = 0.8) {
  const weak = fragments.filter((f) => f.confidence < limit).map((f) => cleanOCRLine(f.text).replace(/\s/g, ''));
  return parsed.items.map((i) => i.name).filter((name) => {
    const compact = name.replace(/\s/g, '');
    return weak.some((t) => t.length >= 2 && (t.includes(compact) || compact.includes(t)));
  });
}
