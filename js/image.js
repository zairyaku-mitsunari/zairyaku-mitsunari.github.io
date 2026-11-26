// 画像の読み込み・圧縮・文字認識の前処理。すべて端末内（canvas）で行う。

export const MAXIMUM_BYTES = 30_000_000;

const canvasOf = (width, height) => Object.assign(document.createElement('canvas'), { width, height });
const context = (canvas) => canvas.getContext('2d', { willReadFrequently: true });

/** 画像を読み込む（撮影の向きを反映）。長い辺は maxSide まで。 */
export async function decode(blob, maxSide = 3200) {
  if (blob.size > MAXIMUM_BYTES) throw new Error('ファイルが大きすぎます（30MBまで）。');
  let bitmap;
  try { bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { throw new Error('画像として読み込めませんでした。'); }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = canvasOf(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
  context(canvas).fillStyle = '#fff';
  context(canvas).fillRect(0, 0, canvas.width, canvas.height);
  context(canvas).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

export const toBlob = (canvas, type = 'image/jpeg', quality = 0.6) =>
  new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像を変換できません。'))), type, quality));

/** 保存用：長辺2200px・JPEG。撮影場所などの付加情報は引き継がれない。 */
export async function compress(canvas) {
  const scale = Math.min(1, 2200 / Math.max(canvas.width, canvas.height));
  if (scale === 1) return toBlob(canvas);
  const small = canvasOf(Math.round(canvas.width * scale), Math.round(canvas.height * scale));
  context(small).drawImage(canvas, 0, 0, small.width, small.height);
  return toBlob(small);
}

export function rotate(canvas, degrees, fill = '#fff') {
  const radians = (degrees * Math.PI) / 180;
  const sin = Math.abs(Math.sin(radians));
  const cos = Math.abs(Math.cos(radians));
  const result = canvasOf(Math.round(canvas.width * cos + canvas.height * sin), Math.round(canvas.width * sin + canvas.height * cos));
  const c = context(result);
  c.fillStyle = fill;
  c.fillRect(0, 0, result.width, result.height);
  c.translate(result.width / 2, result.height / 2);
  c.rotate(radians);
  c.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return result;
}

function gray(canvas) {
  const { data } = context(canvas).getImageData(0, 0, canvas.width, canvas.height);
  const out = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0; i < out.length; i++) out[i] = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000;
  return out;
}

/** 明るい紙と暗い背景を分ける境目（大津の方法） */
function otsu(pixels) {
  const histogram = new Array(256).fill(0);
  for (const v of pixels) histogram[v] += 1;
  const total = pixels.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];
  let back = 0, backSum = 0, best = 0, threshold = 128;
  for (let i = 0; i < 256; i++) {
    back += histogram[i];
    if (!back || back === total) continue;
    backSum += i * histogram[i];
    const difference = backSum / back - (sum - backSum) / (total - back);
    const score = back * (total - back) * difference * difference;
    if (score > best) { best = score; threshold = i; }
  }
  return threshold;
}

/** 暗い背景の上の紙なら、紙の傾きを直して紙の範囲に切り抜く。画面の撮影（全体が紙）なら何もしない。 */
export function trimToPaper(canvas) {
  const scale = Math.min(1, 400 / Math.max(canvas.width, canvas.height));
  const small = canvasOf(Math.round(canvas.width * scale), Math.round(canvas.height * scale));
  context(small).drawImage(canvas, 0, 0, small.width, small.height);
  const pixels = gray(small);
  const threshold = otsu(pixels);
  const points = [];
  let darkSum = 0;
  for (let y = 0; y < small.height; y++) {
    for (let x = 0; x < small.width; x++) {
      const v = pixels[y * small.width + x];
      if (v > threshold) points.push(x, y); else darkSum += v;
    }
  }
  const share = points.length / 2 / pixels.length;
  const dark = darkSum / Math.max(1, pixels.length - points.length / 2);
  if (share > 0.85 || share < 0.08 || dark > 90) return canvas; // 全体が紙、または背景が暗くない
  // 紙を囲む四角がいちばん小さくなる角度が、紙の傾き。端の外れた点は無視する。
  const box = (degrees) => {
    const t = (degrees * Math.PI) / 180;
    const cos = Math.cos(t), sin = Math.sin(t);
    const xs = [], ys = [];
    for (let i = 0; i < points.length; i += 6) { xs.push(points[i] * cos - points[i + 1] * sin); ys.push(points[i] * sin + points[i + 1] * cos); }
    xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
    const at = (list, q) => list[Math.round((list.length - 1) * q)];
    return (at(xs, 0.995) - at(xs, 0.005)) * (at(ys, 0.995) - at(ys, 0.005));
  };
  let angle = 0, area = box(0);
  for (let d = -20; d <= 20; d += 0.5) { const value = box(d); if (value < area * 0.995) { area = value; angle = d; } }
  const turned = angle ? rotate(canvas, angle, '#000') : canvas;
  const view = canvasOf(Math.round(turned.width * scale), Math.round(turned.height * scale));
  context(view).drawImage(turned, 0, 0, view.width, view.height);
  const values = gray(view);
  const rows = new Array(view.height).fill(0), columns = new Array(view.width).fill(0);
  for (let y = 0; y < view.height; y++) for (let x = 0; x < view.width; x++) if (values[y * view.width + x] > threshold) { rows[y] += 1; columns[x] += 1; }
  const span = (list) => { const limit = Math.max(...list) * 0.5; const first = list.findIndex((v) => v > limit); return [first, list.length - 1 - [...list].reverse().findIndex((v) => v > limit)]; };
  const [top, bottom] = span(rows);
  const [left, right] = span(columns);
  const width = (right - left + 1) / scale, height = (bottom - top + 1) / scale;
  if (width < canvas.width * 0.2 || height < canvas.height * 0.15) return canvas;
  const inset = Math.min(width, height) * 0.012; // ふちの影を除く
  const result = canvasOf(Math.round(width - inset * 2), Math.round(height - inset * 2));
  context(result).drawImage(turned, left / scale + inset, top / scale + inset, width - inset * 2, height - inset * 2, 0, 0, result.width, result.height);
  return result;
}

/** 文字の行が水平になる角度（度）を調べる。±10度まで。 */
export function skewAngle(canvas) {
  const scale = Math.min(1, 500 / Math.max(canvas.width, canvas.height));
  const small = canvasOf(Math.round(canvas.width * scale), Math.round(canvas.height * scale));
  context(small).drawImage(canvas, 0, 0, small.width, small.height);
  const pixels = gray(small);
  const threshold = otsu(pixels);
  const points = [];
  const marginX = Math.round(small.width * 0.04);
  const marginY = Math.round(small.height * 0.04);
  for (let y = marginY; y < small.height - marginY; y++) {
    for (let x = marginX; x < small.width - marginX; x++) if (pixels[y * small.width + x] < threshold - 10) points.push([x, y]);
  }
  if (points.length < 200 || points.length > pixels.length * 0.4) return 0;
  const score = (degrees) => {
    const t = Math.tan((degrees * Math.PI) / 180);
    const bins = new Map();
    for (const [x, y] of points) { const key = Math.round(y + x * t); bins.set(key, (bins.get(key) ?? 0) + 1); }
    let total = 0;
    for (const v of bins.values()) total += v * v;
    return total;
  };
  let best = 0, bestScore = score(0);
  for (let d = -10; d <= 10; d += 0.5) { const s = score(d); if (s > bestScore * 1.02) { best = d; bestScore = s; } }
  return best;
}

/** 各画素のまわり（半径 radius）の平均の明るさ */
function localMean(pixels, w, h, radius) {
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += pixels[y * w + x]; integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row; } }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius), y1 = Math.min(h, y + radius + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius), x1 = Math.min(w, x + radius + 1);
      out[y * w + x] = (integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

function resize(canvas, width) {
  const out = canvasOf(width, Math.round((canvas.height * width) / canvas.width));
  const c = context(out);
  c.imageSmoothingQuality = 'high';
  c.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

/** 3×3の中央の値（点状のざらつきを除き、文字の輪郭は残す） */
function median(pixels, w, h) {
  const out = Uint8Array.from(pixels);
  const window = new Uint8Array(9);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let n = 0;
      for (let dy = -w; dy <= w; dy += w) for (let dx = -1; dx <= 1; dx++) window[n++] = pixels[y * w + x + dy + dx];
      window.sort();
      out[y * w + x] = window[4];
    }
  }
  return out;
}

