// iPhone への導入の案内と、この端末で使える機能の確認。記録（お金の情報）は読まず、何も送らない。
import { h, button, panel, row, note, sheet } from './dom.js';
import { supported as speechSupported, voices } from './voice.js';
import { supported as listenSupported, onDevice } from './listen.js';

export function platform(nav = navigator, standaloneQuery = () => matchMedia('(display-mode: standalone)').matches) {
  const ua = nav.userAgent ?? '';
  // iPad は Mac と名乗ることがあるため、指で操作できるかも見る
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1);
  return { ios, standalone: nav.standalone === true || standaloneQuery() };
}

export const INSTALL_STEPS = ['iPhoneの「Safari」でこのアプリを開く（ほかのアプリ内の画面ではなく）。', '画面の下の「共有」ボタン（四角から上向きの矢印）を押す。', '「ホーム画面に追加」を選び、右上の「追加」を押す。',
  'ホーム画面の「財略三成」のアイコンから開く。以後は、いつもこのアイコンから使う。'];
const SEPARATE = 'Safari で開いた画面と、ホーム画面のアイコンから開いた画面では、記録の保存場所が別です。記録を入力する前に、ホーム画面に追加してください。';

const steps = () => h('ol', { className: 'steps' }, INSTALL_STEPS.map((s) => h('li', {}, s)));
const seen = () => { try { return localStorage.getItem('zairyaku-install-note') === 'done'; } catch { return false; } };

/** iPhone の Safari で（ホーム画面に追加せずに）開いたとき、一度だけ案内する。ホーム画面の見た目は変えない。 */
export function installNote(app, where = platform()) {
  if (!where.ios || where.standalone || seen()) return false;
  sheet('ホーム画面に追加してから使います', (close) => h('div', {},
    note(SEPARATE, 'note warn'), steps(),
    h('div', { className: 'actions' }, button('今後は表示しない', () => { localStorage.setItem('zairyaku-install-note', 'done'); close(); }, 'outline', { id: 'install-never' }),
      button('閉じる', close, 'gold', { id: 'install-close' }))), { head: 'settings' });
  return true;
}

const message = (worker, data) => new Promise((resolve) => {
  const channel = new MessageChannel();
  const timer = setTimeout(() => resolve(null), 120_000);
  channel.port1.onmessage = (event) => { clearTimeout(timer); resolve(event.data); };
  worker.postMessage(data, [channel.port2]);
});
const controller = () => navigator.serviceWorker?.controller ?? null;

/** 端末の返事が遅いときは、待ち続けずに「確認できない」とする */
const soon = (promise, fallback = null, ms = 3000) => Promise.race([Promise.resolve(promise).catch(() => fallback), new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);

/** 端末で使える機能を調べる。許可を求める操作（カメラ・マイク・通知）はしない。 */
export async function diagnose(app) {
  const where = platform();
  const items = [['版', `Web ${app.version}`], ['開き方', where.standalone ? 'ホーム画面のアプリ' : 'ブラウザの画面']];
  items.push(['安全な接続（https など）', isSecureContext ? '使える' : '使えない']);
  items.push(['アプリ本体のオフライン保存', controller() ? '準備できている' : 'まだ（通信できる状態で開き直すと準備されます）']);
  const vendor = controller() ? await soon(message(controller(), 'vendor-status')) : null;
  items.push(['文字認識とPDFのオフライン保存', vendor ? (vendor.saved === vendor.total ? '準備できている' : `未保存（${vendor.saved}/${vendor.total}）`) : '確認できない']);
  const kept = await soon(navigator.storage?.persisted?.());
  items.push(['記録を自動で消さない設定', kept == null ? '確認できない' : kept ? 'あり' : 'なし（バックアップをこまめに）']);
  const usage = await soon(navigator.storage?.estimate?.());
  items.push(['使用している容量', usage?.usage != null ? `約${(usage.usage / 1_000_000).toFixed(1)}MB` : '確認できない']);
  items.push(['アプリ内のカメラ', navigator.mediaDevices?.getUserMedia ? '使える見込み（使うときに許可を確認）' : '使えない（写真を選ぶか、文字の貼り付けを使う）']);
  const japanese = speechSupported() ? voices().length : 0;
  items.push(['日本語の読み上げの声', japanese ? `${japanese}種類` : '見つからない（少し待って「確認し直す」）']);
  const local = listenSupported() ? await soon(onDevice(), 'unavailable') : null;
  items.push(['音声認識', !listenSupported() ? '使えない（キーボードのマイクを使う）' : local === 'available' ? '端末の中で使える' : '同意すれば使える（音声が外部に送られることがある）']);
  items.push(['端末の通知', typeof Notification === 'undefined' ? '使えない' : { granted: '許可済み', denied: '拒否されている', default: 'まだ許可していない' }[Notification.permission]]);
  items.push(['暗号化の機能', globalThis.crypto?.subtle ? '使える' : '使えない']);
  items.push(['画面の大きさ', `${innerWidth}×${innerHeight}`], ['ブラウザ', navigator.userAgent]);
  return items;
}

export const reportText = (items) => ['財略三成 端末の確認（お金の記録は含みません）', ...items.map(([k, v]) => `${k}：${v}`)].join('\n');

export function devicePanel(app) {
  const where = platform();
  const list = h('div', { id: 'device-result' }, note('確認しています…'));
  const status = h('p', { className: 'note', role: 'status', id: 'device-message' });
  let items = [];
  const refresh = async () => {
    items = await diagnose(app);
    list.replaceChildren(...items.map(([k, v]) => row(k, v)));
  };
  refresh().catch(() => list.replaceChildren(note('確認できませんでした。')));
  const prepare = button('文字認識をオフライン用に保存する（約14MB）', async () => {
    if (!controller()) { status.textContent = '先に、通信できる状態でアプリを開き直してください。'; return; }
    prepare.disabled = true;
    status.textContent = '保存しています…（通信量は約14MBです。画面を閉じないでください）';
    const result = await message(controller(), 'prepare-vendor');
    prepare.disabled = false;
    status.textContent = result?.ok ? '保存しました。通信できないときも、文字認識とPDFの読み取りを使えます。' : '保存できませんでした。通信の状態を確かめて、もう一度試してください。';
    await refresh();
  }, 'outline', { id: 'prepare-offline' });
  const copy = button('確認結果をコピー', async () => {
    const text = reportText(items);
    try { await navigator.clipboard.writeText(text); status.textContent = 'コピーしました。開発担当との会話に貼り付けてください。'; }
    catch { list.append(h('textarea', { rows: 12, readOnly: true, 'aria-label': '確認結果' }, text)); status.textContent = '下の文字を選んでコピーしてください。'; }
  }, 'outline', { id: 'copy-device' });
  return panel('iPhoneに入れる・端末の確認',
    where.standalone ? note('ホーム画面のアプリとして開いています。', 'message') : [note(SEPARATE, where.ios ? 'note warn' : 'note'), h('details', { id: 'install-steps' }, h('summary', {}, 'ホーム画面に追加する手順（iPhone）'), steps()), note('Mac：Safariの「ファイル」→「Dockに追加」。')],
    list, h('div', { className: 'actions start' }, prepare, button('確認し直す', refresh, 'outline', { id: 'recheck-device' }), copy), status,
    note('確認結果に、お金の記録は含みません。自動で送ることもありません。'));
}
