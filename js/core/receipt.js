// レシート・明細の解析、金額の配分、重複確認（Swift版の ReceiptParser / Allocation / DuplicateCheck と同じ規則）。
// 読み取れない値は null のままにする（推測で埋めない）。
import { isDay, makeDay, daysBetween } from './date.js';
import { live } from './ledger.js';

/** 認識した単語を、高さが重なるものどうし1行にまとめて左から並べる */
export function layoutLines(fragments) {
  const rows = [];
  for (const f of [...fragments].sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2))) {
    const first = rows.at(-1)?.[0];
    if (first && Math.abs(f.y + f.height / 2 - (first.y + first.height / 2)) < Math.max(first.height, f.height) * 0.6) rows.at(-1).push(f);
    else rows.push([f]);
  }
  return rows.map((row) => {
    const sorted = row.sort((a, b) => a.x - b.x);
    // 近い単語はつなげ、離れた単語は空白で区切る
    return sorted.reduce((text, f, i) => {
      if (!i) return f.text;
      const gap = f.x - (sorted[i - 1].x + sorted[i - 1].width);
      return text + (gap > f.height * 0.9 ? '  ' : '') + f.text;
    }, '');
  });
}

const JA = '[\\u3040-\\u30ff\\u3400-\\u9fff々ー]';
/** 文字認識（Tesseract）で起こりやすい形の乱れを直す。手で貼り付けた文字には使わない。 */
export function cleanOCRLine(line) {
  return normalize(line)
    .replace(new RegExp(`(${JA}) (?=${JA})`, 'g'), '$1')
    .replace(/[¥￥] +(?=[\d-])/g, '¥')
    .replace(/(?<![A-Za-z0-9])[YyVv](?=(?:\d{1,3}(?:[,.]\d{3})+|\d{2,7})(?!\d))/g, '¥')
    .replace(/(\d)[.,]{2,}(\d{3})(?![\d.])/g, '$1,$2') // 「2.,530」のような二重の区切り
    .replace(/(\d)\.(\d{3})(?![\d.])/g, '$1,$2')
    .replace(/(\d) *, *(\d{3})/g, '$1,$2');
}

export function normalize(text) {
  return String(text).normalize('NFKC').replace(/[￥\\]/g, '¥').replace(/　/g, ' ');
}

/** カード番号や長い番号は残さない */
export const redact = (text) => String(text)
  .replace(/(?:[\d*Xx●•]{4}[ -]?){2,}[\d*Xx●•]{2,4}/g, '〔番号〕')
  .replace(/[Tt]?\d{8,}/g, '〔番号〕');

export function amounts(line) {
  const pattern = /([-−▲△]\s*)?(¥\s*)?([-−▲△]\s*)?(\d{1,3}(?:[,，]\d{3})+|\d+)(\s*円)?/g;
  const found = [];
  for (const m of line.matchAll(pattern)) {
    const start = m.index;
    const end = start + m[0].length;
    const before = line[start - 1];
    const after = line.slice(end).replace(/^ +/, '')[0];
    const marked = m[2] !== undefined || m[5] !== undefined;
    const digits = m[4].replace(/\D/g, '');
    const hasComma = m[4].includes(',');
    if (!marked) {
      if (after && '%％年月日時分個点コ枚本袋箱g mkKlL:/-.×xX'.includes(after)) continue;
      if (before && (':/-.@×xX'.includes(before) || /[A-Za-z]/.test(before))) continue;
      if (!hasComma) {
        const tail = line.slice(end).replace(/^[ )*※軽内外非]+|[ )*※軽内外非]+$/g, '');
        if (tail || digits.length < 2 || digits.length > 7) continue;
      }
    }
    if (before === '@') continue;
    if (digits.length > 10) continue;
    const negative = m[1] !== undefined || m[3] !== undefined;
    found.push({ value: negative ? -Number(digits) : Number(digits), start, end });
  }
  return found;
}

