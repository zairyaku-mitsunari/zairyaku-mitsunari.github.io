// 自動同期の画面と、同期するきっかけ。接続先（app.syncSend）がないときは何もしない。
import { h, button, sheet, panel, row, note, confirmSheet } from './dom.js';
import { checkField } from './form.js';
import { SyncEngine } from '../core/sync/engine.js';
import { makeKey, formatKey, parseKey } from '../core/sync/crypto.js';
import { categoryName, kindTitle, live } from '../core/ledger.js';
import { yen } from '../core/money.js';

let engine = null;
let timer = null;
let lastStart = 0;
const dayCount = { day: '', n: 0 };
export const DELAY = { afterChange: 5000, minimum: 20000, dailyLimit: 300 };

const saver = (app) => (session) => app.store.persistence.setLocal('sync', session);
const make = (app, session) => new SyncEngine({ store: app.store, send: app.syncSend, session, saveSession: saver(app) });
export const syncEngine = () => engine;

/** バックアップで置き換えた後に呼ぶ */
export async function afterReplace(app) {
  if (!engine) return;
  await engine.reset();
  schedule(app, DELAY.afterChange);
}

/** 起動時に呼ぶ */
export async function startSync(app) {
  engine = null;
  if (!app.syncSend) return;
  const session = await app.store.persistence.local('sync');
  if (session) engine = make(app, session);
  app.store.onChange = () => schedule(app, DELAY.afterChange);
  if (!app.syncWatching) {
    app.syncWatching = true;
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(app, 500); });
    window.addEventListener('online', () => schedule(app, 500));
  }
  schedule(app, 500);
}

function schedule(app, delay) {
  if (!engine) return;
  clearTimeout(timer);
  timer = setTimeout(() => syncNow(app, { automatic: true }), Math.max(delay, DELAY.minimum - (Date.now() - lastStart)));
}

export async function syncNow(app, { automatic = false, allowShrink = false } = {}) {
  if (!engine) return null;
  const day = new Date().toDateString();
  if (dayCount.day !== day) Object.assign(dayCount, { day, n: 0 });
  if (automatic && dayCount.n >= DELAY.dailyLimit) return null;
  dayCount.n += 1;
  lastStart = Date.now();
  const before = app.store.data;
  const result = await engine.sync({ allowShrink });
  // 取り込みで内容が変わったら、入力中でなければ画面を描き直す
  if (app.store.data !== before && !document.querySelector('dialog.sheet')) app.render();
  else if (app.route === 'settings' && !document.querySelector('dialog.sheet')) app.render();
  return result;
}

const when = (time) => new Date(time).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function syncPanel(app) {
  if (!app.syncSend) {
    return panel('自動同期（iPhoneとMac）', row('状態', '準備中（接続していません）'),
      note('暗号化と同期の仕組みは作成し、このMacの中の模擬の置き場で確認しました。置き場（Cloudflare）の準備は、承認をいただいてから行います。今は、バックアップの書き出しと「合わせる」で移してください。'));
  }
  if (!engine) {
    return panel('自動同期（iPhoneとMac）', row('状態', '未設定'),
      note('記録と原本は、この端末で暗号化してから置き場に送ります。置き場では中身を読めません。', 'message'),
      h('div', { className: 'actions start' },
        button('この端末で始める', () => setupSheet(app), 'gold', { id: 'sync-start' }),
        button('同期キーで参加する', () => joinSheet(app), 'outline', { id: 'sync-join' })));
  }
  const s = engine.session;
  const reviews = engine.reviews();
  const state = s.lastError ? (s.lastError.code === 'held' ? '確認待ち（取り込みを止めています）' : '最後の同期は失敗しました') : s.lastSyncAt ? '最後の同期は成功しました' : 'まだ成功していません';
  return panel('自動同期（iPhoneとMac）',
    row('状態', state), row('最後に成功した日時', s.lastSyncAt ? when(s.lastSyncAt) : 'まだありません'),
    s.lastError ? note(s.lastError.message, 'note warn') : null,
    h('div', { className: 'actions start' },
      button('今すぐ同期', async () => { await syncNow(app); app.render(); }, 'gold', { id: 'sync-now' }),
      s.lastError?.code === 'held' ? button('内容を確認して取り込む', async () => {
        if (!(await confirmSheet('大きく減った内容を取り込みますか？', '取り込む前の状態は控えに残ります。心当たりがない場合は取り込まず、「過去の版に戻す」を使ってください。', '取り込む'))) return;
        await syncNow(app, { allowShrink: true }); app.render();
      }, 'danger', { id: 'sync-allow' }) : null,
      reviews.length ? button(`確認待ち ${reviews.length}件`, () => reviewSheet(app), 'outline', { id: 'sync-reviews' }) : null,
      s.conflicts.length ? button(`競合の控え ${s.conflicts.length}件`, () => conflictSheet(app), 'outline', { id: 'sync-conflicts' }) : null,
      button('過去の版に戻す', () => historySheet(app), 'outline', { id: 'sync-history' }),
      button('置き場を消して始め直す', () => destroySheet(app), 'outline', { id: 'sync-destroy' }),
      button('この端末の同期をやめる', async () => {
        if (!(await confirmSheet('この端末の同期をやめますか？', 'この端末の記録は残ります。置き場の内容も消えません。もう一度使うには同期キーが必要です。', 'やめる'))) return;
        await app.store.persistence.setLocal('sync', null); engine = null; app.render();
      }, 'outline', { id: 'sync-stop' })),
    note('同期は、アプリを開いたとき・画面に戻ったとき・記録を変えた少し後に行います。アプリを閉じている間は行いません。'));
}

