// アプリロックの画面と設定
import { h, button, sheet, panel, row, note } from './dom.js';
import { selectField, checkField } from './form.js';
import * as K from '../core/lock.js';
import { stop as stopSpeech } from './voice.js';
import { stop as stopListening } from './listen.js';

const KEY = 'lock';
let record = null;
let hiddenAt = null;
let locked = false;
let watching = false;

const persist = async (app, next) => { await app.store.persistence.setLocal(KEY, next); record = next; };
const cover = (on) => document.documentElement.classList.toggle('covered', on);

/** 起動時に呼ぶ。設定があればロック画面を出し、戻ってきたときも確かめる。 */
export async function startLock(app) {
  record = (await app.store.persistence.local(KEY)) ?? null;
  hiddenAt = null;
  if (record) showLock(app);
  if (watching) return;
  watching = true;
  document.addEventListener('visibilitychange', () => {
    if (!record) return;
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      cover(true); // アプリの切り替え画面に金額が写らないようにする
      stopSpeech();
      stopListening();
    } else {
      if (K.shouldLock(hiddenAt, Date.now(), record.timeout)) showLock(app);
      else if (!locked) cover(false);
      hiddenAt = null;
    }
  });
}

export function showLock(app) {
  if (locked || !record) return;
  locked = true;
  stopListening();
  app.talking = false;
  cover(true);
  const dialog = h('dialog', { className: 'sheet lock', 'aria-label': 'ロック中' });
  const message = h('p', { className: 'error', role: 'alert' });
  let recovery = false;
  const input = h('input', { type: 'password', inputMode: 'numeric', autocomplete: 'off', 'aria-label': 'パスコード' });
  const label = h('p', { className: 'message' }, 'パスコードを入力してください。');
  const unlock = () => {
    locked = false;
    cover(false);
    dialog.removeEventListener('close', keep);
    dialog.close();
    dialog.remove();
  };
  async function submit() {
    if (!input.value) return;
    open.disabled = true;
    const result = await K.check(record, input.value, { recovery });
    await persist(app, result.record).catch(() => {});
    open.disabled = false;
    input.value = '';
    if (result.ok) {
      unlock();
      if (recovery) app.toast('復元コードで開きました。設定の「アプリロック」でパスコードを設定し直してください。');
    } else message.textContent = result.wait ? `${result.wait}秒待ってから、もう一度入力してください。` : recovery ? '復元コードが違います。' : 'パスコードが違います。';
  }
  const open = button('開く', submit, 'gold', { id: 'unlock' });
  const bio = button('Face ID・Touch ID で開く', async () => {
    message.textContent = '';
    try { if (await K.verifyBiometric(record.credentialID)) unlock(); else message.textContent = '本人を確認できませんでした。'; }
    catch { message.textContent = '本人を確認できませんでした。パスコードを使ってください。'; }
  }, 'outline wide', { id: 'unlock-biometric' });
  const toggle = button('復元コードを使う', () => {
    recovery = !recovery;
    input.type = recovery ? 'text' : 'password';
    input.inputMode = recovery ? 'text' : 'numeric';
    input.setAttribute('aria-label', recovery ? '復元コード' : 'パスコード');
    label.textContent = recovery ? '復元コード（16文字）を入力してください。' : 'パスコードを入力してください。';
    toggle.textContent = recovery ? 'パスコードを使う' : '復元コードを使う';
    input.value = '';
    message.textContent = '';
  }, 'link');
  // Esc などで閉じられても、ロック中は開き直す
  const keep = () => { if (locked) dialog.showModal(); };
  dialog.addEventListener('cancel', (e) => e.preventDefault());
  dialog.addEventListener('close', keep);
  dialog.append(h('img', { className: 'lock-hero', src: 'assets/home_hero.png', alt: '石田三成　財略三成　財務軍略' }), h('h2', { className: 'sheet-title' }, '財略三成　ロック中'), h('form', { onsubmit: (e) => { e.preventDefault(); submit(); } }, label, input, message,
    record.credentialID ? bio : null, h('div', { className: 'actions' }, toggle, open)),
  note('パスコードも復元コードも分からない場合、この画面は開けません。バックアップがあれば、ブラウザのサイトデータを消してから読み込み直せます（消すと、この端末の記録はなくなります）。'));
  document.body.append(dialog);
  dialog.showModal();
  input.focus();
}

