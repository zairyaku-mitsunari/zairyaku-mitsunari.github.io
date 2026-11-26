// 取引履歴・資産管理・分析・設定
import { h, button, panel, row, note, confirmSheet, screenHead } from './dom.js';
import { openImport } from './import.js';
import { openExport, importBackup, keptCopies } from './backup.js';
import { categoryManager } from './categories.js';
import { paydaySheet } from './payday.js';
import { lockPanel } from './lock.js';
import { syncPanel } from './sync.js';
import { notifyPanel } from './notify.js';
import { devicePanel } from './device.js';
import { csvSheet } from './export.js';
import { BASES } from '../core/payroll.js';
import * as L from '../core/ledger.js';
import * as F from '../core/finance.js';
import { yen } from '../core/money.js';
import { today, monthTitle, shortRange, weekdayName, parts } from '../core/date.js';

export function periodBar(app) {
  const { data } = app.store;
  const calendar = F.effectiveBasis(data) === 'calendar';
  return h('div', { className: 'panel periodbar' },
    button('‹', () => app.shiftMonth(-1), 'step', { 'aria-label': '前の月' }),
    h('strong', {}, calendar ? monthTitle(app.month) : `${monthTitle(app.month)}度（${shortRange(F.periodRange(app.month, data))}）`),
    button('›', () => app.shiftMonth(1), 'step', { 'aria-label': '次の月' }), app.scopeSelect());
}

export function entryRow(app, t, onClick = () => app.edit(t)) {
  const { data } = app.store;
  const sign = t.kind === 'expense' ? '-' : t.kind === 'income' || t.kind === 'refund' ? '+' : '';
  const detail = [t.storeName, t.accountID || t.cardID ? L.sourceName(data, t) : '', t.memo].filter(Boolean).join('・');
  return h('button', { type: 'button', className: 'entry', onclick: onClick },
    h('span', { className: 'date' }, `${parts(t.day)[1]}/${parts(t.day)[2]}`, h('small', {}, weekdayName(t.day))),
    h('span', { className: 'what' }, h('b', {}, L.entryTitle(data, t), t.kind === 'refund' ? '（返金）' : '', t.receiptID ? ' 📎' : ''), h('small', {}, detail)),
    h('span', { className: `money ${t.kind}` }, sign + yen(t.amount)));
}

export function historyView(app) {
  const list = h('div', { className: 'entries' });
  const totals = h('p', { className: 'totals' });
  const search = h('input', { type: 'search', placeholder: '検索（店舗名・項目・メモ・金額）', 'aria-label': '検索', value: app.keyword, oninput: () => { app.keyword = search.value; draw(); } });
  function draw() {
    const { data } = app.store;
    const found = L.search(data, L.inPeriod(data, F.periodRange(app.month, data), app.scope), app.keyword).sort(L.newestFirst);
    const sum = (kinds) => found.filter((t) => kinds.includes(t.kind)).reduce((s, t) => s + (t.kind === 'refund' ? -t.amount : t.amount), 0);
    totals.textContent = `${found.length}件　収入 ${yen(sum(['income']))}　支出 ${yen(sum(['expense', 'refund']))}`;
    list.replaceChildren(...(found.length ? found.map((t) => entryRow(app, t)) : [note('この条件の記録はありません。')]));
  }
  draw();
  return h('div', { className: 'screen' }, screenHead('history'), periodBar(app), search, totals, h('div', { className: 'panel' }, list));
}

