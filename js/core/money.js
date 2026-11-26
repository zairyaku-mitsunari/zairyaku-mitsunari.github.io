// 金額は円の整数。小数は受け付けない（推測で丸めない）。
export const MAXIMUM = 999999999999;

/** 成功 { value }、失敗 { error } */
export function parseAmount(input) {
  let text = String(input).replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/￥/g, '¥').replace(/　/g, ' ').trim();
  if (text.startsWith('¥') || text.startsWith('\\')) text = text.slice(1);
  if (text.endsWith('円')) text = text.slice(0, -1);
  text = text.trim();
  if (!text) return { error: 'empty' };
  if (text.startsWith('-')) return { error: '金額は1円以上で入力してください。' };
  const groups = text.split(',');
  if (groups.length > 1 && !(/^\d{1,3}$/.test(groups[0]) && groups.slice(1).every((g) => /^\d{3}$/.test(g)))) {
    return { error: '金額は整数の数字で入力してください。' };
  }
  const digits = groups.join('');
  if (!/^\d+$/.test(digits)) return { error: '金額は整数の数字で入力してください。' };
  const value = Number(digits);
  if (value > MAXIMUM) return { error: '金額が大きすぎます。' };
  if (value <= 0) return { error: '金額は1円以上で入力してください。' };
  return { value };
}

export const grouped = (v) => (v < 0 ? '-' : '') + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
export const yen = (v) => (v < 0 ? '-¥' : '¥') + grouped(Math.abs(v));
export const signed = (v) => (v === 0 ? '±¥0' : (v > 0 ? '+' : '') + yen(v));
