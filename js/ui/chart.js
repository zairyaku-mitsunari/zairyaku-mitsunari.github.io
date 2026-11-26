// グラフ（折れ線・円）。色は背景に合わせて見分けやすさを検査した組み合わせ。数値の表も必ず付ける。
import { h } from './dom.js';
import { yen } from '../core/money.js';

const NS = 'http://www.w3.org/2000/svg';
export const COLORS = { blue: '#2e9fd0', gold: '#c98500' };
const OTHER = '#7d8a94';
// 円グラフの色の順番（隣り合う色が見分けられる組み合わせを、件数ごとに選ぶ）
const SLICES = { 1: ['#2e9fd0'], 2: ['#2e9fd0', '#c98500'], 3: ['#2e9fd0', '#c98500', '#d55181'], 4: ['#2e9fd0', '#c98500', '#d55181', '#008300'], 5: ['#2e9fd0', '#c98500', '#9085e9', '#008300', '#d55181'] };

function s(tag, attributes = {}, ...children) {
  const element = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  element.append(...children.filter(Boolean));
  return element;
}

/** 目盛り（きりのよい数） */
export function ticks(min, max, count = 4) {
  if (min === max) { max += 1000; min = Math.min(0, min); }
  const raw = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((v) => v >= raw);
  const out = [];
  for (let v = Math.floor(min / step) * step; v < max + step; v += step) { out.push(Math.round(v)); if (v >= max) break; }
  return out;
}
export const short = (v) => {
  const a = Math.abs(v), sign = v < 0 ? '-' : '';
  if (a >= 100_000_000) return `${sign}${+(a / 100_000_000).toFixed(1)}億`;
  if (a >= 10_000) return `${sign}${+(a / 10_000).toFixed(1)}万`;
  return `${sign}${a.toLocaleString('en-US')}`;
};

const legend = (series) => h('div', { className: 'legend' }, series.map((x) => h('span', {}, h('i', { style: { background: x.color } }), x.name)));
const table = (head, rows) => h('details', {}, h('summary', {}, '数値の表を見る'),
  h('div', { className: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, head.map((t) => h('th', {}, t)))), h('tbody', {}, rows.map((r) => h('tr', {}, r.map((t) => h('td', {}, t))))))));

/**
 * 折れ線グラフ。labels：横軸の名前。series：[{ name, color, values（null は点を打たない） }]
 * なぞる（触れる）と、その位置の値を下に表示する。
 */
