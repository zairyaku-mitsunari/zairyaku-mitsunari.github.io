// PDFから文字（位置つき）と、埋め込まれた写真（JPEG）を取り出す。端末の中だけで処理する。
// 対応：一般的な形式の文字つきPDFと、写真を貼っただけのPDF（スキャン）。
// 非対応：暗号化（パスワード保護）されたPDF、まれな圧縮形式、文字の対応表がない埋め込みフォント。

export class PDFError extends Error {}
const LIMIT = { bytes: 15_000_000, pages: 10, stream: 40_000_000, operations: 400_000 };

class Name { constructor(name) { this.name = name; } }
class Ref { constructor(id) { this.id = id; } }
class Keyword { constructor(word) { this.word = word; } }

const latin = (bytes) => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 32768) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  return out;
};
const bytesOf = (text) => { const out = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 255; return out; };

const WHITE = /[\0\t\n\f\r ]/;
const DELIMITER = /[\0\t\n\f\r ()<>[\]{}/%]/;

/** Adobe-Japan1 の対応表（同じサイトのファイル）を読む */
export const japan1Table = async () => { const r = await fetch(new URL('../../vendor/adobe/Adobe-Japan1-UCS2.txt', import.meta.url)); return r.ok ? r.text() : null; };

/** PDFの値と命令を読む */
class Reader {
  constructor(text, position = 0) { this.s = text; this.p = position; this.depth = 0; }
  skip() {
    while (this.p < this.s.length) {
      const c = this.s[this.p];
      if (WHITE.test(c)) this.p += 1;
      else if (c === '%') while (this.p < this.s.length && !/[\r\n]/.test(this.s[this.p])) this.p += 1;
      else break;
    }
  }
  word() {
    const start = this.p;
    while (this.p < this.s.length && !DELIMITER.test(this.s[this.p])) this.p += 1;
    return this.s.slice(start, this.p);
  }
  read() {
    this.skip();
    const s = this.s;
    if (this.p >= s.length) return undefined;
    if (this.depth > 60) throw new PDFError('PDFの構造が複雑すぎます。');
    const c = s[this.p];
    if (c === '/') {
      this.p += 1;
      return new Name(this.word().replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
    }
    if (c === '(') return this.string();
    if (c === '<' && s[this.p + 1] === '<') {
      this.p += 2; this.depth += 1;
      const dict = Object.create(null);
      for (;;) {
        this.skip();
        if (this.p >= s.length) break;
        if (s.startsWith('>>', this.p)) { this.p += 2; break; }
        const key = this.read();
        const value = this.read();
        if (key instanceof Name) dict[key.name] = value;
      }
      this.depth -= 1;
      return dict;
    }
    if (c === '<') {
      const end = s.indexOf('>', this.p);
      let hex = s.slice(this.p + 1, end < 0 ? s.length : end).replace(/[^0-9a-fA-F]/g, '');
      this.p = end < 0 ? s.length : end + 1;
      if (hex.length % 2) hex += '0';
      return { string: (hex.match(/../g) ?? []).map((h) => String.fromCharCode(parseInt(h, 16))).join('') };
    }
    if (c === '[') {
      this.p += 1; this.depth += 1;
      const list = [];
      for (;;) {
        this.skip();
        if (this.p >= s.length) break;
        if (s[this.p] === ']') { this.p += 1; break; }
        list.push(this.read());
      }
      this.depth -= 1;
      return list;
    }
    if (DELIMITER.test(c)) { this.p += 1; return new Keyword(c); }
    const word = this.word();
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      // 「番号 世代 R」は参照
      if (/^\d+$/.test(word)) {
        const m = /^[\0\t\n\f\r ]+\d+[\0\t\n\f\r ]+R(?![^\0\t\n\f\r ()<>[\]{}/%])/.exec(s.slice(this.p, this.p + 24));
        if (m) { this.p += m[0].length; return new Ref(Number(word)); }
      }
      return Number(word);
    }
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return new Keyword(word);
  }
  string() {
    let depth = 0;
    let out = '';
    const s = this.s;
    const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
    for (this.p += 1; this.p < s.length; this.p += 1) {
      const c = s[this.p];
      if (c === '\\') {
        const next = s[++this.p];
        const octal = /^[0-7]{1,3}/.exec(s.slice(this.p, this.p + 3));
        if (octal) { out += String.fromCharCode(parseInt(octal[0], 8) & 255); this.p += octal[0].length - 1; } else if (next === '\r') { if (s[this.p + 1] === '\n') this.p += 1; } else if (next !== '\n') out += escapes[next] ?? next;
      } else if (c === '(') { depth += 1; out += c; } else if (c === ')') {
        if (!depth) { this.p += 1; break; }
        depth -= 1; out += c;
      } else out += c;
    }
    return { string: out };
  }
}