/** 周りの明るさと、ばらつきの大きさから、画素ごとに白黒の境目を決める（Sauvolaの方法） */
function sauvola(pixels, w, h, radius, k = 0.2) {
  const squares = Float64Array.from(pixels, (v) => v * v);
  const mean = localMean(pixels, w, h, radius);
  const meanSquare = localMean(squares, w, h, radius);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const deviation = Math.sqrt(Math.max(0, meanSquare[i] - mean[i] * mean[i]));
    out[i] = pixels[i] < mean[i] * (1 + k * (deviation / 64 - 1)) ? 0 : 255;
  }
  return out;
}

/** 薄くてざらついた画像向け：拡大する前に、ざらつきを除き、影をならし、濃さの幅を広げる */
function clean(canvas) {
  const w = canvas.width, h = canvas.height;
  let pixels = median(gray(canvas), w, h);
  if (Math.max(w, h) > 500) pixels = median(pixels, w, h);
  const background = localMean(pixels, w, h, Math.max(10, Math.round(w / 28)));
  const ratio = new Float32Array(w * h);
  for (let i = 0; i < ratio.length; i++) ratio[i] = Math.min(1, pixels[i] / Math.max(1, background[i]));
  // 暗いほうから2%の濃さを黒に、紙の濃さ（0.93以上）を白にする
  const sorted = Float32Array.from(ratio).sort();
  const dark = Math.min(0.85, sorted[Math.floor(sorted.length * 0.02)]);
  const out = canvasOf(w, h);
  const c = context(out);
  const image = c.createImageData(w, h);
  for (let i = 0; i < ratio.length; i++) {
    const v = Math.max(0, Math.min(255, ((ratio[i] - dark) / (0.93 - dark)) * 255));
    image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = v;
    image.data[i * 4 + 3] = 255;
  }
  c.putImageData(image, 0, 0);
  return out;
}

