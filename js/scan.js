// 画像 → 文字認識 → 解析。
// 前処理とページの読み方を変えて何回か読み、金額のつじつまが合う結果を使う。
// 値は、どれかの読み取りで実際に読めたものだけを使う（計算で作らない）。
import { recognize } from './ocr.js';
import { prepareForOCR } from './image.js';
import { layoutLines, cleanOCRLine, parseDocument } from './core/receipt.js';
import { quality, combine, matches } from './core/combine.js';

/** [前処理, ページの読み方（4=1列で大きさが違う文章、6=1つのまとまった文章）, 横幅] */
export const PASSES = [['adaptive', '4'], ['flat', '6'], ['adaptive', '6'], ['gray', '4'], ['clean', '6'], ['flat', '6', 1000], ['sauvola', '6']];

export async function scan(canvas, today, onProgress = () => {}, passes = PASSES) {
  const attempts = [];
  const prepared = new Map();
  for (const [index, [mode, psm, width = 1400]] of passes.entries()) {
    const key = `${mode}/${width}`;
    if (!prepared.has(key)) prepared.set(key, prepareForOCR(canvas, { mode, width }));
    const image = prepared.get(key);
    const { fragments } = await recognize(image.canvas, (p) => onProgress((index + p) / passes.length), psm);
    // 文字らしいものが無い行（模様や影）は除く
    const lines = layoutLines(fragments).map(cleanOCRLine).filter((l) => (l.match(/[0-9A-Za-z぀-ヿ㐀-鿿]/g) ?? []).length >= 2);
    attempts.push({ lines, parsed: parseDocument(lines, today), cropped: image.cropped, angle: image.angle });
    const parsed = combine(attempts.map((a) => a.parsed));
    if (parsed.kind === 'statement' ? index > 0 : matches(parsed) && parsed.day) break; // 合計と内訳が一致
  }
  const parsed = combine(attempts.map((a) => a.parsed));
  const shown = [...attempts].sort((a, b) => quality(b.parsed) - quality(a.parsed))[0];
  return { lines: shown.lines, parsed, cropped: shown.cropped, angle: shown.angle, passes: attempts.length };
}