export function settingsView(app) {
  const status = h('p', { className: 'note' }, '保存の状態を確認しています…');
  navigator.storage?.persisted?.().then((kept) => {
    status.textContent = kept ? 'この端末は、データを自動で消さない設定になっています。'
      : '端末の空き容量が不足すると、データが消される可能性があります。こまめにバックアップしてください。';
  });
  const picker = h('input', { type: 'file', accept: '.json,application/json', id: 'import-file', hidden: true,
    onchange: async () => { const file = picker.files[0]; picker.value = ''; if (file) await importBackup(app, await file.text()); } });
  const { data } = app.store;
  const last = localStorage.getItem('zairyaku-last-backup');
  const originals = data.receipts.reduce((n, r) => n + r.files.length, 0);
  const size = h('span', {}, '');
  app.store.persistence.fileSizes().then((list) => { size.textContent = `約${(list.reduce((s, f) => s + f.size, 0) / 1_000_000).toFixed(1)}MB`; }).catch(() => {});
  const unlinked = app.store.unlinkedReceipts();
  return h('div', { className: 'screen' },
    screenHead('settings'),
    panel('家計の設定',
      row('集計期間', BASES[F.effectiveBasis(data)]),
      h('div', { className: 'actions start' },
        button('給料日・締め日と集計期間', () => paydaySheet(app), 'outline', { id: 'open-payday' }),
        button('項目の管理', () => categoryManager(app), 'outline', { id: 'open-categories' }))),
    notifyPanel(app),
    lockPanel(app),
    devicePanel(app),
    screenHead('sync'),
    syncPanel(app),
    panel('バックアップと復元',
      note(app.syncSend ? '自動同期とは別に、バックアップもこまめに書き出してください。同期の置き場と端末の両方に何かあった場合に備えられます。'
        : '記録はこの端末のブラウザの中だけに保存し、外部には送りません。iPhoneとMacの自動同期はまだ接続していません。別の端末へ移すときは、書き出して、相手の端末で「合わせる」を選びます。', 'message'),
      row('最後に書き出した日', last ?? 'まだありません'), status,
      h('div', { className: 'actions start' },
        button('バックアップを書き出す', () => openExport(app), 'gold', { id: 'export' }),
        button('ファイルから取り込む', () => picker.click()),
        button('取り込み前の状態に戻す', async () => {
          const old = await app.store.persistence.backup('before-import');
          if (!old) { app.fail('取り込み前の控えはありません。'); return; }
          await importBackup(app, old);
        }),
        button('端末の控えから戻す', () => keptCopies(app), 'outline', { id: 'kept-copies' }),
        button('CSV出力', () => csvSheet(app), 'outline', { id: 'settings-csv' })), picker,
      note('Mac版（Swift）のデータは「~/Library/Application Support/Mitsunari/ledger.json」です。このファイルも取り込めます（レシート画像は含まれません）。')),
    panel('レシート・明細',
      button('レシート・明細を読み取る', () => openImport(app), 'outline', { id: 'settings-import' }),
      h('label', { className: 'check' }, h('input', { type: 'checkbox', id: 'keep-originals', checked: data.settings.keepsReceiptImages,
        onchange: async (e) => { await app.perform(() => app.store.setSetting('keepsReceiptImages', e.target.checked)); app.render(); } }), '原本の画像をアプリ内に保存する'),
      h('p', { className: 'note' }, `保存中の原本 ${originals}件（`, size, '）。個別の削除は、記録の「レシートを表示」から行います。'),
      unlinked.length ? [note(`記録を削除したレシートの原本が${unlinked.length}件残っています。`, 'note warn'),
        button('残っている原本を削除', async () => {
          if (!(await confirmSheet(`原本${unlinked.length}件を削除しますか？`, '削除すると、記録を元に戻しても画像は戻りません。', '原本を削除する'))) return;
          await app.perform(async () => { for (const r of unlinked) await app.store.deleteReceiptFiles(r.id); });
          app.render();
        }, 'danger')] : null,
      note('撮影・取り込んだ画像は写真アプリに保存せず、写真アプリの画像を削除することもありません。')),
    panel('まだ使えない機能', note('自動同期の接続（置き場の準備は承認後）、生成AIとの会話、アプリを閉じている間の通知（カレンダーへの書き出しで代用）、暗号化されたPDF、台形に写った写真の補正。', 'message')),
    panel('このアプリについて', note(`財略三成　財務軍略　Web版 ${app.version}`, 'message'), note('財を治め、未来を築く。'),
      note('文字認識：Tesseract.js（Apache-2.0）を端末内で使用。')));
}