const passField = (label, type = 'text') => h('input', { type, autocomplete: 'off', autocapitalize: 'off', spellcheck: false, 'aria-label': label });
const field = (label, control) => h('label', { className: 'field' }, h('span', {}, label), control);

async function connect(app, raw, setupCode) {
  const session = await SyncEngine.create(raw);
  const next = make(app, session);
  if (setupCode != null) await next.register(setupCode);
  else await next.state(); // 参加：鍵が合っているかを先に確かめる
  await next.save({});
  engine = next;
  app.store.onChange = () => schedule(app, DELAY.afterChange);
  return syncNow(app);
}

/** 同期キーをなくした・漏れたときに、置き場を消して新しいキーで始め直す */
function destroySheet(app) {
  sheet('置き場を消して始め直す', (close) => {
    const code = passField('管理用の番号', 'password');
    const sure = checkField('置き場の内容と過去の版がすべて消えることを確認しました', false);
    const failure = h('p', { className: 'error', role: 'alert' });
    const go = button('置き場を消す', async () => {
      failure.textContent = '';
      go.disabled = true;
      try {
        await engine.destroy(code.value);
        clearTimeout(timer);
        await app.store.persistence.setLocal('sync', null);
        engine = null;
        close();
        app.toast('置き場を消しました。この端末の記録は残っています。「この端末で始める」で新しい同期キーを作れます。');
      } catch (error) { failure.textContent = error.message; go.disabled = false; }
    }, 'danger', { id: 'sync-destroy-run', disabled: true });
    sure.input.addEventListener('change', () => { go.disabled = !sure.input.checked; });
    return h('div', {}, note('同期キーをなくしたときや、ほかの人に知られたおそれがあるときに使います。消した内容は元に戻せません。', 'note warn'),
      note('この端末の記録は変わりません。先にバックアップを書き出し、もう1台の記録もこの端末に取り込まれていることを確かめてください。もう1台は、新しい同期キーで参加し直します。'),
      field('管理用の番号', code), sure.element, failure, h('div', { className: 'actions' }, button('やめる', close), go));
  }, { head: 'sync' });
}

function setupSheet(app) {
  sheet('同期を始める', (close) => {
    const body = h('div', {});
    const code = passField('管理用の番号', 'password');
    const failure = h('p', { className: 'error', role: 'alert' });
    const next = button('同期キーを作る', async () => {
      failure.textContent = '';
      if (code.value.length < 12) { failure.textContent = '置き場を用意したときに決めた、12文字以上の番号を入力してください。'; return; }
      const raw = makeKey();
      const formatted = await formatKey(raw);
      const kept = checkField('同期キーを、この端末とは別の場所に控えました', false);
      const start = button('始める', async () => {
        start.disabled = true;
        try { await connect(app, raw, code.value); close(); app.render(); } catch (error) { failure.textContent = error.message; start.disabled = false; }
      }, 'gold', { id: 'sync-register', disabled: true });
      kept.input.addEventListener('change', () => { start.disabled = !kept.input.checked; });
      body.replaceChildren(note('もう1台を参加させるときと、端末を買い替えたときに必要です。この画面を閉じると、二度と表示できません。すべての端末と控えをなくすと、置き場の内容は復元できません。', 'message'),
        h('p', { className: 'recovery small', id: 'sync-key' }, formatted), kept.element, failure, h('div', { className: 'actions' }, button('やめる', close), start));
    }, 'gold', { id: 'sync-make' });
    body.append(field('管理用の番号（置き場の用意で決めたもの）', code), failure, h('div', { className: 'actions' }, button('キャンセル', close), next));
    return body;
  }, { head: 'sync' });
}

function joinSheet(app) {
  sheet('同期キーで参加する', (close) => {
    const key = h('textarea', { rows: 3, 'aria-label': '同期キー', autocapitalize: 'characters', spellcheck: false });
    const failure = h('p', { className: 'error', role: 'alert' });
    const join = button('参加する', async () => {
      join.disabled = true;
      failure.textContent = '';
      try { await connect(app, await parseKey(key.value), null); close(); app.render(); } catch (error) { failure.textContent = error.message; join.disabled = false; }
    }, 'gold', { id: 'sync-join-run' });
    return h('div', {}, note('この端末の記録は消えません。置き場の内容と合わせます。合わせる前の状態は控えに残ります。', 'message'), field('同期キー', key), failure,
      h('div', { className: 'actions' }, button('キャンセル', close), join));
  }, { head: 'sync' });
}