export function findDay(line, today) {
  const make = (y, m, d) => { const text = makeDay(y, m, d); return isDay(text) ? text : null; };
  let m = line.match(/(20\d{2})\s*[年/.-]\s*(\d{1,2})\s*[月/.-]\s*(\d{1,2})\s*日?/);
  if (m && make(+m[1], +m[2], +m[3])) return { day: make(+m[1], +m[2], +m[3]), assumed: false, match: m };
  m = line.match(/令和\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m && make(2018 + +m[1], +m[2], +m[3])) return { day: make(2018 + +m[1], +m[2], +m[3]), assumed: false, match: m };
  m = line.match(/(?<!\d)(2\d)\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m && make(2000 + +m[1], +m[2], +m[3])) return { day: make(2000 + +m[1], +m[2], +m[3]), assumed: false, match: m };
  m = line.match(/(?<![\d/])(\d{2})\/(\d{1,2})\/(\d{1,2})(?![\d/])/);
  if (m && make(2000 + +m[1], +m[2], +m[3])) return { day: make(2000 + +m[1], +m[2], +m[3]), assumed: false, match: m };
  m = line.match(/(?<![\d/])(\d{1,2})\s*[月/]\s*(\d{1,2})\s*日?(?![\d/])/);
  if (m) {
    const year = Number(today.slice(0, 4));
    for (const y of [year, year - 1]) {
      const day = make(y, +m[1], +m[2]);
      if (day && day <= today) return { day, assumed: true, match: m };
    }
  }
  return null;
}

const TOTAL = ['現計', 'お買上計', 'お買上げ計', 'お買い上げ計', '税込計', '合計', 'ご請求額', 'ご請求金額', '請求金額', 'お支払金額', 'お支払い金額', '支払金額', '領収金額', 'お会計', '注文合計', '支払い合計', 'ご利用金額合計', '今回請求'];
const SKIP = ['お釣', '釣銭', 'つり銭', 'お預', '預り', '預かり', 'ポイント残', '獲得', '付与', '点数', '対象', 'TEL', '電話', '登録番号', '担当', '責任者', '会員番号', '承認番号', '伝票', '残高', 'No.', '番号'];
// 電話番号・会員番号など、金額ではない案内の行。値引きにも、合計より後の行の始まりにもしない。
const INFO = ['TEL', '電話', '登録番号', '承認番号', '伝票', '会員番号', '会員No', 'カード番号', 'No.', '担当', '責任者'];
const DISCOUNT = ['値引', '割引', 'クーポン', 'ポイント利用', 'ポイント値引', '特売値引', 'OFF'];

const has = (line, words) => { const compact = line.replace(/ /g, '').toLowerCase(); return words.some((w) => compact.includes(w.toLowerCase())); };

export function paymentHint(line) {
  if (has(line, ['PayPay', 'ペイペイ'])) return 'paypay';
  if (has(line, ['クレジット', 'VISA', 'Master', 'JCB', 'AMEX', 'カード払', 'カード支払'])) return 'card';
  if (has(line, ['Suica', 'PASMO', 'ICOCA', '交通系', 'nanaco', 'WAON', 'QUICPay', 'iD支払', '電子マネー', '楽天Edy'])) return 'emoney';
  if (has(line, ['現金', '現計', 'お預り', 'お預かり'])) return 'cash';
  return null;
}

function cleanName(text) {
  let name = text.replace(/^[ 　*※・:：¥\-−]+|[ 　*※・:：¥\-−]+$/g, '');
  name = name.replace(/\s{2,}/g, ' ').replace(/^\d{3,}\s*/, '')
    .replace(/\s*\d+\s*(点|コ|個)?\s*[@×xX]\s*単?\d[\d,]*$/, '').replace(/\s*\d+\s*点\s*$/, '').replace(/\s*(軽|内|外|非)$/, '');
  return redact(name).trim();
}

function quantity(line) {
  for (const pattern of [/(\d+)\s*点/, /(\d+)\s*[コ個冊本枚]\s*[@×xX]/, /[×xX]\s*(\d+)(?!\d|,)/]) {
    const m = line.match(pattern);
    if (m && +m[1] >= 1 && +m[1] <= 999) return +m[1];
  }
  return null;
}

/** 数量・単価・金額の表記だけで、商品名ではない */
const onlyQuantity = (name) => name.replace(/数量|単価|金額|リットル|[\d.,]+|[Lℓ点コ個冊本枚単@×xX¥ ]/g, '') === '';

