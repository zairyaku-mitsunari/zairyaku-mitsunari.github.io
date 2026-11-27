// 画像の読み取りのための計算（紙の範囲、台形の補正、文字のある場所、読み取った番号の文字への変換）。
// 画素の配列だけを扱う。画面にも通信にも触れないので、テストと Web Worker の両方で使う。

/** 画像 = { data: RGBAの配列, width, height } */
const blank = (width, height) => ({ data: new Uint8ClampedArray(width * height * 4), width, height });

/** 大きさを変える。縮めるときは元の画素を平均する（細い文字が消えないように）。 */
export function resize(image, width, height) {
  const out = blank(width, height);
  const sx = image.width / width, sy = image.height / height;
  const src = image.data, W = image.width, H = image.height;
  const nx = Math.max(1, Math.ceil(sx - 0.25)), ny = Math.max(1, Math.ceil(sy - 0.25));
  const sum = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      sum[0] = sum[1] = sum[2] = 0;
      for (let j = 0; j < ny; j++) {
        const v = Math.min(H - 1, Math.max(0, (y + (j + 0.5) / ny) * sy - 0.5));
        const y0 = v | 0, y1 = Math.min(H - 1, y0 + 1), fy = v - y0;
        for (let i = 0; i < nx; i++) {
          const u = Math.min(W - 1, Math.max(0, (x + (i + 0.5) / nx) * sx - 0.5));
          const x0 = u | 0, x1 = Math.min(W - 1, x0 + 1), fx = u - x0;
          const a = (y0 * W + x0) * 4, b = (y0 * W + x1) * 4, c = (y1 * W + x0) * 4, d = (y1 * W + x1) * 4;
          for (let k = 0; k < 3; k++) sum[k] += (src[a + k] * (1 - fx) + src[b + k] * fx) * (1 - fy) + (src[c + k] * (1 - fx) + src[d + k] * fx) * fy;
        }
      }
      const o = (y * width + x) * 4, n = nx * ny;
      out.data[o] = sum[0] / n; out.data[o + 1] = sum[1] / n; out.data[o + 2] = sum[2] / n; out.data[o + 3] = 255;
    }
  }
  return out;
}

export function convexHull(points) {
  if (points.length < 4) return points.slice();
  const sorted = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => {
    const h = [];
    for (const p of list) { while (h.length > 1 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop(); h.push(p); }
    h.pop();
    return h;
  };
  return [...half(sorted), ...half(sorted.reverse())];
}

/** 点の集まりを囲む、いちばん小さい傾いた四角。angle は横の辺の傾き（ラジアン、-45〜45度）。 */
export function minAreaRect(hull) {
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const [ax, ay] = hull[i], [bx, by] = hull[(i + 1) % hull.length];
    let angle = Math.atan2(by - ay, bx - ax);
    while (angle > Math.PI / 4) angle -= Math.PI / 2;
    while (angle <= -Math.PI / 4) angle += Math.PI / 2;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of hull) {
      const u = x * cos + y * sin, v = -x * sin + y * cos;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) {
      const u = (u0 + u1) / 2, v = (v0 + v1) / 2;
      best = { area, cx: u * cos - v * sin, cy: u * sin + v * cos, width: u1 - u0, height: v1 - v0, angle };
    }
  }
  return best;
}

/** mask の値が1の画素の、つながったかたまりごとに fn(画素の番号の配列) を呼ぶ */
function components(mask, width, height, fn) {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let top = 0;
    const pixels = [];
    stack[top++] = start; seen[start] = 1;
    while (top) {
      const p = stack[--top];
      pixels.push(p);
      const x = p % width, y = (p - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const q = ny * width + nx;
          if (mask[q] && !seen[q]) { seen[q] = 1; stack[top++] = q; }
        }
      }
    }
    fn(pixels);
  }
}

/** かたまりの外周の点（各行の左端と右端） */
function outline(pixels, width) {
  const rows = new Map();
  for (const p of pixels) {
    const x = p % width, y = (p - x) / width;
    const r = rows.get(y);
    if (!r) rows.set(y, [x, x]); else { if (x < r[0]) r[0] = x; if (x > r[1]) r[1] = x; }
  }
  const points = [];
  for (const [y, [a, b]] of rows) points.push([a - 0.5, y - 0.5], [b + 0.5, y - 0.5], [a - 0.5, y + 0.5], [b + 0.5, y + 0.5]);
  return points;
}