// ---- 圧縮の展開

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > LIMIT.stream) throw new PDFError('PDFの中身が大きすぎます。');
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof PDFError) throw error;
    if (!size) throw new PDFError('PDFの圧縮されたデータを展開できません。'); // 末尾の余分なデータは無視する
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

function unpredict(data, { Predictor = 1, Columns = 1, Colors = 1, BitsPerComponent = 8 } = {}) {
  if (Predictor < 10) return data;
  const bpp = Math.max(1, Math.ceil((Colors * BitsPerComponent) / 8));
  const row = Math.ceil((Colors * BitsPerComponent * Columns) / 8);
  const out = new Uint8Array(Math.floor(data.length / (row + 1)) * row);
  for (let y = 0; y * (row + 1) + row < data.length + 0; y++) {
    const type = data[y * (row + 1)];
    for (let x = 0; x < row; x++) {
      const raw = data[y * (row + 1) + 1 + x];
      const a = x >= bpp ? out[y * row + x - bpp] : 0;
      const b = y ? out[(y - 1) * row + x] : 0;
      const c = y && x >= bpp ? out[(y - 1) * row + x - bpp] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      out[y * row + x] = (raw + [0, a, b, Math.floor((a + b) / 2), paeth][type] ) & 255;
    }
  }
  return out;
}