function reviewSheet(app) {
  sheet('確認待ち', (close) => {
    const body = h('div', { className: 'stack' });
    const draw = () => {
      const items = engine.reviews();
      body.replaceChildren(...(items.length ? items.map((item) => panel(item.title, item.detail.map((d) => h('p', { className: 'message' }, d)),
        h('div', { className: 'actions start' },
          item.type === 'duplicate' ? item.ids.map((id, i) => button(`${i + 1}つ目の記録を削除`, async () => {
            if (!(await confirmSheet('この記録を削除しますか？', item.detail[i], '削除する'))) return;
            await app.perform(() => app.store.deleteTransaction(id)); draw();
          }, 'outline small')) : null,
          button('このままにする', async () => { await engine.dismiss(item.key); draw(); }, 'outline small'))))
        : [note('確認することはありません。', 'message')]));
    };
    draw();
    return h('div', {}, body, h('div', { className: 'actions' }, button('閉じる', () => { close(); app.render(); }, 'gold')));
  }, { className: 'full', head: 'sync' });
}

const NAMES = { transactions: '取引', categories: '項目', accounts: '口座', cards: 'カード', statements: '請求', recurringCosts: '固定費などの予定', recurringPayments: '支払いの記録',
  incomeSources: '勤務先', incomeReceipts: '入金の記録', receipts: 'レシート', itemRules: '分類の学習', budgets: '予算', goals: '目標', goalDeposits: '積み立て', improvements: '見直しの判断', councils: '軍議', consultations: '相談', settings: '設定' };

function summaryOf(app, list, value) {
  if (list === 'settings') return '集計期間などの設定';
  const parts = [value.deletedAt != null ? '削除' : null, value.day, value.kind && kindTitle[value.kind], value.amount != null ? yen(value.amount) : null,
    value.targetAmount != null ? yen(value.targetAmount) : null, value.plannedAmount != null ? yen(value.plannedAmount) : null, value.name ?? value.storeName, value.memo,
    value.categoryID ? categoryName(app.store.data, value.categoryID) : null];
  return parts.filter(Boolean).join('　') || '（内容の概要はありません）';
}

function conflictSheet(app) {
  sheet('競合の控え', (close) => {
    const body = h('div', { className: 'stack' });
    const draw = () => {
      const list = engine.session.conflicts;
      body.replaceChildren(...(list.length ? list.map((c, i) => panel(`${NAMES[c.list] ?? c.list}を両方の端末で変更`,
        row('採用した内容', summaryOf(app, c.list, c.kept)), row('採用しなかった内容', summaryOf(app, c.list, c.discarded)), note(`${when(c.at)} に合わせました。`),
        h('div', { className: 'actions start' },
          button('採用しなかった内容に戻す', async () => { await app.perform(() => engine.restoreConflict(i)); draw(); }, 'outline small'),
          button('確認した', async () => { await engine.resolveConflict(i); draw(); }, 'outline small')))).reverse()
        : [note('控えはありません。', 'message')]));
    };
    draw();
    return h('div', {}, note('同じ内容を両方の端末で変えた場合、更新が新しい方を採用します。', 'message'), body,
      h('div', { className: 'actions' }, button('閉じる', () => { close(); schedule(app, 500); app.render(); }, 'gold')));
  }, { className: 'full', head: 'sync' });
}

function historySheet(app) {
  sheet('過去の版に戻す', (close) => {
    const body = h('div', { className: 'stack' }, note('置き場の一覧を読み込んでいます…', 'message'));
    (async () => {
      try {
        const state = await engine.state();
        const list = [...state.history].reverse();
        body.replaceChildren(note('置き場に残っている直近の版です。戻すと、いまの状態は控えに残り、戻した内容がほかの端末にも伝わります。', 'message'),
          ...list.map((v) => h('div', { className: 'due' }, h('span', {}, `版${v.version}`, h('small', {}, when(v.at))),
            button('中身を確かめて戻す', async () => {
              try {
                const snapshot = await engine.download(v.version);
                const text = `版${v.version}（${when(v.at)}）\n取引${live(snapshot.transactions).length}件（今は${live(app.store.data.transactions).length}件）\nこの版にない記録は「削除」になります（控えから戻せます）。`;
                if (!(await confirmSheet('この版に戻しますか？', text, 'この版に戻す'))) return;
                const changed = await engine.restoreVersion(v.version);
                close(); app.toast(`版${v.version}の内容に戻しました（${changed}件を変更）。`); await syncNow(app); app.render();
              } catch (error) { app.fail(error.message); }
            }, 'outline small', { 'aria-label': `版${v.version}に戻す` }))));
        if (!list.length) body.replaceChildren(note('置き場にまだ版がありません。', 'message'));
      } catch (error) { body.replaceChildren(note(error.message, 'note warn')); }
    })();
    return h('div', {}, body, h('div', { className: 'actions' }, button('閉じる', close, 'gold')));
  }, { className: 'full', head: 'sync' });
}