/** 文字検出の確率の地図（0〜1）から、文字の行の四角を取り出す（DB方式の後処理） */
export function textBoxes(probability, width, height, { threshold = 0.2, boxThreshold = 0.45, unclip = 1.4 } = {}) {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = probability[i] > threshold ? 1 : 0;
  const boxes = [];
  components(mask, width, height, (pixels) => {
    if (pixels.length < 6) return;
    let sum = 0;
    for (const p of pixels) sum += probability[p];
    const score = sum / pixels.length;
    if (score < boxThreshold) return;
    const rect = minAreaRect(convexHull(outline(pixels, width)));
    if (!rect || Math.min(rect.width, rect.height) < 3) return;
    // 検出した範囲は文字より内側になるので、外へ広げる
    const grow = (rect.width * rect.height * unclip) / (2 * (rect.width + rect.height));
    boxes.push({ cx: rect.cx, cy: rect.cy, width: rect.width + grow * 2, height: rect.height + grow * 2, angle: rect.angle, score });
  });
  return boxes;
}

/** 傾いた四角の中を、高さ targetHeight の横長の画像に切り出す。縦長の四角は90度回す。 */
export function cropBox(image, box, targetHeight = 48, maxWidth = 3200) {
  let { cx, cy, width, height, angle } = box;
  if (height >= width * 1.5) { [width, height] = [height, width]; angle -= Math.PI / 2; }
  const outWidth = Math.max(8, Math.min(maxWidth, Math.round((targetHeight * width) / height)));
  const out = blank(outWidth, targetHeight);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const W = image.width, H = image.height, src = image.data;
  const n = height / targetHeight > 1.6 ? 2 : 1; // 大きく縮めるときは、近くの点を平均する
  for (let y = 0; y < targetHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const du = ((x + (i + 0.5) / n) / outWidth - 0.5) * width;
          const dv = ((y + (j + 0.5) / n) / targetHeight - 0.5) * height;
          const u = Math.min(W - 1, Math.max(0, cx + du * cos - dv * sin - 0.5));
          const v = Math.min(H - 1, Math.max(0, cy + du * sin + dv * cos - 0.5));
          const x0 = u | 0, y0 = v | 0, x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1), fx = u - x0, fy = v - y0;
          const p = (y0 * W + x0) * 4, q = (y0 * W + x1) * 4, s = (y1 * W + x0) * 4, t = (y1 * W + x1) * 4;
          r += (src[p] * (1 - fx) + src[q] * fx) * (1 - fy) + (src[s] * (1 - fx) + src[t] * fx) * fy;
          g += (src[p + 1] * (1 - fx) + src[q + 1] * fx) * (1 - fy) + (src[s + 1] * (1 - fx) + src[t + 1] * fx) * fy;
          b += (src[p + 2] * (1 - fx) + src[q + 2] * fx) * (1 - fy) + (src[s + 2] * (1 - fx) + src[t + 2] * fx) * fy;
        }
      }
      const o = (y * outWidth + x) * 4, m = n * n;
      out.data[o] = r / m; out.data[o + 1] = g / m; out.data[o + 2] = b / m; out.data[o + 3] = 255;
    }
  }
  return out;
}

/** 画像をモデルに渡す数の並び（青・緑・赤の順の面）にする。padWidth より狭ければ右を0で埋める。 */
export function planes(image, mean, deviation, padWidth = image.width) {
  const width = Math.max(padWidth, image.width), height = image.height;
  const out = new Float32Array(3 * width * height);
  for (let c = 0; c < 3; c++) {
    const source = 2 - c; // BGR
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < image.width; x++) out[c * width * height + y * width + x] = (image.data[(y * image.width + x) * 4 + source] / 255 - mean[c]) / deviation[c];
    }
  }
  return out;
}

/** 設定ファイル（inference.yml）から、読み取れる文字の一覧を取り出す */
export function dictionary(yaml) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l.trim() === 'character_dict:');
  const found = [];
  for (let i = start + 1; start >= 0 && i < lines.length; i++) {
    const m = lines[i].match(/^\s*- (.*)$/s);
    if (!m) break;
    let ch = m[1].replace(/\r$/, '');
    if (ch.length >= 2 && ch.startsWith("'") && ch.endsWith("'")) ch = ch.slice(1, -1).replaceAll("''", "'");
    else if (ch.length >= 2 && ch.startsWith('"') && ch.endsWith('"')) ch = JSON.parse(ch);
    found.push(ch);
  }
  return found;
}