function statementRows(lines, today) {
  const rows = [];
  for (const line of lines) {
    const date = findDay(line, today);
    if (!date) continue;
    const rest = (line.slice(0, date.match.index) + line.slice(date.match.index + date.match[0].length))
      .replace(/(?<!\d)([01]?\d|2[0-3]):[0-5]\d/g, ' ');
    const first = amounts(rest)[0];
    if (!first) continue;
    const name = cleanName(rest.slice(0, first.start));
    if (!name || !first.value) continue;
    const isIncome = has(name, ['入金', '給与', '給料', '賞与', '利息', '振込入', '受取', '返金', 'チャージ受']) || rest.includes('+');
    rows.push({ day: date.day, isYearAssumed: date.assumed, description: name, amount: Math.abs(first.value), isIncome });
  }
  return rows;
}

export function parseDocument(rawLines, today) {
  const lines = rawLines.map(normalize).map((l) => l.trim()).filter(Boolean);
  const result = { kind: 'receipt', storeName: null, day: null, time: null, items: [], discount: 0, subtotal: null, addedTax: 0, includedTax: 0, total: null, payment: null, rows: [] };

  const rows = statementRows(lines, today);
  if (rows.length >= 3) {
    result.kind = 'statement';
    result.rows = rows;
    const title = lines.find((l) => !findDay(l, today) && !amounts(l).length);
    result.storeName = title ? redact(title) : null;
    result.payment = lines.map(paymentHint).find(Boolean) ?? null;
    return result;
  }

  let pending = null;
  let summary = false;
  const totals = [];
  lines.forEach((line, index) => {
    const found = amounts(line);
    const date = findDay(line, today);
    if (!result.day && date && !date.assumed) result.day = date.day;
    if (!result.time) result.time = line.match(/(?<!\d)([01]?\d|2[0-3]):[0-5]\d/)?.[0] ?? null;
    const hint = paymentHint(line);
    if (hint && (!result.payment || result.payment === 'cash')) result.payment = hint;
    if (date) { pending = null; return; }
    if (!result.storeName && index < 4 && !found.length && !has(line, ['領収', 'レシート', '明細', '御中', '注文', 'ありがとう', 'TEL', '電話', '登録番号']) && line.length >= 2) {
      result.storeName = cleanName(line);
      return;
    }
    if (has(line, INFO) && !has(line, TOTAL) || /レジ(?!袋)/.test(line)) { pending = null; return; }
    // 「数量 25.50L 単価 178」のような内訳の行は、商品にしない（直前の商品名は残す）
    if (line.includes('単価') && !found.some((a) => line.slice(a.start, a.end).match(/¥|円/))) return;
    const amount = found.at(-1);
    if (!amount) {
      // 数量と単価だけの行は、直前の商品名を残す
      if (!summary && !has(line, [...SKIP, ...TOTAL, '小計', '税', '領収', '支払']) && line.length >= 2 && !onlyQuantity(cleanName(line))) pending = cleanName(line);
      return;
    }
    const name = cleanName(line.slice(0, found[0].start));
    if (has(line, ['小計', '商品の小計'])) {
      result.subtotal = amount.value;
      summary = true;
    } else if (line.includes('税') && !has(line, ['税込合計', '合計(税込)', '税込計'])) {
      summary = true;
      if (!has(line, ['対象'])) {
        if (line.includes('内') || line.includes('税込')) result.includedTax += Math.abs(amount.value);
        else if (has(line, ['外税', '消費税'])) result.addedTax += Math.abs(amount.value);
      } else return;
    } else if (amount.value < 0 || has(line, DISCOUNT)) {
      if (!summary && result.items.length) result.items.at(-1).discount += Math.abs(amount.value);
      else result.discount += Math.abs(amount.value);
    } else if (has(line, TOTAL) && !has(line, ['点数'])) {
      totals.push({ priority: has(line, ['合計', '請求']) ? 2 : 1, value: amount.value });
      summary = true;
    } else if (has(line, SKIP) || paymentHint(line) || has(line, ['支払'])) {
      summary = true;
    } else if (!summary) {
      const itemName = !name || onlyQuantity(name) ? pending ?? '' : name;
      if (itemName && amount.value > 0) {
        result.items.push({ name: itemName, quantity: quantity(line), amount: amount.value, discount: 0, isReducedRate: line.includes('※') || line.includes('軽') });
      }
    }
    pending = null;
  });
  const best = Math.max(0, ...totals.map((t) => t.priority));
  result.total = totals.filter((t) => t.priority === best).at(-1)?.value ?? null;
  if (result.addedTax > 0 && result.total != null) {
    const base = (result.subtotal ?? result.items.reduce((s, i) => s + i.amount - i.discount, 0)) - result.discount;
    if (result.total === base) { result.includedTax += result.addedTax; result.addedTax = 0; }
  }
  if (has(lines.join(''), ['検針', 'ご使用量', '使用量', 'ご利用料金', '請求書', 'ご請求']) && result.items.length <= 1) {
    result.kind = 'bill';
    result.items = [];
  }
  return result;
}

