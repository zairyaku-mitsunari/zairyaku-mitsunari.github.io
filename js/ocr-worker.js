// 高精度の文字認識（PaddleOCR のモデルを ONNX Runtime で動かす）。画面とは別の場所で動く。
// 同じサイトの部品だけを読み込み、画像はこの端末の中だけで処理する。
import * as ort from '../vendor/ort/ort.wasm.min.mjs';
import { resize, textBoxes, cropBox, planes, dictionary, decode, textAngle, groupRows, straightRows, offsetRows, findPaper, warp, evenLight } from './core/ocr-geometry.js';

let engine = null;
let models = new URL('../vendor/paddle/', import.meta.url).href;

ort.env.wasm.numThreads = 1; // GitHub Pages では複数の処理に分けられない
ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
ort.env.logLevel = 'error';

async function load(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('文字認識の部品を読み込めません。通信できる状態で一度試してください。');
  return response;
}

async function start(settings) {
  const [det, rec, yml] = await Promise.all([
    load(`${models}det.onnx`).then((r) => r.arrayBuffer()),
    load(`${models}rec.onnx`).then((r) => r.arrayBuffer()),
    load(`${models}rec.yml`).then((r) => r.text()),
  ]);
  const options = { executionProviders: ['wasm'], graphOptimizationLevel: 'all', ...settings };
  return {
    det: await ort.InferenceSession.create(det, options),
    rec: await ort.InferenceSession.create(rec, options),
    characters: dictionary(yml),
  };
}

async function detect(image, side, thresholds) {
  const scale = side / Math.max(image.width, image.height);
  const width = Math.max(32, Math.round((image.width * Math.min(scale, 2)) / 32) * 32);
  const height = Math.max(32, Math.round((image.height * Math.min(scale, 2)) / 32) * 32);
  const input = planes(resize(image, width, height), [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]);
  const output = await engine.det.run({ [engine.det.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, height, width]) });
  const map = output[engine.det.outputNames[0]];
  const boxes = textBoxes(map.data, width, height, thresholds);
  const sx = image.width / width, sy = image.height / height;
  return boxes.map((b) => ({ ...b, cx: b.cx * sx, cy: b.cy * sy, width: b.width * sx, height: b.height * sy }));
}

async function recognize(image, box) {
  const crop = cropBox(image, box);
  const width = Math.max(crop.width, 64);
  const input = planes(crop, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], width);
  const output = await engine.rec.run({ [engine.rec.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, 48, width]) });
  const result = output[engine.rec.outputNames[0]];
  const [, steps, classes] = result.dims;
  if (classes !== engine.characters.length + 2) throw new Error('文字認識の部品の組み合わせが違います。');
  return decode(result.data, steps, classes, engine.characters);
}

/** 縦向きの行が多い＝写真が横向き */
const sidewaysBoxes = (boxes) => boxes.length > 3 && boxes.filter((b) => b.height > b.width * 1.5).length > boxes.filter((b) => b.width > b.height * 1.5).length;

/** 紙を探して切り抜き、文字のある場所を調べる */
async function locate(source, { side = 1280, paper = true, light = false, thresholds }) {
  let image = source;
  let cropped = false;
  if (paper) {
    const found = findPaper(image);
    if (found) { image = warp(image, found.corners); cropped = true; }
  }
  if (light) image = evenLight(image);
  let boxes = await detect(image, side, thresholds);
  // 紙が見つからず、文字が写真の一部にしかない場合は、文字のある範囲を切り出して調べ直す（大きく読める）
  if (!cropped && boxes.length > 3) {
    const xs = boxes.flatMap((b) => [b.cx - b.width / 2, b.cx + b.width / 2]), ys = boxes.flatMap((b) => [b.cy - b.height, b.cy + b.height]);
    const x0 = Math.max(0, Math.min(...xs) - 12), x1 = Math.min(image.width, Math.max(...xs) + 12);
    const y0 = Math.max(0, Math.min(...ys) - 12), y1 = Math.min(image.height, Math.max(...ys) + 12);
    if ((x1 - x0) * (y1 - y0) < image.width * image.height * 0.6) {
      image = warp(image, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], { margin: 0 });
      cropped = true;
      boxes = await detect(image, side, thresholds);
    }
  }
  return { image, boxes, cropped };
}

async function readBoxes(image, boxes, progress) {
  const lines = [];
  for (const [i, box] of boxes.entries()) {
    const { text, confidence } = await recognize(image, box);
    if (text.trim() && confidence >= 0.35) lines.push({ box, text: text.trim(), confidence });
    progress((i + 1) / boxes.length);
  }
  const weight = lines.reduce((s, l) => s + l.text.length, 0);
  return { lines, confidence: weight ? lines.reduce((s, l) => s + l.confidence * l.text.length, 0) / weight : 0 };
}

/**
 * 画像 → 文字の断片。同じ行の断片は同じ高さにそろえて返す（幅と高さは0〜1）。
 * 横向きや逆さの写真は、回して読み直す。
 */
async function read(source, options, progress) {
  progress(0.05);
  let turn = options.turn ?? 0;
  const turned = (n) => { let image = source; for (let i = 0; i < n; i++) image = quarter(image); return image; };
  let found = await locate(turned(turn), options);
  if (sidewaysBoxes(found.boxes)) { turn += 1; found = await locate(turned(turn), options); }
  progress(0.3);
  let result = await readBoxes(found.image, found.boxes, (v) => progress(0.3 + 0.7 * v));
  // 読み取りに自信がないときは、上下が逆の可能性を調べる
  if (result.confidence < 0.8 && found.boxes.length > 3) {
    const other = await locate(turned(turn + 2), options);
    const again = await readBoxes(other.image, other.boxes, () => {});
    if (again.confidence > result.confidence + 0.05) { found = other; result = again; turn += 2; }
  }
  const { image, cropped } = found;
  const { lines } = result;
  const boxes = lines.map((l) => l.box);
  const angle = textAngle(boxes);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  // 行のまとめ方は紙の形で向き不向きがあるので、何通りか返して、呼び出し側が合計の合うものを選ぶ
  const layouts = [straightRows, groupRows, offsetRows].map((method) => {
    const rows = method(boxes);
    const step = 1 / Math.max(1, rows.length);
    return rows.flatMap((row, r) => row.map((i) => {
      const { box, text, confidence } = lines[i];
      const x = box.cx * cos + box.cy * sin;
      return { text, confidence, x: (x - box.width / 2) / image.width, y: r * step, width: box.width / image.width, height: step * 0.5 };
    }));
  });
  return { layouts, cropped, turn: turn % 4, angle: (angle * 180) / Math.PI, confidence: result.confidence };
}

/** 右に90度回す */
function quarter(image) {
  const { width: w, height: h, data } = image;
  const out = { data: new Uint8ClampedArray(data.length), width: h, height: w };
  const from = new Uint32Array(data.buffer, data.byteOffset, w * h), to = new Uint32Array(out.data.buffer);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) to[x * h + (h - 1 - y)] = from[y * w + x];
  return out;
}

let queue = Promise.resolve();
self.onmessage = ({ data: message }) => {
  queue = queue.then(async () => {
    const { id, image, options = {} } = message;
    try {
      if (options.models) models = new URL(options.models, import.meta.url).href;
      engine ??= await start(options.session);
      const result = await read(image, options, (value) => self.postMessage({ id, progress: value }));
      self.postMessage({ id, result });
    } catch (error) {
      engine = null;
      self.postMessage({ id, error: String(error?.message ?? error) });
    }
  });
};