/** 認識モデルの出力（位置×文字の確からしさ）を文字列にする（CTC方式）。0番は「文字なし」、最後は空白。 */
export function decode(output, steps, classes, characters) {
  let text = '', previous = 0, sum = 0, count = 0;
  for (let t = 0; t < steps; t++) {
    let best = 0, value = output[t * classes];
    for (let c = 1; c < classes; c++) if (output[t * classes + c] > value) { value = output[t * classes + c]; best = c; }
    if (best && best !== previous) { text += characters[best - 1] ?? ' '; sum += value; count += 1; }
    previous = best;
  }
  return { text, confidence: count ? sum / count : 0 };
}

/** 行の傾き（ラジアン）。横に長い行ほど重く見る。 */
export function textAngle(boxes) {
  const usable = boxes.filter((b) => b.width > b.height * 2.5).sort((a, b) => a.angle - b.angle);
  const total = usable.reduce((s, b) => s + b.width, 0);
  let sum = 0;
  for (const b of usable) { sum += b.width; if (sum >= total / 2) return b.angle; }
  return 0;
}

/**
 * 文字の四角を行にまとめる。左の四角の傾きを延ばした先に右の四角があれば同じ行
 * （紙が曲がっていたり、奥行きで行の傾きが変わったりしても、商品名と金額がつながるように）。
 * 戻り値は行の配列（上から順）。各行は四角の番号の配列（左から順）。
 */
export function groupRows(boxes) {
  const angle = textAngle(boxes);
  const slope = (b) => Math.tan(b.width > b.height * 3 ? b.angle : angle);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const along = boxes.map((b) => b.cx * cos + b.cy * sin);
  const down = boxes.map((b) => -b.cx * sin + b.cy * cos);
  const pairs = [];
  for (let a = 0; a < boxes.length; a++) {
    for (let b = 0; b < boxes.length; b++) {
      const A = boxes[a], B = boxes[b];
      const gap = along[b] - along[a] - (A.width + B.width) / 2;
      if (along[b] <= along[a] || gap < -Math.min(A.height, B.height)) continue;
      const dx = B.cx - A.cx;
      const error = (Math.abs(A.cy + slope(A) * dx - B.cy) + Math.abs(B.cy - slope(B) * dx - A.cy)) / 2 / Math.min(A.height, B.height);
      if (error < 0.45) pairs.push({ a, b, cost: error + Math.max(0, gap) / 4000 });
    }
  }
  const right = new Map(), left = new Set();
  for (const { a, b } of pairs.sort((x, y) => x.cost - y.cost)) if (!right.has(a) && !left.has(b)) { right.set(a, b); left.add(b); }
  const rows = [];
  for (let i = 0; i < boxes.length; i++) {
    if (left.has(i)) continue;
    const row = [i];
    while (right.has(row.at(-1))) row.push(right.get(row.at(-1)));
    rows.push(row);
  }
  // 行の上下は、傾きを打ち消した高さで決める
  const level = (row) => row.reduce((s, i) => s + down[i] * boxes[i].width, 0) / row.reduce((s, i) => s + boxes[i].width, 0);
  return rows.sort((x, y) => level(x) - level(y));
}

/** 傾きを打ち消した座標（u＝行の向き、v＝上下） */
function straighten(boxes) {
  const angle = textAngle(boxes);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return { u: boxes.map((b) => b.cx * cos + b.cy * sin), v: boxes.map((b) => -b.cx * sin + b.cy * cos) };
}

/** 高さが重なるものを同じ行にする（紙が平らな場合に向く） */
export function straightRows(boxes) {
  const { u, v } = straighten(boxes);
  const rows = [];
  for (const i of boxes.map((_, i) => i).sort((a, b) => v[a] - v[b])) {
    const first = rows.at(-1)?.[0];
    if (first !== undefined && Math.abs(v[i] - v[first]) < Math.max(boxes[i].height, boxes[first].height) * 0.42) rows.at(-1).push(i);
    else rows.push([i]);
  }
  return rows.map((row) => row.sort((a, b) => u[a] - u[b]));
}

/**
 * 左の列（商品名）と右の列（金額）の上下のずれが、紙全体でそろっていると考えて行にまとめる。
 * いちばん多くの組がぴったり合うずれ（上下方向に少しずつ変わってもよい）を選ぶ。
 */
