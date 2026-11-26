// 日付は "yyyy-MM-dd"、年月は "yyyy-MM" の文字列（Swift版の保存形式と同じ）。時刻やタイムゾーンを持たない。
const pad = (n, w = 2) => String(n).padStart(w, '0');
export const lastDay = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
export const makeDay = (y, m, d) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
export const parts = (text) => text.split('-').map(Number);
export function isDay(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [y, m, d] = parts(text);
  return m >= 1 && m <= 12 && d >= 1 && d <= lastDay(y, m);
}
export function today(now = new Date()) { return makeDay(now.getFullYear(), now.getMonth() + 1, now.getDate()); }
const utc = (text) => { const [y, m, d] = parts(text); return Date.UTC(y, m - 1, d); };
export function addDays(text, n) {
  const t = new Date(utc(text) + n * 86400000);
  return makeDay(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
export const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / 86400000);
export const weekday = (text) => new Date(utc(text)).getUTCDay(); // 0 = 日曜
export const weekdayName = (text) => '日月火水木金土'[weekday(text)];

export const monthOf = (day) => day.slice(0, 7);
export const makeMonth = (y, m) => `${pad(y, 4)}-${pad(m)}`;
export function addMonths(month, n) {
  const [y, m] = parts(month);
  const index = y * 12 + (m - 1) + n;
  return makeMonth(Math.floor(index / 12), (((index % 12) + 12) % 12) + 1);
}
/** その月の指定日。月に無い日（31日や「月末」の32）は月末。 */
export function monthDay(month, day) {
  const [y, m] = parts(month);
  return makeDay(y, m, Math.min(Math.max(day, 1), lastDay(y, m)));
}
export const monthRange = (month) => ({ start: monthDay(month, 1), end: monthDay(month, 31) });
export const inRange = (day, range) => day >= range.start && day <= range.end;
export const monthTitle = (month) => { const [y, m] = parts(month); return `${y}年${m}月`; };
export const shortRange = (r) => `${parts(r.start)[1]}/${parts(r.start)[2]}〜${parts(r.end)[1]}/${parts(r.end)[2]}`;
