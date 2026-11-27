// レシート・明細の解析、金額の配分、重複確認（Swift版の ReceiptParser / Allocation / DuplicateCheck と同じ規則）。
// 読み取れない値は null のままにする（推測で埋めない）。
import { isDay, makeDay, daysBetween } from './date.js';
import { live } from './ledger.js';
import { yen } from './money.js';

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
  return japaneseForms(normalize(line))
    .replace(/([ァ-ヺ])[一—―](?=[ァ-ヺ]|[\s\d]|$)/g, '$1ー') // 長音を漢字の「一」と読んだもの
    // 形が同じ漢字とカタカナの取り違え：両側がカタカナならカタカナ、両側が漢字なら漢字
    .replace(/(?<=[ァ-ヺー])[力口工夕卜](?=[ァ-ヺー])/g, (c) => ({ 力: 'カ', 口: 'ロ', 工: 'エ', 夕: 'タ', 卜: 'ト' })[c])
    .replace(/(?<=[一-鿿])[カロエタ](?=[一-鿿])/g, (c) => ({ カ: '力', ロ: '口', エ: '工', タ: '夕' })[c])
    .replace(new RegExp(`(${JA}) (?=${JA})`, 'g'), '$1')
    .replace(/[¥￥] +(?=[\d-])/g, '¥')
    .replace(/(?<![A-Za-z0-9])[YyVv](?=(?:\d{1,3}(?:[,.]\d{3})+|\d{2,7})(?!\d))/g, '¥')
    .replace(/(\d)[.,]{2,}(\d{3})(?![\d.])/g, '$1,$2') // 「2.,530」のような二重の区切り
    .replace(/(\d)\.(\d{3})(?![\d.])/g, '$1,$2')
    .replace(/(\d) *, *(\d{3})/g, '$1,$2');
}

// 文字認識が日本語の漢字を中国の字体で返すことがある。日本語では使わない字だけを置き換える。
const SIMPLIFIED = '剂费个单价领证时间计额现钱饮饭鸡鱼鲜汤热冻乌无纸电话账员买卖购货总应对预币张营业门车马鸟药妆护齿肤卫产东书杂语请谢欢临优积码绿红蓝丽种类细级经结给线终统绢绵纳网罗记订认让设评试调饼馒烧炼养组补净洁选扫术疗诊处场图团园圆长开关闭问阳页顶项顺顾题风飞馆';
const JAPANESE = '剤費個単価領証時間計額現銭飲飯鶏魚鮮湯熱凍烏無紙電話帳員買売購貨総応対預幣張営業門車馬鳥薬粧護歯膚衛産東書雑語請謝歓臨優積碼緑紅藍麗種類細級経結給線終統絹綿納網羅記訂認譲設評試調餅饅焼練養組補浄潔選掃術療診処場図団園円長開関閉問陽頁頂項順顧題風飛館';
const VARIANT = new Map([...SIMPLIFIED].map((c, i) => [c, [...JAPANESE][i]]));
export const japaneseForms = (text) => [...text].map((c) => VARIANT.get(c) ?? c).join('');
// 繁体字で返ることがある字（人名などで使う旧字体は変えない）
for (const [from, to] of ['綠緑', '劑剤', '單単', '價価', '點点', '稅税', '內内', '錢銭', '麵麺', '燒焼']) VARIANT.set(from, to);

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

const TOTAL = ['現計', 'お買上計', 'お買上げ計', 'お買い上げ計', '税込計', '合計', 'ご請求額', 'ご請求金額', '請求金額', 'お支払金額', 'お支払い金額', '支払金額', '領収金額', 'お会計', '注文合計', '支払い合計', 'ご利用金額合計', '今回請求',
  'お支払額', 'お支払い額', 'お買上金額', 'お買上げ金額', 'お買い上げ金額', 'ご利用金額', 'ご利用額'];
