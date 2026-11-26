// 予定を、カレンダーアプリに取り込める形式（iCalendar）にする。通知はカレンダーアプリが行う。
import { addDays } from './date.js';
import { TYPES } from './calendar.js';
import { yen } from './money.js';

const escape = (text) => String(text).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const compact = (day) => day.replace(/-/g, '');
const bytes = (c) => { const n = c.codePointAt(0); return n < 0x80 ? 1 : n < 0x800 ? 2 : n < 0x10000 ? 3 : 4; };

/** 1行は75バイトまで。日本語の文字の途中では区切らない。 */
export function fold(line) {
  const parts = [''];
  let size = 0;
  for (const c of line) {
    const limit = parts.length === 1 ? 75 : 74;
    if (size + bytes(c) > limit) { parts.push(''); size = 0; }
    parts[parts.length - 1] += c;
    size += bytes(c);
  }
  return parts.join('\r\n ');
}

/** daysBefore 日前の朝9時に知らせる（0は当日の朝9時） */
const trigger = (daysBefore) => (daysBefore === 0 ? 'PT9H' : daysBefore === 1 ? '-PT15H' : `-P${daysBefore - 1}DT15H`);

export function toICS(list, { amounts = false, daysBefore = 1, now = Date.now() } = {}) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//zairyaku//schedule//JA', 'CALSCALE:GREGORIAN'];
  for (const e of list.filter((x) => x.state === 'planned' || (x.state === 'info'))) {
    const summary = `${e.title}（${TYPES[e.type]}）${amounts && e.amount != null ? ` ${yen(e.amount)}` : ''}`;
    const id = `${e.type}-${e.ref?.recurringID ?? e.ref?.cardID ?? e.ref?.occurrence?.sourceID}-${compact(e.day)}${e.state === 'info' ? `-${[...e.title].reduce((n, c) => (n * 31 + c.codePointAt(0)) % 1000000, 7)}` : ''}`;
    lines.push('BEGIN:VEVENT', `UID:${id}@zairyaku.invalid`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${compact(e.day)}`, `DTEND;VALUE=DATE:${compact(addDays(e.day, 1))}`,
      `SUMMARY:${escape(summary)}`, 'TRANSP:TRANSPARENT', 'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escape(summary)}`, `TRIGGER:${trigger(daysBefore)}`, 'END:VALARM', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
