// バックアップの書き出し・取り込み（合わせる／置き換える）の画面
import { h, button, sheet, panel, row, note, confirmSheet, saveFile } from './dom.js';
import * as L from '../core/ledger.js';
import { yen } from '../core/money.js';
import { today } from '../core/date.js';
import { monthContaining } from '../core/finance.js';
import { parseLedger } from '../core/store.js';
import { makeBackup, encrypt, readBackup, isEncrypted } from '../core/backup.js';
import { mergeLedgers } from '../core/merge.js';
import { afterReplace } from './sync.js';

const deliver = (text, name) => saveFile(text, name, 'application/json');

export async function exportBackup(app, password) {
  const { text, count, missing } = await makeBackup(app.store);
  const body = password ? await encrypt(text, password) : text;
  return { body, name: `zairyaku-backup-${today()}${password ? '-encrypted' : ''}.json`, count, missing };
}

export function openExport(app) {
  sheet('バックアップを書き出す', (close) => {
    const first = h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': '合言葉（8文字以上）' });
    const second = h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': '合言葉をもう一度' });
    const failure = h('p', { className: 'error', role: 'alert' });
    const field = (label, control) => h('label', { className: 'field' }, h('span', {}, label), control);
    const run = async (password) => {
      try {
        failure.textContent = '書き出しています…';
        const result = await exportBackup(app, password);
        if (!(await deliver(result.body, result.name))) { failure.textContent = ''; return; }
        localStorage.setItem('zairyaku-last-backup', today());
        close();
        app.toast(`バックアップを書き出しました（レシート原本${result.count}件を含む${result.missing ? `。この端末にない原本${result.missing}件は含みません` : ''}）。`);
      } catch (error) { failure.textContent = error.message; }
    };
    return h('div', {},
      note('記録とレシート原本を1つのファイルにします。iCloud Drive や AirDrop で別の端末へ移すときは、合言葉をつけてください。', 'message'),
      field('合言葉（8文字以上）', first), field('合言葉をもう一度', second),
      note('合言葉は保存しません。忘れると、そのファイルは開けません。', 'note warn'), failure,
      h('div', { className: 'actions' }, button('キャンセル', close), button('合言葉なしで書き出す', async () => {
        if (await confirmSheet('合言葉なしで書き出しますか？', 'ファイルを手に入れた人は、金額や店名を読めます。このMacやiPhoneの中だけに置く場合にしてください。', '書き出す')) run(null);
      }), button('合言葉をつけて書き出す', () => {
        if (first.value.length < 8) { failure.textContent = '合言葉は8文字以上にしてください。'; return; }
        if (first.value !== second.value) { failure.textContent = '2回の合言葉が一致しません。'; return; }
        run(first.value);
      }, 'gold', { id: 'export-encrypted' })));
  }, { head: 'sync' });
}

function askPassword() {
  return new Promise((resolve) => {
    sheet('合言葉を入力', (close) => {
      const input = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'バックアップの合言葉' });
      return h('form', { onsubmit: (e) => { e.preventDefault(); close(); resolve(input.value); } }, note('このバックアップは合言葉で保護されています。'), input,
        h('div', { className: 'actions' }, button('キャンセル', () => { close(); resolve(null); }), button('開く', () => { close(); resolve(input.value); }, 'gold', { id: 'open-encrypted' })));
    });
  });
}

