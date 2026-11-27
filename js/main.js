// Web版の起動と画面の切り替え
import { Store } from './core/store.js';
import { IndexedDBPersistence, MemoryPersistence } from './core/storage.js';
import { monthContaining } from './core/finance.js';
import { addMonths, today } from './core/date.js';
import { h, button, panel, note } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { homeView } from './ui/home.js';
import { openEditor } from './ui/editor.js';
import { historyView, settingsView } from './ui/screens.js';
import { analysisView } from './ui/analysis.js';
import { goalsView } from './ui/goals.js';
import { startLock } from './ui/lock.js';
import { startSync } from './ui/sync.js';
import { httpSend } from './core/sync/engine.js';
import { SYNC_ENDPOINT } from './config.js';
import { stop as stopSpeech } from './ui/voice.js';
import { stop as stopListening } from './ui/listen.js';
import { startNotify, currentAlerts, preferences } from './ui/notify.js';
import { assetsView } from './ui/assets.js';
import './core/finance-store.js';
import './core/category-store.js';
import { openImport } from './ui/import.js';
import { installNote } from './ui/device.js';
import { importBackup } from './ui/backup.js';

export const VERSION = '0.15.0';
const NAV = [['home', 'ホーム'], ['assets', '資産管理'], ['history', '取引履歴'], ['analysis', '分析・軍議'], ['settings', '設定']];

const local = ['localhost', '127.0.0.1'].includes(location.hostname);
const testing = local && new URLSearchParams(location.search).has('uitest');
const root = document.getElementById('app');

const app = {
  version: VERSION, route: 'home', assetTab: 'accounts', month: today().slice(0, 7), scope: 'all',
  analysisTab: 'report', councilKind: 'monthly', goalTab: 'budget', span: 'month', custom: { start: '', end: '' },
  calendarMonth: null, calendarDay: null, paymentSpan: 30, notifyPrefs: null, talking: false, keyword: '', deleted: null, message: '', store: null,
  go(route, tab) {
    stopSpeech();
    stopListening();
    this.talking = false;
    this.route = route;
    if (tab && route === 'assets') this.assetTab = tab;
    if (tab && route === 'analysis') this.analysisTab = tab;
    this.render();
    window.scrollTo(0, 0);
  },
  shiftMonth(n) { this.month = addMonths(this.month, n); this.render(); },
  setScope(scope) { this.scope = scope; localStorage.setItem('zairyaku-scope', scope); },
  scopeSelect() {
    const select = h('select', { className: 'scope', 'aria-label': '表示モード', onchange: () => { this.setScope(select.value); this.render(); } },
      [['all', '全体'], ['personal', '個人'], ['business', '事業']].map(([value, text]) => h('option', { value }, text)));
    select.value = this.scope;
    return select;
  },
  edit(entry) { openEditor(this, { entry }); },
  openMenu(id) {
    if (id === 'input') openEditor(this);
    else if (id === 'card') this.go('assets', 'cards');
    else if (id === 'fixed') this.go('assets', 'fixed');
    else if (id === 'analysis') this.go('analysis', 'report');
    else if (id === 'council') this.go('analysis', 'council');
    else this.go('goals');
  },
  fail(text) { this.message = text; this.render(); },
  toast(text) { this.message = text; this.render(); },
  /** 失敗したら理由を画面に出して undefined を返す */
  async perform(action) {
    try { return await action(); } catch (error) { this.fail(error.message); return undefined; }
  },
  render() {
    if (this.store.failure) {
      root.replaceChildren(panel('データを読み込めませんでした', note(this.store.failure, 'message'), note('データは変更していません。ブラウザのデータを消さずに、開発担当に相談してください。')));
      return;
    }
    const views = {
      home: () => homeView(this), assets: () => assetsView(this), history: () => historyView(this), analysis: () => analysisView(this), settings: () => settingsView(this),
      goals: () => goalsView(this),
    };
    const banner = this.message ? h('div', { className: 'toast', role: 'status' }, h('span', {}, this.message), button('閉じる', () => { this.message = ''; this.render(); })) : null;
    const undo = this.deleted ? h('div', { className: 'toast', id: 'undo' }, h('span', {}, '1件の記録を削除しました'),
      button('元に戻す', async () => { const id = this.deleted; this.deleted = null; await this.perform(() => this.store.restoreTransaction(id)); this.render(); }, 'gold', { id: 'undo-button' }),
      button('閉じる', () => { this.deleted = null; this.render(); })) : null;
    const tabs = h('nav', { className: 'bottombar', 'aria-label': '画面の切り替え' },
      NAV.map(([route, title]) => {
        // お知らせを使う設定のときだけ、資産管理に件数の印を出す
        const count = route === 'assets' && preferences(this).enabled ? currentAlerts(this).filter((a) => a.level <= 2).length : 0;
        return h('button', { type: 'button', className: this.route === route ? 'active' : '', 'data-route': route, onclick: () => this.go(count ? 'assets' : route, count ? 'payments' : undefined), 'aria-current': this.route === route ? 'page' : null, 'aria-label': count ? `${title}（お知らせ${count}件）` : null },
          icon(route), h('span', {}, title), count ? h('span', { className: 'count', 'aria-hidden': 'true' }, String(Math.min(99, count))) : null);
      }),
      button('レシート読取', () => openImport(this), 'outline side-only', { id: 'side-import' }),
      button('＋ 支出を登録', () => openEditor(this, { kind: 'expense' }), 'gold side-only'), button('＋ 収入を登録', () => openEditor(this, { kind: 'income' }), 'outline side-only'));
    const fab = this.route === 'history' || (this.route === 'analysis' && this.analysisTab === 'report') ? button('＋ 登録', () => openEditor(this), 'gold fab') : null;
    root.replaceChildren(tabs, h('main', { className: `route-${this.route}` }, (views[this.route] ?? views.home)()), ...[fab, h('div', { className: 'toasts' }, banner, undo)].filter(Boolean));
  },
};