/** amount を weights の比で分ける。端数は割り切れなかった分が大きい順に1円ずつ。整数だけで計算する。 */
export function distribute(amount, weights) {
  if (!weights.length) return [];
  const safe = weights.map((w) => BigInt(Math.max(0, w)));
  const sum = safe.reduce((a, b) => a + b, 0n);
  if (sum === 0n) return weights.map((_, i) => (i ? 0 : amount));
  const sign = amount < 0 ? -1 : 1;
  const total = BigInt(Math.abs(amount));
  const result = safe.map((w) => (total * w) / sum);
  const remainders = safe.map((w, i) => ({ i, r: (total * w) % sum }));
  let left = total - result.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) => (a.r !== b.r ? (a.r > b.r ? -1 : 1) : a.i - b.i));
  for (const { i } of remainders) { if (left <= 0n) break; result[i] += 1n; left -= 1n; }
  return result.map((v) => Number(v) * sign);
}

/** 商品の値引きを引き、全体の値引きと外税を金額の比で配る */
export function payableAmounts(items, discount, addedTax) {
  const base = items.map((i) => i.amount - i.discount);
  const discounts = distribute(discount, base);
  const after = base.map((v, i) => v - discounts[i]);
  const taxes = distribute(addedTax, after);
  return after.map((v, i) => v + taxes[i]);
}

export const sameFile = (data, fingerprints) => live(data.receipts).filter((r) => r.fingerprints.some((f) => fingerprints.includes(f))
  && live(data.transactions).some((t) => t.receiptID === r.id));

export function similarEntries(data, amount, day, kind = 'expense', within = 3) {
  const statements = new Set(data.receipts.filter((r) => r.kind === 'statement').map((r) => r.id));
  const groups = new Map();
  for (const t of live(data.transactions).filter((t) => t.kind === kind)) {
    const key = t.receiptID && !statements.has(t.receiptID) ? t.receiptID : t.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  return [...groups.values()].map((group) => {
    const sorted = group.sort((a, b) => (a.day !== b.day ? (a.day > b.day ? -1 : 1) : b.createdAt - a.createdAt));
    return { entryIDs: sorted.map((t) => t.id), day: sorted[0].day, amount: sorted.reduce((s, t) => s + t.amount, 0), storeName: sorted[0].storeName ?? '' };
  }).filter((g) => g.amount === amount && Math.abs(daysBetween(g.day, day)) <= within)
    .sort((a, b) => Math.abs(daysBetween(a.day, day)) - Math.abs(daysBetween(b.day, day)) || (a.entryIDs[0] < b.entryIDs[0] ? -1 : 1));
}

export function isCardWithdrawal(description, cardNames) {
  const text = normalize(description).replace(/ /g, '');
  const contains = (w) => text.toLowerCase().includes(w.toLowerCase());
  const cardWords = ['カード', ...cardNames];
  const withdrawal = ['引落', '引き落', '口座振替', 'ご請求', 'お支払', 'カードサービス', 'ラクテンカードサービス'];
  return cardWords.some(contains) && (withdrawal.some(contains) || cardNames.some(contains) || contains('カードサービス'));
}

export function statementStatus(data, rows) {
  const used = new Set();
  const cardNames = live(data.cards).map((c) => c.name);
  return rows.map((row) => {
    if (!row.isIncome && isCardWithdrawal(row.description, cardNames)) return { type: 'cardWithdrawal' };
    if (!row.day) return { type: 'new' };
    const kinds = row.isIncome ? ['income', 'refund'] : ['expense', 'cardPayment', 'transfer'];
    const matches = live(data.transactions).filter((t) => kinds.includes(t.kind) && t.amount === row.amount && !used.has(t.id) && Math.abs(daysBetween(t.day, row.day)) <= 3)
      .sort((a, b) => Math.abs(daysBetween(a.day, row.day)) - Math.abs(daysBetween(b.day, row.day)));
    if (!matches.length) return { type: 'new' };
    used.add(matches[0].id);
    return { type: 'recorded', entryID: matches[0].id };
  });
}