export function lineChart({ title, labels, series, zero = false }) {
  const width = 340, height = 190, left = 46, right = 8, top = 8, bottom = 22;
  const values = series.flatMap((x) => x.values).filter((v) => v != null);
  if (!values.length) return h('div', { className: 'chart' }, h('p', { className: 'note' }, 'グラフにできる記録がまだありません。'));
  const marks = ticks(Math.min(...values, zero ? 0 : Infinity), Math.max(...values, zero ? 0 : -Infinity));
  const low = marks[0], high = marks.at(-1);
  const x = (i) => left + (labels.length === 1 ? (width - left - right) / 2 : (i * (width - left - right)) / (labels.length - 1));
  const y = (v) => top + ((high - v) * (height - top - bottom)) / (high - low || 1);
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${title}。数値は下の表で確認できます。` });
  for (const t of marks) {
    svg.append(s('line', { x1: left, x2: width - right, y1: y(t), y2: y(t), class: t === 0 ? 'axis' : 'grid' }), s('text', { x: left - 5, y: y(t) + 3, 'text-anchor': 'end', class: 'tick' }, document.createTextNode(short(t))));
  }
  const every = Math.max(1, Math.ceil(labels.length / 6));
  labels.forEach((label, i) => {
    if ((labels.length - 1 - i) % every === 0) svg.append(s('text', { x: x(i), y: height - 6, 'text-anchor': i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle', class: 'tick' }, document.createTextNode(label)));
  });
  const cursor = s('line', { y1: top, y2: height - bottom, class: 'cursor', x1: -10, x2: -10 });
  svg.append(cursor);
  for (const line of series) {
    let path = '', pen = false;
    line.values.forEach((v, i) => { if (v == null) { pen = false; return; } path += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`; pen = true; });
    svg.append(s('path', { d: path, fill: 'none', stroke: line.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', class: 'series' }));
    const few = line.values.length <= 14;
    line.values.forEach((v, i) => { if (v != null && (few || i === line.values.length - 1)) svg.append(s('circle', { cx: x(i), cy: y(v), r: few ? 4 : 4.5, fill: line.color, class: 'dot' })); });
  }
  const reading = h('p', { className: 'reading', role: 'status' });
  const show = (i) => {
    cursor.setAttribute('x1', x(i)); cursor.setAttribute('x2', x(i));
    reading.textContent = `${labels[i]}　${series.map((l) => `${l.name} ${l.values[i] == null ? '—' : yen(l.values[i])}`).join('　')}`;
  };
  const point = (event) => {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * width;
    show(Math.max(0, Math.min(labels.length - 1, Math.round(((px - left) / (width - left - right)) * (labels.length - 1)))));
  };
  svg.addEventListener('pointermove', point);
  svg.addEventListener('pointerdown', point);
  show(labels.length - 1);
  return h('div', { className: 'chart' }, series.length > 1 ? legend(series) : null, svg, reading,
    table(['', ...series.map((l) => l.name)], labels.map((label, i) => [label, ...series.map((l) => (l.values[i] == null ? '—' : yen(l.values[i])))])));
}

/** 円グラフ（中抜き）。items：[{ name, amount }] 大きい順。6つ目以降は「その他」にまとめる。 */
export function donutChart({ title, items }) {
  const list = items.filter((x) => x.amount > 0);
  const total = list.reduce((a, x) => a + x.amount, 0);
  if (!total) return h('div', { className: 'chart' }, h('p', { className: 'note' }, 'グラフにできる記録がまだありません。'));
  const head = list.slice(0, 5);
  const rest = list.slice(5);
  const slices = [...head.map((x, i) => ({ ...x, color: SLICES[head.length][i] })), ...(rest.length ? [{ name: `その他（${rest.length}項目）`, amount: rest.reduce((a, x) => a + x.amount, 0), color: OTHER }] : [])];
  const share = (v) => `${(Math.round((v * 1000) / total) / 10).toFixed(1)}%`;
  const svg = s('svg', { viewBox: '0 0 200 200', role: 'img', 'aria-label': `${title}の割合。${slices.map((x) => `${x.name} ${share(x.amount)}`).join('、')}` });
  const reading = h('p', { className: 'reading', role: 'status' });
  let angle = -Math.PI / 2;
  const at = (a, r) => `${(100 + r * Math.cos(a)).toFixed(2)} ${(100 + r * Math.sin(a)).toFixed(2)}`;
  for (const slice of slices) {
    const next = angle + (slice.amount / total) * Math.PI * 2;
    const large = next - angle > Math.PI ? 1 : 0;
    const shape = slices.length === 1 ? s('circle', { cx: 100, cy: 100, r: 72, fill: 'none', stroke: slice.color, 'stroke-width': 36, class: 'slice' })
      : s('path', { d: `M${at(angle, 90)}A90 90 0 ${large} 1 ${at(next, 90)}L${at(next, 54)}A54 54 0 ${large} 0 ${at(angle, 54)}Z`, fill: slice.color, class: 'slice' });
    const show = () => { reading.textContent = `${slice.name}　${yen(slice.amount)}（${share(slice.amount)}）`; };
    shape.addEventListener('pointerenter', show);
    shape.addEventListener('pointerdown', show);
    svg.append(shape);
    angle = next;
  }
  svg.append(s('text', { x: 100, y: 96, 'text-anchor': 'middle', class: 'center-label' }, document.createTextNode('合計')),
    s('text', { x: 100, y: 116, 'text-anchor': 'middle', class: 'center-value' }, document.createTextNode(`¥${short(total)}`)));
  reading.textContent = `${slices[0].name}　${yen(slices[0].amount)}（${share(slices[0].amount)}）`;
  return h('div', { className: 'chart donut' }, svg, reading,
    h('ul', { className: 'legend-list' }, slices.map((x) => h('li', {}, h('i', { style: { background: x.color } }), h('span', {}, x.name), h('b', {}, `${yen(x.amount)}　${share(x.amount)}`)))),
    rest.length ? table(['その他の内訳', '金額', '割合'], rest.map((x) => [x.name, yen(x.amount), share(x.amount)])) : null);
}