function ascii85(bytes) {
  const text = latin(bytes).replace(/\s/g, '').replace(/^<~/, '').split('~>')[0].replace(/z/g, '!!!!!');
  const out = [];
  for (let i = 0; i < text.length; i += 5) {
    const group = text.slice(i, i + 5);
    let value = 0;
    for (let j = 0; j < 5; j++) value = value * 85 + ((j < group.length ? group.charCodeAt(j) : 117) - 33);
    const four = [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
    out.push(...four.slice(0, group.length - 1));
  }
  return Uint8Array.from(out);
}

// ---- 文書

class Document {
  constructor() { this.objects = new Map(); this.streams = new Map(); }
  get(value) {
    for (let i = 0; i < 20 && value instanceof Ref; i++) value = this.objects.get(value.id);
    return value;
  }
  entry(dict, key) { return this.get(this.get(dict)?.[key]); }
  filters(dict) {
    const filter = this.get(dict.Filter);
    return (Array.isArray(filter) ? filter : filter ? [filter] : []).map((f) => this.get(f)?.name);
  }
  /** ストリームの中身を展開する。写真（DCTDecode）の手前まで。 */
  async data(reference) {
    const record = reference instanceof Ref ? this.streams.get(reference.id) : null;
    if (!record) return null;
    let bytes = record.bytes;
    const params = this.get(record.dict.DecodeParms);
    for (const [i, filter] of this.filters(record.dict).entries()) {
      if (filter === 'FlateDecode') bytes = unpredict(await inflate(bytes), this.get(Array.isArray(params) ? params[i] : params) ?? {});
      else if (filter === 'ASCII85Decode') bytes = ascii85(bytes);
      else if (filter === 'ASCIIHexDecode') bytes = bytesOf((latin(bytes).split('>')[0].replace(/\s/g, '').match(/../g) ?? []).map((h) => String.fromCharCode(parseInt(h, 16))).join(''));
      else if (filter === 'DCTDecode') return { bytes, jpeg: true };
      else return null;
    }
    return { bytes, jpeg: false };
  }
}

async function load(bytes) {
  const text = latin(bytes);
  if (!text.slice(0, 1024).includes('%PDF-')) throw new PDFError('PDFのファイルではありません。');
  const doc = new Document();
  let encrypted = false;
  const header = /(?<![0-9])(\d{1,9})[\0\t\n\f\r ]+\d{1,5}[\0\t\n\f\r ]+obj(?![a-zA-Z])/g;
  for (let m; (m = header.exec(text));) {
    const reader = new Reader(text, header.lastIndex);
    const value = reader.read();
    const id = Number(m[1]);
    doc.objects.set(id, value);
    reader.skip();
    if (text.startsWith('stream', reader.p) && value && typeof value === 'object') {
      let start = reader.p + 6;
      if (text[start] === '\r') start += 1;
      if (text[start] === '\n') start += 1;
      let end = typeof value.Length === 'number' ? start + value.Length : -1;
      if (end < 0 || !/^[\0\t\n\f\r ]*endstream/.test(text.slice(end, end + 20))) {
        end = text.indexOf('endstream', start);
        if (end < 0) end = text.length;
        while (end > start && /[\r\n]/.test(text[end - 1])) end -= 1;
      }
      doc.streams.set(id, { dict: value, bytes: bytes.subarray(start, end) });
      header.lastIndex = end;
    } else header.lastIndex = Math.max(header.lastIndex, reader.p);
    if (value?.Type?.name === 'XRef' && value.Encrypt !== undefined) encrypted = true;
  }
  if (/trailer[\s\S]{0,2000}?\/Encrypt[\s\/<0-9]/.test(text)) encrypted = true;
  if (encrypted) return { doc, encrypted };
  // まとめて圧縮された値（オブジェクトストリーム）
  for (const [id, record] of [...doc.streams]) {
    if (record.dict.Type?.name !== 'ObjStm') continue;
    const data = await doc.data(new Ref(id));
    if (!data) continue;
    const inner = latin(data.bytes);
    const head = new Reader(inner);
    const list = Array.from({ length: Math.min(doc.get(record.dict.N) ?? 0, 10000) }, () => [head.read(), head.read()]);
    for (const [number, offset] of list) if (!doc.streams.has(number)) doc.objects.set(number, new Reader(inner, doc.get(record.dict.First) + offset).read());
  }
  return { doc, encrypted };
}

function pageList(doc) {
  const catalog = [...doc.objects.values()].reverse().find((o) => o?.Type?.name === 'Catalog');
  const pages = [];
  const seen = new Set();
  function walk(node, inherited, depth) {
    const dict = doc.get(node);
    if (!dict || seen.has(dict) || depth > 30 || pages.length >= LIMIT.pages) return;
    seen.add(dict);
    const next = { ...inherited };
    for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) if (dict[key] !== undefined) next[key] = dict[key];
    const kids = doc.get(dict.Kids);
    if (Array.isArray(kids)) for (const kid of kids) walk(kid, next, depth + 1);
    else pages.push({ dict, ...next });
  }
  walk(catalog?.Pages, {}, 0);
  return pages;
}

// ---- フォント