export function offsetRows(boxes) {
  const { u, v } = straighten(boxes);
  const height = [...boxes.map((b) => b.height)].sort((a, b) => a - b)[boxes.length >> 1] ?? 1;
  const beside = (a, b) => u[b] - u[a] > (boxes[a].width + boxes[b].width) / 2 - height * 0.5;
  const isRight = boxes.map((_, i) => boxes.some((_, k) => k !== i && beside(k, i) && Math.abs(v[i] - v[k]) < height * 1.2));
  const pairs = [];
  for (let a = 0; a < boxes.length; a++) {
    if (isRight[a]) continue;
    for (let b = 0; b < boxes.length; b++) if (isRight[b] && beside(a, b) && Math.abs(v[b] - v[a]) < height * 1.3) pairs.push({ a, b, d: v[b] - v[a] });
  }
  const match = (offset, slope, tolerance) => {
    const found = pairs.map((p) => ({ ...p, error: Math.abs(p.d - offset - slope * v[p.a]) })).filter((p) => p.error < tolerance).sort((x, y) => x.error - y.error);
    const used = new Set(), taken = [];
    for (const p of found) if (!used.has(p.a) && !used.has(p.b)) { used.add(p.a); used.add(p.b); taken.push(p); }
    return { taken, used, score: taken.reduce((s, p) => s + 1 - p.error / tolerance / 2, 0) };
  };
  let best = { score: 0, offset: 0, slope: 0 };
  for (const first of pairs) {
    for (const second of [first, ...pairs]) {
      const span = v[second.a] - v[first.a];
      if (second !== first && Math.abs(span) < height * 6) continue;
      const slope = second === first ? 0 : (second.d - first.d) / span;
      if (Math.abs(slope) > 0.04) continue;
      const offset = first.d - slope * v[first.a];
      const score = match(offset, slope, height * 0.28).score - Math.abs(offset) / height * 0.3;
      if (score > best.score) best = { score, offset, slope };
    }
  }
  const { taken, used } = match(best.offset, best.slope, height * 0.45);
  const partner = new Map(taken.map((p) => [p.a, p.b]));
  const rows = [];
  for (let i = 0; i < boxes.length; i++) {
    if (taken.some((p) => p.b === i)) continue;
    rows.push({ level: v[i], members: partner.has(i) ? [i, partner.get(i)] : [i], lone: !used.has(i) && isRight[i], base: i });
  }
  // 組にならなかった右側のものは、ずれを引いた高さが近い行に加える
  for (const row of rows.filter((r) => r.lone)) {
    const level = row.level - best.offset - best.slope * row.level;
    const near = rows.filter((r) => !r.lone && beside(r.base, row.base) && Math.abs(r.level - level) < height * 0.45).sort((x, y) => Math.abs(x.level - level) - Math.abs(y.level - level))[0];
    if (near) { near.members.push(row.base); row.members = []; } else row.level = level;
  }
  return rows.filter((r) => r.members.length).sort((x, y) => x.level - y.level).map((r) => r.members.sort((a, b) => u[a] - u[b]));
}

// ---- 紙の範囲 ----

/** 大津の方法の境目 */
function otsu(values) {
  const histogram = new Array(256).fill(0);
  for (const v of values) histogram[v] += 1;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];
  let back = 0, backSum = 0, best = 0, threshold = 128;
  for (let i = 0; i < 256; i++) {
    back += histogram[i];
    if (!back || back === values.length) continue;
    backSum += i * histogram[i];
    const difference = backSum / back - (sum - backSum) / (values.length - back);
    const score = back * (values.length - back) * difference * difference;
    if (score > best) { best = score; threshold = i; }
  }
  return threshold;
}

const polygonArea = (p) => Math.abs(p.reduce((s, [x, y], i) => { const [u, v] = p[(i + 1) % p.length]; return s + x * v - u * y; }, 0)) / 2;

/** 凸の多角形を、外側に広げながら4つの辺にする */
export function toQuad(hull) {
  const points = hull.slice();
  while (points.length > 4) {
    let best = null;
    for (let i = 0; i < points.length; i++) {
      const n = points.length;
      const a = points[(i - 1 + n) % n], b = points[i], c = points[(i + 1) % n], d = points[(i + 2) % n];
      // 辺 b-c を消して、a-b と d-c を延ばした交点に置き換える
      const rx = b[0] - a[0], ry = b[1] - a[1], sx = c[0] - d[0], sy = c[1] - d[1];
      const cross = rx * sy - ry * sx;
      if (Math.abs(cross) < 1e-9) continue;
      const t = ((d[0] - a[0]) * sy - (d[1] - a[1]) * sx) / cross;
      const u = ((d[0] - a[0]) * ry - (d[1] - a[1]) * rx) / cross;
      if (t < 1 - 1e-9 || u < 1 - 1e-9) continue;
      const q = [a[0] + rx * t, a[1] + ry * t];
      const added = polygonArea([b, q, c]);
      if (!best || added < best.added) best = { i, q, added };
    }
    if (!best) return null;
    const j = (best.i + 1) % points.length;
    points[best.i] = best.q;
    points.splice(j, 1);
  }
  return points.length === 4 ? points : null;
}

