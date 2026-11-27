// 画像 → 文字認識 → 解析。
// ふだんは高精度の方式（PaddleOCR のモデル）。合計と内訳が合わなければ、条件を変えてもう一度読む。
// 高精度の方式を使えない端末では、予備の簡易な方式（Tesseract）で読み、そのことを画面に示す。
// 値は、どれかの読み取りで実際に読めたものだけを使う（計算で作らない）。
import { recognize as precise } from './ocr-paddle.js';
import { prepareForOCR } from './image.js';
import { layoutLines, cleanOCRLine, parseDocument } from './core/receipt.js';
import { quality, combine, matches } from './core/combine.js';
import { analyses, settle, doubtful } from './core/precise.js';

/** 高精度の方式の読み方。2回目は文字の枠を広めに、3回目は紙を切り抜かず小さめに読む。 */
export const PRECISE_PASSES = [{ side: 1280 }, { side: 1280, thresholds: { threshold: 0.2, boxThreshold: 0.45, unclip: 2.2 } }, { side: 960, paper: false }];

/** これ以上読み直さなくてよいか。内訳のない請求書は合計と日付、内訳が見つからない書類は2回まで。 */
export function settled(parsed, times) {
  if (parsed.kind === 'statement') return parsed.rows.length >= 3;
  if (parsed.total != null && parsed.day && !parsed.items.length) return parsed.kind === 'bill' || times >= 2;
  return !!(matches(parsed) && parsed.day);
}

export async function scanPrecise(canvas, today, onProgress = () => {}, passes = PRECISE_PASSES) {
  const attempts = [];
  let first = null, used = 0;
  for (const [index, options] of passes.entries()) {
    const read = await precise(canvas, (p) => onProgress((index + p) / passes.length), index ? { ...options, turn: first.turn } : options);
    first ??= read;
    attempts.push(...analyses(read, today));
    used += 1;
    if (settled(settle(attempts).parsed, used)) break;
  }
  const { lines, parsed } = settle(attempts);
  return { lines, parsed, engine: 'precise', passes: used, cropped: first.cropped, angle: first.angle, confidence: first.confidence, doubtful: doubtful(parsed, first.layouts[0]) };
}

/** 予備の方式の [前処理, ページの読み方（4=1列で大きさが違う文章、6=1つのまとまった文章）, 横幅] */
export const PASSES = [['adaptive', '4'], ['flat', '6'], ['adaptive', '6'], ['gray', '4'], ['clean', '6'], ['flat', '6', 1000], ['sauvola', '6']];

export async function scanSimple(canvas, today, onProgress = () => {}, passes = PASSES) {
  const { recognize } = await import('./ocr.js');
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
  return { lines: shown.lines, parsed, engine: 'simple', cropped: shown.cropped, angle: shown.angle, passes: attempts.length };
}

export async function scan(canvas, today, onProgress = () => {}) {
  try {
    return await scanPrecise(canvas, today, onProgress);
  } catch (error) {
    try { return { ...(await scanSimple(canvas, today, onProgress)), fallback: String(error?.message ?? error) }; } catch { throw error; }
  }
}