/** ToUnicode の対応表 */
function parseCMap(text) {
  const map = new Map();
  let length = null;
  const unicode = (value) => {
    const s = value?.string ?? '';
    let out = '';
    for (let i = 0; i + 1 < s.length; i += 2) out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
    return s.length === 1 ? s : out;
  };
  const code = (value) => [...(value?.string ?? '')].reduce((n, c) => n * 256 + c.charCodeAt(0), 0);
  const section = (name, size, apply) => {
    for (const m of text.matchAll(new RegExp(`begin${name}([\\s\\S]*?)end${name}`, 'g'))) {
      const reader = new Reader(m[1]);
      for (;;) {
        const items = Array.from({ length: size }, () => reader.read());
        if (items.some((x) => x === undefined)) break;
        apply(items);
      }
    }
  };
  section('codespacerange', 2, ([low]) => { length ??= low.string.length; });
  section('bfchar', 2, ([from, to]) => { map.set(code(from), unicode(to)); length ??= from.string.length; });
  section('bfrange', 3, ([low, high, to]) => {
    const a = code(low), b = Math.min(code(high), code(low) + 5000);
    length ??= low.string.length;
    for (let i = a; i <= b; i++) {
      if (Array.isArray(to)) { if (to[i - a]) map.set(i, unicode(to[i - a])); } else {
        const base = unicode(to);
        map.set(i, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (i - a)));
      }
    }
  });
  return { map, length };
}

const decoder = (label) => { try { return new TextDecoder(label); } catch { return null; } };

async function loadFont(doc, reference, standard) {
  const dict = doc.get(reference);
  const type0 = dict?.Subtype?.name === 'Type0';
  const encoding = doc.get(dict?.Encoding)?.name ?? '';
  const mapping = dict?.ToUnicode ? await doc.data(dict.ToUnicode) : null;
  let cmap = mapping ? parseCMap(latin(mapping.bytes)) : null;
  // 対応表を省いた日本語PDF：Adobe-Japan1 の標準の対応表を使う
  if (!cmap && type0 && /Identity/.test(encoding)) {
    const system = doc.entry(doc.get(doc.entry(dict, 'DescendantFonts')?.[0]), 'CIDSystemInfo');
    if (doc.get(system?.Ordering)?.string === 'Japan1') cmap = await standard();
  }
  const widths = new Map();
  let defaultWidth = type0 ? 1000 : 500;
  if (type0) {
    const child = doc.get(doc.entry(dict, 'DescendantFonts')?.[0]);
    defaultWidth = doc.entry(child, 'DW') ?? 1000;
    const list = (doc.entry(child, 'W') ?? []).map((x) => doc.get(x));
    for (let i = 0; i < list.length;) {
      if (Array.isArray(list[i + 1])) { list[i + 1].forEach((w, j) => widths.set(list[i] + j, doc.get(w))); i += 2; } else {
        for (let c = list[i]; c <= Math.min(list[i + 1], list[i] + 70000); c++) widths.set(c, list[i + 2]);
        i += 3;
      }
    }
  } else {
    const first = doc.entry(dict, 'FirstChar') ?? 0;
    (doc.entry(dict, 'Widths') ?? []).forEach((w, i) => widths.set(first + i, doc.get(w)));
  }
  const rksj = /RKSJ/.test(encoding) ? decoder('shift_jis') : null;
  const ucs = /Uni.*(UCS2|UTF16)/.test(encoding) ? decoder('utf-16be') : null;
  const single = !type0 ? decoder(encoding === 'MacRomanEncoding' ? 'macintosh' : 'windows-1252') : null;
  const identity = /Identity/.test(encoding);
  const unitLength = type0 ? (identity ? 2 : cmap?.length ?? 2) : 1;
  /** 文字列を [コード, 文字, 幅, 空白か] の列にする */
  return function glyphs(string) {
    const out = [];
    for (let i = 0; i < string.length;) {
      const first = string.charCodeAt(i);
      const length = rksj ? ((first >= 0x81 && first <= 0x9f) || (first >= 0xe0 && first <= 0xfc) ? 2 : 1) : unitLength;
      const part = string.slice(i, i + length);
      i += length;
      const code = [...part].reduce((n, c) => n * 256 + c.charCodeAt(0), 0);
      let text = cmap?.map.get(code);
      if (text === undefined) text = rksj ? rksj.decode(bytesOf(part)) : ucs ? ucs.decode(bytesOf(part)) : single ? single.decode(bytesOf(part)) : '';
      const width = widths.get(code) ?? (rksj || ucs ? (text.charCodeAt(0) < 0x100 || (text >= '｡' && text <= 'ﾟ') ? 500 : 1000) : defaultWidth);
      out.push([code, text, width, length === 1 && code === 32]);
    }
    return out;
  };
}