export function lockPanel(app) {
  return panel('アプリロック',
    row('現在の設定', record ? `オン（${K.TIMEOUTS[record.timeout]}にロック${record.credentialID ? '・Face ID／Touch ID' : ''}）` : 'オフ'),
    h('div', { className: 'actions start' }, record ? [
      button('ロックの設定を変える', () => lockSettings(app), 'outline', { id: 'lock-settings' }),
      button('今すぐロック', () => showLock(app), 'outline', { id: 'lock-now' }),
    ] : button('ロックを設定する', () => setupSheet(app), 'outline', { id: 'lock-setup' })),
    note('画面を開けないようにする機能です。保存データそのものは暗号化しないので、端末の画面ロックと一緒に使ってください。'));
}

const passInput = (label) => h('input', { type: 'password', inputMode: 'numeric', autocomplete: 'off', 'aria-label': label });
const field = (label, control) => h('label', { className: 'field' }, h('span', {}, label), control);

function setupSheet(app) {
  sheet('アプリロックの設定', (close) => {
    const body = h('div', {});
    const first = passInput('新しいパスコード'), second = passInput('もう一度入力');
    const timeout = selectField('画面を離れてからロックするまで', Object.entries(K.TIMEOUTS), '60');
    const message = h('p', { className: 'error', role: 'alert' });
    const next = button('次へ', async () => {
      message.textContent = '';
      if (first.value !== second.value) { message.textContent = '2回の入力が一致しません。'; return; }
      next.disabled = true;
      try {
        const made = await K.createLock(first.value, { timeout: Number(timeout.value() ?? 0) });
        showCode(made);
      } catch (error) { message.textContent = error.message; next.disabled = false; }
    }, 'gold', { id: 'lock-next' });
    function showCode({ code, record: made }) {
      const kept = checkField('復元コードを、この端末とは別の場所に控えました', false);
      const done = button('ロックを始める', async () => {
        if (!(await app.perform(async () => { await persist(app, made); return true; }))) return;
        close();
        app.render();
      }, 'gold', { id: 'lock-start', disabled: true });
      kept.input.addEventListener('change', () => { done.disabled = !kept.input.checked; });
      body.replaceChildren(note('復元コードは、パスコードを忘れたときに使います。この画面を閉じると、二度と表示できません。', 'message'),
        h('p', { className: 'recovery', id: 'recovery-code' }, code), kept.element, h('div', { className: 'actions' }, button('やめる', close), done));
    }
    body.append(field('新しいパスコード（6〜12桁の数字）', first), field('もう一度入力', second), timeout.element, message,
      h('div', { className: 'actions' }, button('キャンセル', close), next));
    return body;
  }, { head: 'settings' });
}

function lockSettings(app) {
  sheet('ロックの設定を変える', (close) => {
    const body = h('div', {});
    const current = passInput('今のパスコード');
    const message = h('p', { className: 'error', role: 'alert' });
    const confirmButton = button('確認', async () => {
      const result = await K.check(record, current.value);
      await persist(app, result.record).catch(() => {});
      current.value = '';
      if (!result.ok) { message.textContent = result.wait ? `${result.wait}秒待ってから入力してください。` : 'パスコードが違います。'; return; }
      show();
    }, 'gold', { id: 'lock-confirm' });
    async function show() {
      const timeout = selectField('画面を離れてからロックするまで', Object.entries(K.TIMEOUTS), String(record.timeout));
      timeout.input.addEventListener('change', async () => { await app.perform(() => persist(app, { ...record, timeout: Number(timeout.input.value) })); });
      const area = h('div', {});
      const status = h('p', { className: 'note', role: 'status' });
      async function drawBio() {
        const available = await K.biometricAvailable();
        area.replaceChildren(record.credentialID ? button('Face ID・Touch ID を使うのをやめる', async () => {
          const { credentialID, ...rest } = record;
          await app.perform(() => persist(app, rest));
          drawBio();
        }, 'outline') : available ? button('Face ID・Touch ID も使う', async () => {
          try { await persist(app, { ...record, credentialID: await K.registerBiometric() }); drawBio(); } catch { status.textContent = '登録できませんでした（取り消した場合も含みます）。'; }
        }, 'outline') : note('この開き方・端末では、Face ID・Touch ID は使えません（公開した住所をSafariで開くと使える場合があります）。'));
      }
      body.replaceChildren(timeout.element, area, status,
        note('Face ID・Touch ID を使うと、解除用の鍵（パスキー）が端末のパスワード管理に保存されます。'),
        h('div', { className: 'actions' },
          button('ロックをオフにする', async () => { if (await app.perform(async () => { await persist(app, null); return true; })) { close(); app.render(); } }, 'danger', { id: 'lock-off' }),
          button('パスコードを作り直す', () => { close(); setupSheet(app); }),
          button('閉じる', () => { close(); app.render(); }, 'gold')));
      await drawBio();
    }
    body.append(field('今のパスコード', current), message, h('div', { className: 'actions' }, button('キャンセル', close), confirmButton));
    return body;
  }, { head: 'settings' });
}