/** 取り込み方を選ぶ。戻り値は取り込んだかどうか。 */
export async function importBackup(app, text) {
  let backup;
  try {
    if (isEncrypted(text)) {
      const password = await askPassword();
      if (password === null) return false;
      backup = await readBackup(text, password);
    } else backup = await readBackup(text);
  } catch (error) { app.fail(error.message); return false; }
  const incoming = parseLedger(backup.ledgerText);
  const count = (list) => L.live(list).length;
  const preview = mergeLedgers(app.store.data, incoming);

  return new Promise((resolve) => {
    sheet('バックアップを取り込む', (close) => {
      const include = new Set();
      const finish = async (work, message) => {
        const ok = await app.perform(async () => { await work(); return true; });
        close();
        if (ok) { app.month = monthContaining(today(), app.store.data); app.go('home'); app.toast(message); }
        resolve(!!ok);
      };
      return h('div', {},
        panel('取り込むファイル', row('記録', `${count(incoming.transactions)}件`), row('口座・カード', `${count(incoming.accounts)}件・${count(incoming.cards)}件`), row('レシート原本', `${backup.files.length}件`),
          row('この端末の今の記録', `${count(app.store.data.transactions)}件`)),
        panel('合わせる（おすすめ）',
          note('この端末の記録を消さずに、ファイルの記録を足します。同じ記録は、新しく変更した方を残します（削除も反映します）。', 'message'),
          row('追加・更新', `追加${preview.counts.added}件・更新${preview.counts.updated}件`),
          preview.suspects.length ? [note(`同じ金額・近い日付の記録が、この端末にもあります（${preview.suspects.length}件）。同じ支払いなら追加しないでください。別の支払いなら印を付けます。`, 'note warn'),
            preview.suspects.slice(0, 50).map((s) => h('label', { className: 'check' }, h('input', { type: 'checkbox', 'data-suspect': s.incoming.id, onchange: (e) => (e.target.checked ? include.add(s.incoming.id) : include.delete(s.incoming.id)) }),
              h('span', {}, `${s.incoming.day}　${yen(s.incoming.amount)}　${s.incoming.storeName ?? ''}　を追加する`))),
            preview.suspects.length > 50 ? note('51件目以降は追加しません。') : null] : null,
          h('div', { className: 'actions' }, button('合わせる', () => finish(() => app.store.merge(backup.ledgerText, backup.files, { include: [...include] }), 'バックアップを合わせました。'), 'gold', { id: 'merge' }))),
        panel('置き換える', note(`今の記録${count(app.store.data.transactions)}件は、ファイルの内容に置き換わります（直前の状態は端末内に残し、設定から戻せます）。${app.syncSend ? '同期している場合は、置き場の新しい内容が優先されます。すべての端末を過去に戻すには「過去の版に戻す」を使ってください。' : ''}`, 'message'),
          h('div', { className: 'actions' }, button('置き換える', () => finish(async () => { await app.store.replaceAll(backup.ledgerText, backup.files); await afterReplace(app); }, 'データを取り込みました。'), 'outline', { id: 'replace' }))),
        h('div', { className: 'actions' }, button('キャンセル', () => { close(); resolve(false); })));
    }, { className: 'full', onClose: () => {}, head: 'sync' });
  });
}

const KEPT = [[/^day-(.+)$/, (m) => `日ごとの控え（${m[1]}の最初の保存の前）`], [/^before-import$/, () => '取り込みの前'], [/^before-sync$/, () => '最後の同期の取り込みの前'],
  [/^before-restore$/, () => '過去の内容に戻す前'], [/^before-upgrade-v(\d+)$/, (m) => `データ形式を版${m[1]}から上げる前`]];

/** 端末に残っている控えの一覧。選ぶと、取り込みと同じ画面（合わせる／置き換える）になる。 */
export function keptCopies(app) {
  sheet('端末の控え', (close) => {
    const body = h('div', { className: 'stack' }, note('控えを読み込んでいます…', 'message'));
    (async () => {
      const keys = await app.store.persistence.backupKeys();
      const rows = [];
      for (const key of keys.sort().reverse()) {
        const text = await app.store.persistence.backup(key);
        const label = KEPT.map(([pattern, name]) => { const m = key.match(pattern); return m ? name(m) : null; }).find(Boolean) ?? key;
        let detail;
        try { detail = `取引${L.live(parseLedger(text).transactions).length}件`; } catch { detail = '読み込めません'; }
        rows.push(h('div', { className: 'due' }, h('span', {}, label, h('small', {}, detail)),
          button('内容を確かめる', async () => { close(); await importBackup(app, text); }, 'outline small', { 'aria-label': `${label}を確かめる`, disabled: detail === '読み込めません' })));
      }
      body.replaceChildren(...(rows.length ? rows : [note('控えはまだありません。', 'message')]));
    })().catch((error) => body.replaceChildren(note(error.message, 'note warn')));
    return h('div', {}, note('この端末のブラウザの中にある控えです。端末の故障や紛失には備えられないので、ファイルへの書き出しも続けてください。', 'message'), body,
      h('div', { className: 'actions' }, button('閉じる', close, 'gold')));
  }, { className: 'full', head: 'sync' });
}
