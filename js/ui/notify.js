// お知らせと通知の設定。アプリを閉じている間の通知は、カレンダーアプリへの書き出しで行う。
import { h, button, sheet, panel, row, note, saveFile } from './dom.js';
import { selectField, checkField } from './form.js';
import { alerts, bannerText, DEFAULTS, KINDS, DAYS } from '../core/notify.js';
import { events } from '../core/calendar.js';
import { toICS } from '../core/ics.js';
import { today, addDays } from '../core/date.js';

let watching = false;

export const preferences = (app) => ({ ...DEFAULTS, ...(app.notifyPrefs ?? {}) });
export const currentAlerts = (app) => alerts(app.store.data, today(), preferences(app));

/** 起動時に設定を読み、必要なら端末の通知を出す */
export async function startNotify(app) {
  app.notifyPrefs = (await app.store.persistence.local('notify')) ?? null;
  if (!watching) {
    watching = true;
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') showBanners(app).catch(() => {}); });
  }
  showBanners(app).catch(() => {});
}

export const permission = () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

/** 同じ内容は1日1回まで。show は通知を出す関数（テストで差し替える）。 */
export async function showBanners(app, show = defaultShow) {
  const prefs = preferences(app);
  if (!prefs.enabled || !prefs.banner || permission() !== 'granted' || document.documentElement.classList.contains('covered')) return 0;
  const day = today();
  let record = await app.store.persistence.local('notified');
  if (record?.day !== day) record = { day, keys: [] };
  const fresh = currentAlerts(app).filter((a) => a.level <= 2 && !record.keys.includes(a.key)).slice(0, 5);
  for (const alert of fresh) await show('財略三成', bannerText(alert, prefs.amounts), alert.key);
  if (fresh.length) await app.store.persistence.setLocal('notified', { day, keys: [...record.keys, ...fresh.map((a) => a.key)] });
  return fresh.length;
}

async function defaultShow(title, body, tag) {
  const options = { body, tag, icon: 'icons/icon-192.png' };
  const registration = await navigator.serviceWorker?.getRegistration?.();
  if (registration?.showNotification) await registration.showNotification(title, options); else new Notification(title, options);
}

export function alertsPanel(app) {
  const list = currentAlerts(app);
  return panel(`お知らせ（${list.length}件）`, list.length ? list.slice(0, 8).map((a) => h('div', { className: `alert level${a.level}` }, h('b', {}, a.title), a.detail ? h('small', {}, a.detail) : null))
    : note('今お知らせすることはありません。'),
  list.length > 8 ? h('details', {}, h('summary', {}, `ほか${list.length - 8}件`), list.slice(8).map((a) => h('div', { className: `alert level${a.level}` }, h('b', {}, a.title), a.detail ? h('small', {}, a.detail) : null))) : null);
}

export function notifyPanel(app) {
  const p = preferences(app);
  return panel('通知', row('お知らせの印', p.enabled ? `オン（${DAYS[p.daysBefore]}）` : 'オフ'),
    row('端末の通知', p.enabled && p.banner ? (permission() === 'granted' ? 'オン（アプリを開いたとき）' : '許可されていません') : 'オフ'),
    h('div', { className: 'actions start' }, button('通知の設定', () => notifySheet(app), 'outline', { id: 'open-notify' }), button('カレンダーアプリに書き出す', () => icsSheet(app), 'outline')),
    note('このアプリは通知用のサーバーを使わないため、閉じている間は通知できません。決まった日時に知らせてほしい場合は、予定をカレンダーアプリに書き出してください。'));
}

function notifySheet(app) {
  sheet('通知の設定', (close) => {
    const p = preferences(app);
    const enabled = checkField('お知らせを使う（下のメニュー「資産管理」に件数の印を出す）', p.enabled);
    const days = selectField('支払い・入金の予定を知らせる時期', Object.entries(DAYS), String(p.daysBefore));
    const kinds = Object.entries(KINDS).map(([id, text]) => [id, checkField(text, p.kinds.includes(id))]);
    const banner = checkField('アプリを開いたとき、端末の通知も出す', p.banner);
    const amounts = checkField('端末の通知に金額を含める（ロック画面に表示されることがあります）', p.amounts);
    const status = h('p', { className: 'note', role: 'status' }, permission() === 'unsupported' ? 'この開き方では、端末の通知は使えません（iPhoneはホーム画面に追加したアプリで使える場合があります）。' : permission() === 'denied' ? '端末の設定で通知が許可されていません。' : '');
    banner.input.disabled = permission() === 'unsupported';
    banner.input.addEventListener('change', async () => {
      if (!banner.input.checked || permission() !== 'default') return;
      const answer = await Notification.requestPermission();
      if (answer !== 'granted') { banner.input.checked = false; status.textContent = '通知は許可されませんでした。'; }
    });
    return h('div', {}, enabled.element, days.element, h('h3', {}, '知らせる内容'), kinds.map(([, f]) => f.element), h('h3', {}, '端末の通知'), banner.element, amounts.element, status,
      h('div', { className: 'actions' }, button('キャンセル', close), button('保存', async () => {
        const next = { enabled: enabled.value(), daysBefore: Number(days.value() ?? 0), kinds: kinds.filter(([, f]) => f.value()).map(([id]) => id), banner: banner.value(), amounts: amounts.value() };
        if (!(await app.perform(async () => { await app.store.persistence.setLocal('notify', next); return true; }))) return;
        app.notifyPrefs = next;
        close();
        app.render();
        showBanners(app).catch(() => {});
      }, 'gold', { id: 'save-notify' })));
  }, { head: 'settings' });
}

export function icsSheet(app) {
  sheet('予定をカレンダーアプリに書き出す', (close) => {
    const span = selectField('書き出す期間', [['31', '1か月先まで'], ['93', '3か月先まで'], ['366', '1年先まで']], '93');
    const before = selectField('知らせる時期（朝9時）', [['0', '当日'], ['1', '1日前'], ['3', '3日前'], ['7', '1週間前']], '1');
    const amounts = checkField('予定の名前に金額を含める', false);
    const status = h('p', { className: 'note', role: 'status' });
    const build = () => {
      const now = today();
      const list = events(app.store.data, { start: now, end: addDays(now, Number(span.value())) }, now);
      return { text: toICS(list, { amounts: amounts.value(), daysBefore: Number(before.value()) }), count: list.filter((e) => ['planned', 'info'].includes(e.state)).length };
    };
    return h('div', {}, note('書き出したファイルをカレンダーアプリで開くと、予定と通知が登録されます。', 'message'),
      note('予定の名前は、カレンダーアプリの設定によって iCloud などに保存されます。金額は、含めない設定が初めの状態です。支払いを記録しても、書き出した予定は変わりません。', 'note warn'),
      span.element, before.element, amounts.element, status,
      h('div', { className: 'actions' }, button('閉じる', close), button('書き出す', async () => {
        const result = build();
        if (!result.count) { status.textContent = 'この期間に予定がありません。'; return; }
        if (await saveFile(result.text, `zairyaku-yotei-${today()}.ics`, 'text/calendar')) status.textContent = `${result.count}件の予定を書き出しました。`;
      }, 'gold', { id: 'save-ics' })));
  }, { head: 'calendar' });
}