/** 左上・右上・右下・左下の順にする */
export function orderCorners(quad) {
  const cx = quad.reduce((s, p) => s + p[0], 0) / 4, cy = quad.reduce((s, p) => s + p[1], 0) / 4;
  const around = quad.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  const first = around.reduce((best, p, i) => (p[0] + p[1] < around[best][0] + around[best][1] ? i : best), 0);
  return [0, 1, 2, 3].map((i) => around[(first + i) % 4]);
}

const cornerAngle = (a, b, c) => {
  const u = [a[0] - b[0], a[1] - b[1]], v = [c[0] - b[0], c[1] - b[1]];
  return (Math.acos((u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...u) * Math.hypot(...v))) * 180) / Math.PI;
};

/**
 * 写真の中の紙（明るくて色の薄い、四角いかたまり）の四隅を探す。確かでなければ null（切り抜かない）。
 * 戻り値は元の画像の座標。
 */
export function findPaper(image) {
  const scale = Math.min(1, 360 / Math.max(image.width, image.height));
  const small = scale < 1 ? resize(image, Math.round(image.width * scale), Math.round(image.height * scale)) : image;
  const { width: w, height: h, data } = small;
  const values = new Uint8Array(w * h);
  for (let i = 0; i < values.length; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    values[i] = Math.max(0, (r * 299 + g * 587 + b * 114) / 1000 - (Math.max(r, g, b) - Math.min(r, g, b)) * 0.7);
  }
  const base = otsu(values);
  // 影があると紙の一部が暗くなるので、境目を少しずつ変えて、いちばん四角らしいものを選ぶ
  let found = null;
  for (const factor of [1, 0.85, 0.7, 1.12]) {
    const threshold = base * factor;
    const mask = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        // 細いつながりを切る（上下左右も明るい画素だけ残す）
        mask[p] = values[p] > threshold && values[p - 1] > threshold && values[p + 1] > threshold && values[p - w] > threshold && values[p + w] > threshold ? 1 : 0;
      }
    }
    let largest = null;
    components(mask, w, h, (pixels) => { if (!largest || pixels.length > largest.length) largest = pixels; });
    if (!largest || largest.length < w * h * 0.08) continue;
    const hull = convexHull(outline(largest, w));
    const quad = toQuad(hull);
    if (!quad) continue;
    const corners = orderCorners(quad);
    const area = polygonArea(corners), hullArea = polygonArea(hull);
    if (area < w * h * 0.1 || area > w * h * 0.93) continue;
    if (!corners.every((p, i) => { const angle = cornerAngle(corners[(i + 3) % 4], p, corners[(i + 1) % 4]); return angle > 55 && angle < 125; })) continue;
    if (corners.some(([x, y]) => x < -w * 0.08 || x > w * 1.08 || y < -h * 0.08 || y > h * 1.08)) continue;
    // 文字や影の穴を含めて、四角の中がどれだけ紙らしいか
    const solidity = hullArea / area;
    let inside = 0;
    for (const p of largest) if (p >= 0) inside += 1;
    const fill = inside / hullArea;
    if (solidity < 0.9 || fill < 0.7) continue;
    const quality = solidity * Math.min(1, fill) * Math.sqrt(area / (w * h));
    if (!found || quality > found.quality) found = { quality, corners: corners.map(([x, y]) => [x / scale, y / scale]), solidity, fill };
  }
  return found;
}