// ---- ページの中身

const multiply = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];

async function interpret(doc, content, resources, matrix, out, depth, fonts, standard) {
  const reader = new Reader(content);
  let ctm = matrix;
  const stack = [];
  const state = { font: null, size: 1, tc: 0, tw: 0, th: 1, leading: 0, rise: 0 };
  let tm = [1, 0, 0, 1, 0, 0], line = tm;
  let operands = [];
  const move = (x, y) => { line = multiply([1, 0, 0, 1, x, y], line); tm = line; };
  function show(parts) {
    let run = null;
    const flush = () => { if (run && run.text.trim()) out.runs.push(run); run = null; };
    for (const part of parts) {
      if (typeof part === 'number') {
        tm = multiply([1, 0, 0, 1, (-part / 1000) * state.size * state.th, 0], tm);
        if (part < -250 || part > 600) flush();
        continue;
      }
      if (!state.font || part?.string === undefined) continue;
      for (const [, text, width, space] of state.font(part.string)) {
        const start = multiply([state.size * state.th, 0, 0, state.size, 0, state.rise], multiply(tm, ctm));
        const advance = ((width / 1000) * state.size + state.tc + (space ? state.tw : 0)) * state.th;
        const full = multiply(tm, ctm);
        const glyphWidth = (width / 1000) * state.size * state.th;
        const end = [start[4] + glyphWidth * full[0], start[5] + glyphWidth * full[1]];
        run ??= { text: '', x: start[4], y: start[5], endX: end[0], endY: end[1], size: Math.hypot(start[2], start[3]) };
        run.text += text; run.endX = end[0]; run.endY = end[1];
        tm = multiply([1, 0, 0, 1, advance, 0], tm);
        out.operations += 1;
      }
    }
    flush();
  }
  for (;;) {
    const token = reader.read();
    if (token === undefined || out.operations > LIMIT.operations) break;
    if (!(token instanceof Keyword)) { operands.push(token); if (operands.length > 64) operands.shift(); continue; }
    out.operations += 1;
    const o = operands;
    const number = (i) => (typeof o[i] === 'number' ? o[i] : 0);
    switch (token.word) {
      case 'q': stack.push([ctm, { ...state }]); break;
      case 'Q': { const saved = stack.pop(); if (saved) { [ctm] = saved; Object.assign(state, saved[1]); } break; }
      case 'cm': ctm = multiply([0, 1, 2, 3, 4, 5].map(number), ctm); break;
      case 'BT': tm = line = [1, 0, 0, 1, 0, 0]; break;
      case 'Tf': {
        const name = o[0]?.name;
        const reference = doc.entry(resources, 'Font')?.[name];
        if (reference && !fonts.has(reference.id ?? reference)) fonts.set(reference.id ?? reference, await loadFont(doc, reference, standard));
        state.font = reference ? fonts.get(reference.id ?? reference) : null;
        state.size = number(1);
        break;
      }
      case 'Tm': tm = line = [0, 1, 2, 3, 4, 5].map(number); break;
      case 'Td': move(number(0), number(1)); break;
      case 'TD': state.leading = -number(1); move(number(0), number(1)); break;
      case 'T*': move(0, -state.leading); break;
      case 'TL': state.leading = number(0); break;
      case 'Tc': state.tc = number(0); break;
      case 'Tw': state.tw = number(0); break;
      case 'Tz': state.th = number(0) / 100; break;
      case 'Ts': state.rise = number(0); break;
      case 'Tj': show([o.at(-1)]); break;
      case 'TJ': show(Array.isArray(o.at(-1)) ? o.at(-1) : []); break;
      case "'": move(0, -state.leading); show([o.at(-1)]); break;
      case '"': state.tw = number(0); state.tc = number(1); move(0, -state.leading); show([o.at(-1)]); break;
      case 'Do': {
        const reference = doc.entry(resources, 'XObject')?.[o[0]?.name];
        const record = reference instanceof Ref ? doc.streams.get(reference.id) : null;
        const kind = record?.dict.Subtype?.name;
        if (kind === 'Image') {
          const width = doc.get(record.dict.Width), height = doc.get(record.dict.Height);
          if (width >= 200 && height >= 200 && out.images.length < 12) {
            const data = await doc.data(reference);
            if (data?.jpeg) out.images.push({ data: data.bytes, width, height }); else out.unsupportedImages += 1;
          }
        } else if (kind === 'Form' && depth < 5) {
          const data = await doc.data(reference);
          const inner = doc.get(record.dict.Matrix) ?? [1, 0, 0, 1, 0, 0];
          if (data) await interpret(doc, latin(data.bytes), doc.get(record.dict.Resources) ?? resources, multiply(inner, ctm), out, depth + 1, fonts, standard);
        }
        break;
      }
      case 'BI': { // 本文中の小さな画像は読み飛ばす
        const end = /[\s]EI(?![a-zA-Z])/g;
        end.lastIndex = reader.p;
        const found = end.exec(content);
        reader.p = found ? end.lastIndex : content.length;
        break;
      }
      default: break;
    }
    operands = [];
  }
}