/** 税込みの合計の書き方（「合計(税込)」「税込合計」など）。税額の行（「内税合計」「合計内税額」）は含めない */
const TAXED_TOTAL = /^(総?合計(金額)?|お会計|お買い?上げ?計|現計)[([]?(税込|内税)(?![額等])|税込み?(合計|計|金額|総額|お支払)|(合計|総額)[([]税込/;
/** 税を足した後の小計（「小計＋税」「税込小計」など）。税抜きの小計は含めない */
const TAXED_SUBTOTAL = /小計[+十&・]?(消費)?税(?![抜別額率]|対象)|税込み?小計|小計[([]税込/;
/** 受け取ったお金・お釣り・現金以外の支払いの行 */
const TENDER = /^.{0,2}?(お?預(り|かり)|お預け)|^現金(支払い?|払い?|預り?)?[:：]?[¥\d]/;
const CHANGE = /^.{0,2}?(お釣|おつり|釣銭|つり銭)|^釣り?[:：]?[¥\d]/; // 「釣り糸」などの商品は含めない
const VOUCHER = /商品券|ギフトカード|ギフト券|金券|お食事券/;
const SKIP = ['お釣', '釣銭', 'つり銭', 'お預', '預り', '預かり', 'ポイント残', '獲得', '付与', '点数', '対象', 'TEL', '電話', '登録番号', '担当', '責任者', '会員番号', '承認番号', '伝票', '残高', 'No.', '番号'];
// 電話番号・会員番号など、金額ではない案内の行。値引きにも、合計より後の行の始まりにもしない。
const INFO = ['TEL', '電話', '登録番号', '承認番号', '伝票', '会員番号', '会員No', 'カード番号', 'No.', '担当', '責任者', '人数', '〒'];
/** テーブル番号の行（飲食店のレシート）。家具の「テーブル ¥3,980」は商品。「人数」だけでは宿泊や映画もあるので判断しない */
const SEATED = /^(テーブル|卓)(番号|No\.?)?[:：#]?(\d{1,2}(番|人数|名|$)|\d{3}(番|人数|名))/;
const isSeating = (line) => !/[¥円]/.test(line) && SEATED.test(line.replace(/ /g, ''));
/** 金額の行ではないと形で分かるもの：電話番号、登録番号、バーコードの数字、伏せ字のカード番号 */
const isCode = (line) => /(?<!\d)0\d{1,3}-\d{2,4}-\d{3,4}(?!\d)/.test(line) || /(?<![A-Za-z])T\d{13}(?!\d)/.test(line)
  || /^(?:JAN)?[\d ]{8,}$/i.test(line) || /^JAN/i.test(line) || /[*＊●•]{4}/.test(line);
const DISCOUNT = ['値引', '割引', 'クーポン', 'ポイント利用', 'ポイント値引', '特売値引', 'OFF'];

const has = (line, words) => { const compact = line.replace(/ /g, '').toLowerCase(); return words.some((w) => compact.includes(w.toLowerCase())); };

export function paymentHint(line) {
  if (has(line, ['PayPay', 'ペイペイ'])) return 'paypay';
  if (has(line, ['クレジット', 'VISA', 'Master', 'JCB', 'AMEX', 'カード払', 'カード支払'])) return 'card';
  if (has(line, ['Suica', 'PASMO', 'ICOCA', '交通系', 'nanaco', 'WAON', 'QUICPay', 'iD支払', '電子マネー', '楽天Edy'])) return 'emoney';
  if (has(line, ['現金', '現計', 'お預り', 'お預かり'])) return 'cash';
  return null;
}

/** 内・外で始まる言葉で、税の印ではないもの */
const REAL_WORDS = /^(内服|内科|内祝|内臓|内野|内輪|内もも|内モモ|内ロース|内バラ|外用|外郎|外食|外套|外もも|外モモ)/;
/** 商品名の前に印字される税の印（内・外・軽）を除く。続きがカタカナ・英数字のときは、1品だけでも印とみなす */
export const stripTaxMark = (name) => (REAL_WORDS.test(name) ? name : name.replace(/^[内外軽]\*? *(?=[ァ-ヺA-Za-z0-9])/, '').replace(/^非 +/, ''));
/** 多くの商品が内・外で始まるレシートでは、漢字・ひらがなの名前の前でも印とみなす */
function removeTaxMarks(items) {
  const marked = items.filter((i) => /^[内外]/.test(i.name));
  const common = marked.length >= 2 && marked.length * 3 >= items.length * 2;
  for (const item of items) {
    item.name = stripTaxMark(item.name);
    if (common && !REAL_WORDS.test(item.name) && item.name.length > 2) item.name = item.name.replace(/^[内外]\*? */, '');
  }
}

function cleanName(text) {
  let name = text.replace(/^[ 　*※・:：¥\-−()]+|[ 　*※・:：¥\-−(]+$/g, '');
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

/** 「2コ×単98」「@258×3」のような、数量と単価の書き方 */
function unitPrice(line) {
  const price = '(\\d{1,3}(?:,\\d{3})+|\\d+)';
  const first = line.match(new RegExp(`(?<![\\d,])(\\d{1,3}) *(コ|個|点|本|枚|冊|袋|ヶ|ケ|二|ニ)? *[×xX✕*] *(単価?|@)? *¥? *${price}(?![\\d,])`));
  if (first && (first[2] || first[3])) return { quantity: Number(first[1]), unit: Number(first[4].replace(/,/g, '')), match: first };
  const second = line.match(new RegExp(`(?:@|単価?) *¥? *${price} *[×xX✕*] *(\\d{1,3}) *(?:コ|個|点|本|枚|冊|袋|ヶ|ケ)?(?![\\d,])`));
  return second ? { quantity: Number(second[2]), unit: Number(second[1].replace(/,/g, '')), match: second } : null;
}

const LABELS = [...TOTAL, '小計', '税', '値引', '割引', 'クーポン', 'お預', 'お釣', 'おつり', '釣銭'];
/** 金額だけの行 */
function amountOnly(line, today) {
  const found = amounts(line);
  return found.length === 1 && !findDay(line, today) && (line.slice(0, found[0].start) + line.slice(found[0].end)).replace(/[ ¥円()*※軽内外非-]/g, '') === '';
}
const bareLabel = (line, today) => !amounts(line).length && !findDay(line, today) && has(line, LABELS) && !isCode(line);

/** 見出し（合計・税・値引き）と金額が上下の2行に分かれたものを、1行にまとめる */
function joinLabels(lines, today) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], next = lines[i + 1];
    if (next !== undefined && bareLabel(line, today) && amountOnly(next, today)) { out.push(`${line}  ${next}`); i += 1; } else out.push(line);
  }
  return out;
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
  const result = { kind: 'receipt', storeName: null, day: null, time: null, items: [], discount: 0, subtotal: null, addedTax: 0, includedTax: 0, total: null, payment: null, rows: [],
    tendered: null, change: null, payments: [], totalSource: null, venue: null };

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
  let waiting = null; // 先に読んだ数量と単価（金額は次の行）
  let summary = false;
  const totals = [];
  // 「数量」の列がある表では、名前の後ろの数字が数量
  const countColumn = lines.some((l) => l.includes('数量') && l.includes('金額'));
  joinLabels(lines, today).forEach((line, index) => {
    const found = amounts(line);
    const date = findDay(line, today);
    const seated = isSeating(date ? line.replace(date.match[0], ' ').replace(/(?<!\d)([01]?\d|2[0-3]):[0-5]\d/, ' ').trim() : line);
    if (seated) result.venue = 'restaurant';
    if (!result.day && date && !date.assumed) result.day = date.day;
    if (!result.time) result.time = line.match(/(?<!\d)([01]?\d|2[0-3]):[0-5]\d/)?.[0] ?? null;
    const hint = paymentHint(line);
    if (hint && (!result.payment || result.payment === 'cash')) result.payment = hint;
    if (date) { pending = null; return; }
    if (!result.storeName && index < 4 && !found.length && !has(line, ['領収', 'レシート', '明細', '御中', '注文', 'ありがとう', 'TEL', '電話', '登録番号']) && !isCode(line) && line.length >= 2) {
      result.storeName = cleanName(line);
      return;
    }
    if (isCode(line)) return;
    if (has(line, INFO) && !has(line, TOTAL) || seated || /レジ(?!袋)/.test(line)) { pending = null; return; }
    const unit = unitPrice(line);
    if (unit && !summary && unit.quantity >= 1) {
      const rest = (line.slice(0, unit.match.index) + ' ' + line.slice(unit.match.index + unit.match[0].length)).replace(/[()]/g, ' ').trim();
      const value = amounts(rest).at(-1);
      if (value) {
        const own = cleanName(rest.slice(0, amounts(rest)[0].start));
        const name = !own || onlyQuantity(own) ? pending ?? '' : own;
        if (name && value.value > 0) result.items.push({ name, quantity: unit.quantity, unitPrice: unit.unit, amount: value.value, discount: 0, isReducedRate: line.includes('※') || line.includes('軽') });
        pending = null;
      } else {
        const last = result.items.at(-1);
        // 直前の商品の内訳（金額が 数量×単価 と同じ）か、次の行の金額の内訳
        if (!pending && last && last.unitPrice == null && last.amount === unit.quantity * unit.unit) Object.assign(last, { quantity: unit.quantity, unitPrice: unit.unit });
        else { waiting = unit; const own = cleanName(rest); if (own && !onlyQuantity(own)) pending = own; }
      }
      return;
    }
    // 「数量 25.50L 単価 178」のような内訳の行は、商品にしない（直前の商品名は残す）
    if (line.includes('単価') && !found.some((a) => line.slice(a.start, a.end).match(/¥|円/))) return;
    const amount = found.at(-1);
    if (!amount) {
      // 数量と単価だけの行は、直前の商品名を残す
      if (!summary && !has(line, [...SKIP, ...TOTAL, ...DISCOUNT, '小計', '税', '領収', '支払', 'ポイント', 'おつり']) && line.length >= 2 && !onlyQuantity(cleanName(line))) pending = cleanName(line);
      return;
    }
    const name = cleanName(line.slice(0, found[0].start));
    const compact = line.replace(/ /g, '');
    const hinted = paymentHint(line);
    if (TENDER.test(compact) && !/番号|ポイント/.test(compact)) {
      // 「お預り ¥2,000 お釣り ¥275」と1行につながることがある
      const both = found.length > 1 && /お釣|おつり|釣銭|つり銭/.test(compact);
      result.tendered = Math.abs((both ? found.at(-2) : amount).value);
      if (both) result.change = Math.abs(amount.value);
      summary = true;
    } else if (CHANGE.test(compact)) {
      result.change = Math.abs(amount.value);
      summary = true;
    } else if (!/ポイント/.test(compact) && (TAXED_TOTAL.test(compact) || TAXED_SUBTOTAL.test(compact))) {
      totals.push({ priority: TAXED_TOTAL.test(compact) ? 2 : 1, value: amount.value });
      summary = true;
    } else if (has(line, ['小計', '商品の小計'])) {
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
    } else if (VOUCHER.test(compact) && summary) {
      result.payments.push(Math.abs(amount.value));
    } else if (has(line, TOTAL) && !has(line, ['点数', 'ポイント'])) {
      totals.push({ priority: has(line, ['合計', '請求']) ? 2 : 1, value: amount.value });
      summary = true;
    } else if (has(line, SKIP) || hinted || has(line, ['支払', 'ポイント'])) {
      if (hinted && hinted !== 'cash' && !/残高|ポイント|番号/.test(compact) && amount.value > 0) result.payments.push(amount.value);
      summary = true;
    } else if (!summary) {
      let itemName = !name || onlyQuantity(name) ? pending ?? '' : name;
      let count = waiting?.quantity ?? quantity(line);
      // 名前と数量がつながって読めることがあるので、金額が割り切れる1桁なら数量とみなす
      const column = countColumn ? itemName.match(/^(.*[^\d ])(?: +(\d{1,2})| ?([1-9]))$/) : null;
      const quantityText = column ? Number(column[2] ?? column[3]) : 0;
      if (column && (column[2] || amount.value % quantityText === 0)) { itemName = column[1]; count = quantityText; }
      if (itemName && amount.value > 0) {
        result.items.push({ name: itemName, quantity: count, unitPrice: waiting?.unit ?? null, amount: amount.value, discount: 0, isReducedRate: line.includes('※') || line.includes('軽') });
      }
    }
    pending = null;
    waiting = null;
  });
  removeTaxMarks(result.items);
  const best = Math.max(0, ...totals.map((t) => t.priority));
  result.total = totals.filter((t) => t.priority === best).at(-1)?.value ?? null;
  if (result.total != null) result.totalSource = 'label';
  // 合計の行がない・商品と合わないとき：お預り−お釣りやカードの支払額が、商品の合計と一致する場合だけ使う
  if (result.items.length) {
    const goods = result.items.reduce((s, i) => s + i.amount - i.discount, 0) - result.discount;
    const agrees = (v) => v === goods || v === goods + result.addedTax || v === goods + result.includedTax;
    if (result.total == null || !agrees(result.total)) {
      const proven = [...new Set([cashPaid(result), ...result.payments].filter((v) => v > 0 && agrees(v)))];
      if (proven.length === 1 && proven[0] !== result.total) Object.assign(result, { total: proven[0], totalSource: 'verified' });
    }
  }
  if (result.total != null) {
    const sum = result.items.reduce((s, i) => s + i.amount - i.discount, 0) - result.discount;
    const base = result.subtotal != null ? result.subtotal - result.discount : sum;
    if (result.addedTax > 0 && result.total === base) { result.includedTax += result.addedTax; result.addedTax = 0; }
    // 「消費税」とだけ書かれた外税：商品の合計に足すと支払合計になる
    else if (!result.addedTax && result.includedTax > 0 && result.items.length && result.total === sum + result.includedTax) { result.addedTax = result.includedTax; result.includedTax = 0; }
  }
  if (has(lines.join(''), ['検針', 'ご使用量', '使用量', 'ご利用料金', '請求書', 'ご請求']) && result.items.length <= 1) {
    result.kind = 'bill';
    result.items = [];
  }
  return result;
}

/** お預り−お釣り（両方読めたときだけ） */
export const cashPaid = (parsed) => (parsed.tendered != null && parsed.change != null && parsed.tendered > parsed.change ? parsed.tendered - parsed.change : null);

/**
 * 支払った合計を、お預り・お釣り・カード等の支払額・小計・消費税と照らし合わせる。
 * 読み取れた値だけを比べる。ok が false のものは、利用者が原本を見て確かめる。
 */
export function totalChecks(parsed, total) {
  const found = [];
  if (!(total > 0)) return found;
  const add = (ok, text) => found.push({ ok, text });
  const others = parsed.payments ?? [];
  const otherSum = others.reduce((a, b) => a + b, 0);
  const cash = cashPaid(parsed);
  if (cash != null) {
    const ok = cash === total || (others.length > 0 && cash + otherSum === total);
    add(ok, ok ? `お預り ${yen(parsed.tendered)} − お釣り ${yen(parsed.change)} が合計と合います。`
      : `お預り ${yen(parsed.tendered)} − お釣り ${yen(parsed.change)} ＝ ${yen(cash)} で、合計 ${yen(total)} と合いません。`);
  } else if (parsed.tendered != null && !others.length && parsed.tendered < total) add(false, `お預り ${yen(parsed.tendered)} が、合計 ${yen(total)} より少なくなっています。`);
  if (others.length && cash == null) {
    if (others.includes(total) || otherSum === total) add(true, 'カード・電子マネー等の支払額が合計と合います。');
    else if (others.every((v) => v > total)) add(false, `支払額 ${yen(others[0])} が、合計 ${yen(total)} と合いません。`);
  }
  if (parsed.subtotal != null) {
    const discounts = parsed.discount + parsed.items.reduce((s, i) => s + i.discount, 0);
    const ok = [0, parsed.discount, discounts].some((d) => [0, parsed.addedTax, parsed.includedTax].some((tax) => parsed.subtotal - d + tax === total));
    add(ok, ok ? '小計と消費税が合計と合います。' : `小計 ${yen(parsed.subtotal)}${parsed.addedTax ? `＋外税 ${yen(parsed.addedTax)}` : ''} が、合計 ${yen(total)} と合いません。`);
  }
  if (parsed.includedTax > Math.floor(total / 11) + 2) add(false, `内税 ${yen(parsed.includedTax)} が、合計 ${yen(total)} に対して大きすぎます。`);
  return found;
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