/** 四隅の対応から射影の係数を求める（from の座標 → to の座標） */
export function homography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  for (let col = 0; col < 8; col++) {
    let p = col;
    for (let row = col + 1; row < 8; row++) if (Math.abs(A[row][col]) > Math.abs(A[p][col])) p = row;
    [A[col], A[p]] = [A[p], A[col]]; [b[col], b[p]] = [b[p], b[col]];
    for (let row = 0; row < 8; row++) {
      if (row === col) continue;
      const f = A[row][col] / A[col][col];
      for (let k = col; k < 8; k++) A[row][k] -= f * A[col][k];
      b[row] -= f * b[col];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}

/** 四隅（左上から時計回り）で囲まれた紙を、正面から見た長方形にする。margin は外側の余白の割合。 */
export function warp(image, corners, { maxWidth = 1400, maxHeight = 4000, margin = 0.012 } = {}) {
  const cx = corners.reduce((s, p) => s + p[0], 0) / 4, cy = corners.reduce((s, p) => s + p[1], 0) / 4;
  const wide = corners.map(([x, y]) => [cx + (x - cx) * (1 + margin * 2), cy + (y - cy) * (1 + margin)]);
  const length = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const w = Math.max(length(wide[0], wide[1]), length(wide[3], wide[2]));
  const h = Math.max(length(wide[0], wide[3]), length(wide[1], wide[2]));
  const scale = Math.min(maxWidth / w, maxHeight / h, 1.5);
  const width = Math.max(16, Math.round(w * scale)), height = Math.max(16, Math.round(h * scale));
  const m = homography([[0, 0], [width, 0], [width, height], [0, height]], wide);
  const out = blank(width, height);
  const W = image.width, H = image.height, src = image.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = m[6] * (x + 0.5) + m[7] * (y + 0.5) + 1;
      const u = Math.min(W - 1, Math.max(0, (m[0] * (x + 0.5) + m[1] * (y + 0.5) + m[2]) / d - 0.5));
      const v = Math.min(H - 1, Math.max(0, (m[3] * (x + 0.5) + m[4] * (y + 0.5) + m[5]) / d - 0.5));
      const x0 = u | 0, y0 = v | 0, x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1), fx = u - x0, fy = v - y0;
      const o = (y * width + x) * 4, p = (y0 * W + x0) * 4, q = (y0 * W + x1) * 4, s = (y1 * W + x0) * 4, t = (y1 * W + x1) * 4;
      for (let k = 0; k < 3; k++) out.data[o + k] = (src[p + k] * (1 - fx) + src[q + k] * fx) * (1 - fy) + (src[s + k] * (1 - fx) + src[t + k] * fx) * fy;
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** 影と暗さをならす：まわりの紙の明るさで割って、薄い文字を濃くする */
export function evenLight(image) {
  const { width: w, height: h, data } = image;
  const cell = Math.max(8, Math.round(w / 40));
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const paper = new Float32Array(gw * gh);
  const bucket = [];
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      bucket.length = 0;
      for (let y = gy * cell; y < Math.min(h, (gy + 1) * cell); y += 2) {
        for (let x = gx * cell; x < Math.min(w, (gx + 1) * cell); x += 2) { const i = (y * w + x) * 4; bucket.push((data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000); }
      }
      bucket.sort((a, b) => a - b);
      paper[gy * gw + gx] = bucket[Math.floor(bucket.length * 0.85)] ?? 255;
    }
  }
  // 文字ばかりのます目の影響を除くため、まわりの明るい方を使ってからならす
  const spread = (source, pick) => source.map((_, i) => {
    const x = i % gw, y = (i - x) / gw, near = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < gw && ny < gh) near.push(source[ny * gw + nx]); }
    return pick(near);
  });
  const field = spread(spread(paper, (v) => Math.max(...v)), (v) => v.reduce((a, b) => a + b, 0) / v.length);
  const out = blank(w, h);
  for (let y = 0; y < h; y++) {
    const v = Math.min(gh - 1, Math.max(0, y / cell - 0.5)), y0 = v | 0, y1 = Math.min(gh - 1, y0 + 1), fy = v - y0;
    for (let x = 0; x < w; x++) {
      const u = Math.min(gw - 1, Math.max(0, x / cell - 0.5)), x0 = u | 0, x1 = Math.min(gw - 1, x0 + 1), fx = u - x0;
      const light = (field[y0 * gw + x0] * (1 - fx) + field[y0 * gw + x1] * fx) * (1 - fy) + (field[y1 * gw + x0] * (1 - fx) + field[y1 * gw + x1] * fx) * fy;
      const i = (y * w + x) * 4;
      const gray = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      const ratio = Math.min(1, gray / Math.max(40, light));
      out.data[i] = out.data[i + 1] = out.data[i + 2] = Math.max(0, Math.min(255, 255 - (1 - ratio) * 255 * 1.35));
      out.data[i + 3] = 255;
    }
  }
  return out;
}