/** ページ上の位置を 0〜1（左上が原点）に直す */
function fragment(run, box, rotate) {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0 || 1, h = y1 - y0 || 1;
  const place = (x, y) => {
    const u = (x - x0) / w, v = (y - y0) / h;
    if (rotate === 90) return [v, u];
    if (rotate === 180) return [1 - u, v];
    if (rotate === 270) return [1 - v, 1 - u];
    return [u, 1 - v];
  };
  const [ax, ay] = place(run.x, run.y);
  const [bx] = place(run.endX, run.endY);
  const height = run.size / (rotate % 180 ? w : h);
  return { text: run.text, x: Math.min(ax, bx), y: ay - height * 0.85, width: Math.abs(bx - ax), height };
}

/**
 * { encrypted, pages: [{ fragments, images, unsupportedImages, rotate }] }
 * japan1：Adobe-Japan1 の対応表の文字列を返す関数（必要なときだけ呼ぶ）
 */
export async function readPDF(bytes, { japan1 = null } = {}) {
  if (bytes.length > LIMIT.bytes) throw new PDFError('PDFは15MBまで取り込めます。');
  const { doc, encrypted } = await load(bytes);
  if (encrypted) return { encrypted: true, pages: [] };
  const list = pageList(doc);
  if (!list.length) throw new PDFError('PDFのページを読み取れません。');
  const fonts = new Map();
  let table;
  const standard = async () => {
    if (table === undefined) { const text = japan1 ? await japan1() : null; table = text ? parseCMap(text) : null; }
    return table;
  };
  const pages = [];
  for (const page of list) {
    const contents = doc.get(page.dict.Contents);
    const references = Array.isArray(contents) ? contents : [page.dict.Contents];
    let content = '';
    for (const reference of references) { const data = await doc.data(reference); if (data) content += `${latin(data.bytes)}\n`; }
    const out = { runs: [], images: [], unsupportedImages: 0, operations: 0 };
    await interpret(doc, content, doc.get(page.Resources), [1, 0, 0, 1, 0, 0], out, 0, fonts, standard);
    const box = (doc.get(page.CropBox) ?? doc.get(page.MediaBox) ?? [0, 0, 595, 842]).map((v) => doc.get(v));
    const rotate = (((doc.get(page.Rotate) ?? 0) % 360) + 360) % 360;
    pages.push({ fragments: out.runs.map((r) => fragment(r, box, rotate)).filter((f) => f.y > -0.05 && f.y < 1.05), images: out.images, unsupportedImages: out.unsupportedImages, rotate });
  }
  return { encrypted: false, pages };
}