async function start() {
  // 画面の撮影（テスト）は、端末に何も保存しない方式で行う
  const shooting = testing && new URLSearchParams(location.search).has('shot');
  const persistence = shooting ? new MemoryPersistence() : new IndexedDBPersistence(testing ? 'zairyaku-uitest' : 'zairyaku');
  if (testing && !shooting && !sessionStorage.getItem('uitest-phase')) {
    await new Promise((resolve) => { const r = indexedDB.deleteDatabase('zairyaku-uitest'); r.onsuccess = r.onerror = r.onblocked = resolve; });
  }
  const [defaults, classifier] = await Promise.all(['data/defaults.json', 'data/classifier.json'].map(async (url) => (await fetch(url)).json()));
  app.classifier = classifier;
  app.store = await new Store(persistence, defaults).load();
  app.scope = localStorage.getItem('zairyaku-scope') ?? 'all';
  app.syncSend = SYNC_ENDPOINT && !testing ? httpSend(SYNC_ENDPOINT) : null; // 未設定の間と、テスト中は、どこにも通信しない
  if (!app.store.failure) app.month = monthContaining(today(), app.store.data);
  if (testing) (await import('../tests/uitest.js')).watchFirstPaint();
  if (!app.store.failure) await startLock(app); // 設定があれば、先に画面を隠してから描く
  app.render();
  navigator.storage?.persist?.().catch(() => {});
  if (!app.store.failure && !testing) installNote(app); // ロック中は、ロック画面が前に出る
  if (!app.store.failure) { await startNotify(app); await startSync(app); if (app.notifyPrefs?.enabled) app.render(); }
  if (testing) (await import('../tests/uitest.js')).run(app, { importBackup });
  else if ('serviceWorker' in navigator) {
    const had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) app.toast('新しい版を受け取りました。アプリを開き直すと反映されます。'); });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

start().catch((error) => { root.textContent = `起動できませんでした：${error.message}`; });
