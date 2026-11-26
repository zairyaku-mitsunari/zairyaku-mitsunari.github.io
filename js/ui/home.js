// ホーム画面（正式な参考画像のデザイン。数値の位置は参考画像の座標で、Swift版の HomeMenu と同じ）
// area は題字を切り出した範囲（make_design.swift と同じ）。drop は金の縁に文字が触れないように下げる量。
import { h, button } from './dom.js';
import { icon } from './icons.js';
import * as L from '../core/ledger.js';
import * as F from '../core/finance.js';
import { yen, signed } from '../core/money.js';
import { today, parts, weekdayName, monthTitle, shortRange } from '../core/date.js';

export const MENUS = [
  { id: 'council', title: '財務軍議', sub: '三成と相談（家計・資産・事業）', top: 794, h: 112, right: 588, area: [224, 794, 256, 72], drop: 5, ready: true },
  { id: 'input', title: '収支入力', sub: '収入・支出の登録（簡単入力）', top: 927, h: 110, right: 588, area: [232, 929, 246, 66], drop: 3, ready: true },
  { id: 'card', title: 'カード管理', sub: '利用明細・引落し・支払予定', top: 1057, h: 108, right: 588, area: [232, 1058, 290, 65], drop: 3, ready: true },
  { id: 'fixed', title: '固定費・保険', sub: '保険・サブスク・各種固定費の確認', top: 1185, h: 106, right: 624, area: [230, 1185, 308, 65], drop: 5, ready: true },
  { id: 'analysis', title: '収支分析', sub: '支出の内訳・推移', top: 1311, h: 112, right: 588, area: [226, 1312, 253, 69], drop: 3, ready: true },
  { id: 'goal', title: '予算・貯蓄目標', sub: '予算管理・貯蓄計画・目標の達成管理', top: 1445, h: 116, right: 636, area: [224, 1448, 356, 66], drop: 1, ready: true },
];

const percent = (value, whole) => `${(value / whole) * 100}%`;
const art = (name, style, className) => h('img', { src: `assets/${name}.png`, alt: '', className, style, draggable: false });

function menuButton(menu, open) {
  const box = (x, y, w, height) => ({ left: percent(x - 18, 816), top: percent(y - menu.top, menu.h), width: percent(w, 816), height: percent(height, menu.h) });
  const [x, y, w, height] = menu.area;
  return h('button', { type: 'button', className: 'menu', style: { aspectRatio: `816 / ${menu.h}` }, onclick: () => open(menu.id), 'aria-label': menu.title },
    art(`home_${menu.id}_left`, box(34, menu.top, 174, menu.h), 'art-left'),
    art(`home_${menu.id}_right`, box(menu.right, menu.top, 778 - menu.right, menu.h), 'art-right'),
    art(`home_${menu.id}_title`, box(x, y + menu.drop, w, height), 'art-title'),
    h('span', { className: 'menu-sub' }, menu.sub, menu.ready ? null : h('span', { className: 'badge' }, '準備中')),
    h('span', { className: 'chevron', 'aria-hidden': 'true' }, '›'));
}

export function homeView(app) {
  const { data } = app.store;
  const range = F.periodRange(app.month, data);
  const sum = L.summary(data, range, app.scope);
  const business = app.scope === 'business';
  const now = today();
  const assets = F.totalAssets(data, now);
  const next = F.nextWithdrawal(data, now);
  const calendar = F.effectiveBasis(data) === 'calendar';
  const current = app.month === F.monthContaining(now, data);
  const withdrawal = next ? `${parts(next.day)[1]}月${parts(next.day)[2]}日（${weekdayName(next.day)}）${yen(next.amount)}`
    : data.cards.some(F.isConfigured) ? '予定なし' : '締め日を設定';
  const figure = (title, value, className) => h('div', { className: `figure ${className}` }, h('span', {}, title), h('strong', {}, value));

  return h('div', { className: 'home' },
    h('header', { className: 'hero' },
      h('img', { src: 'assets/home_hero.png', alt: '石田三成　財略三成　財務軍略　旗印 大一大万大吉' }),
      h('span', { className: 'version' }, `試験版 Web ${app.version}`)),
    h('div', { className: 'home-side' },
      h('p', { className: 'slogan' }, h('img', { src: 'assets/home_crest.png', alt: '' }), h('span', {}, '家計・資産・事業を治め、盤石の財を築く。'), h('img', { src: 'assets/home_crest.png', alt: '' })),
      h('section', { className: 'summary', 'aria-label': '今月の収支' },
        h('div', { className: 'summary-head' },
          h('div', { className: 'period' },
            button('‹', () => app.shiftMonth(-1), 'step', { 'aria-label': '前の月' }),
            h('strong', {}, current ? '今月の収支' : '収支'),
            h('span', {}, calendar ? `（${monthTitle(app.month)}）` : `（${shortRange(range)}）`),
            button('›', () => app.shiftMonth(1), 'step', { 'aria-label': '次の月' })),
          app.scopeSelect(),
          button('詳細 ›', () => app.go('history'), 'link')),
        h('div', { className: 'figures' },
          figure(business ? '売上' : '収入', yen(sum.income), 'income'),
          figure(business ? '経費' : '支出', yen(sum.expense), 'expense'),
          figure(business ? '利益' : '収支', sum.net > 0 ? signed(sum.net) : yen(sum.net), 'net')),
        h('div', { className: 'wealth' },
          h('button', { type: 'button', className: 'wealth-item', onclick: () => app.go('assets', 'accounts') },
            h('img', { src: 'assets/home_coins.png', alt: '' }),
            h('span', {}, h('span', { className: 'small' }, '総資産'), h('strong', { className: 'income' }, assets.amount == null ? '未入力' : yen(assets.amount)),
              assets.amount != null && assets.unknown ? h('span', { className: 'tiny' }, `未入力${assets.unknown}口座を除く`) : null)),
          h('button', { type: 'button', className: 'wealth-item', onclick: () => app.go('assets', 'cards') },
            icon('calendar'),
            h('span', {}, h('span', { className: 'small' }, next?.isEstimate ? '次回引落し（予定）' : '次回引落し'), h('strong', {}, withdrawal)))))),
    h('nav', { className: 'menus', 'aria-label': 'メニュー' }, MENUS.map((menu) => menuButton(menu, (id) => app.openMenu(id)))));
}
