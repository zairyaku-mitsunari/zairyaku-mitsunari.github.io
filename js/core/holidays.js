// 日本の祝日（2020年以降の現行の法律による計算。Swift版と同じ。臨時の祝日や法改正は反映しない）
import { makeDay, addDays, weekday } from './date.js';

const cache = new Map();

export function holidays(year) {
  if (cache.has(year)) return cache.get(year);
  const national = new Map();
  const add = (m, d, name) => national.set(makeDay(year, m, d), name);
  const monday = (m, n) => 1 + ((8 - weekday(makeDay(year, m, 1))) % 7) + (n - 1) * 7;
  const years = year - 1980;
  const leaps = Math.trunc((year - 1980) / 4);
  add(1, 1, '元日'); add(1, monday(1, 2), '成人の日'); add(2, 11, '建国記念の日'); add(2, 23, '天皇誕生日');
  add(3, Math.trunc(20.8431 + 0.242194 * years - leaps), '春分の日');
  add(4, 29, '昭和の日'); add(5, 3, '憲法記念日'); add(5, 4, 'みどりの日'); add(5, 5, 'こどもの日');
  if (year === 2020) { add(7, 23, '海の日'); add(7, 24, 'スポーツの日'); add(8, 10, '山の日'); }
  else if (year === 2021) { add(7, 22, '海の日'); add(7, 23, 'スポーツの日'); add(8, 8, '山の日'); }
  else { add(7, monday(7, 3), '海の日'); add(8, 11, '山の日'); add(10, monday(10, 2), 'スポーツの日'); }
  add(9, monday(9, 3), '敬老の日');
  add(9, Math.trunc(23.2488 + 0.242194 * years - leaps), '秋分の日');
  add(11, 3, '文化の日'); add(11, 23, '勤労感謝の日');
  const result = new Map(national);
  for (const day of national.keys()) { // 国民の休日
    const middle = addDays(day, 1);
    if (!result.has(middle) && national.has(addDays(day, 2)) && weekday(middle) !== 0) result.set(middle, '国民の休日');
  }
  for (const day of [...national.keys()].sort()) { // 振替休日
    if (weekday(day) !== 0) continue;
    let next = addDays(day, 1);
    while (result.has(next)) next = addDays(next, 1);
    result.set(next, '振替休日');
  }
  cache.set(year, result);
  return result;
}

export const isBusinessDay = (day) =>
  weekday(day) !== 0 && weekday(day) !== 6 && !holidays(Number(day.slice(0, 4))).has(day);

export function shiftDay(day, shift) {
  if (shift === 'none') return day;
  let result = day;
  while (!isBusinessDay(result)) result = addDays(result, shift === 'previous' ? -1 : 1);
  return result;
}