/** 文字認識に渡す画像：紙の切り抜き → 傾き補正 → 拡大 → 白黒（周りの明るさに合わせる） */
export function prepareForOCR(canvas, { trim = true, deskew = true, mode = 'gray', width = 1600 } = {}) {
  let image = trim ? trimToPaper(canvas) : canvas;
  const cropped = image !== canvas;
  const angle = deskew ? skewAngle(image) : 0;
  if (angle) image = rotate(image, angle);
  if (mode === 'clean') image = clean(image.width > 1600 ? resize(image, 1600) : image);
  const scale = Math.max(0.5, Math.min(3, width / image.width));
  const out = canvasOf(Math.round(image.width * scale), Math.round(image.height * scale));
  const c = context(out);
  c.imageSmoothingQuality = 'high';
  c.drawImage(image, 0, 0, out.width, out.height);
  if (mode !== 'color' && mode !== 'clean') {
    const pixels = gray(out);
    const result = c.getImageData(0, 0, out.width, out.height);
    let values = pixels;
    if (mode === 'sauvola') values = sauvola(median(pixels, out.width, out.height), out.width, out.height, Math.max(10, Math.round(out.width / 55)));
    if (mode === 'adaptive' || mode === 'flat') {
      const w = out.width, h = out.height;
      const mean = localMean(pixels, w, h, Math.max(12, Math.round(w / (mode === 'flat' ? 30 : 60))));
      values = new Uint8Array(w * h);
      if (mode === 'adaptive') {
        for (let i = 0; i < values.length; i++) values[i] = pixels[i] < mean[i] * 0.88 ? 0 : 255;
      } else {
        // 影を取り除き（周りの明るさで割る）、ざらつきをならしてから、薄い印字を濃くする
        const smooth = localMean(pixels, w, h, 1);
        for (let i = 0; i < values.length; i++) values[i] = Math.max(0, Math.min(255, 255 - (1 - smooth[i] / Math.max(1, mean[i] * 1.02)) * 255 * 2.6));
      }
    }
    for (let i = 0; i < values.length; i++) result.data[i * 4] = result.data[i * 4 + 1] = result.data[i * 4 + 2] = values[i];
    c.putImageData(result, 0, 0);
  }
  return { canvas: out, cropped, angle };
}
