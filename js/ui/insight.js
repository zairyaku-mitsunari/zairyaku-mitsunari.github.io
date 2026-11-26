// 財務軍議・見直し候補・三成への相談の画面
import { h, button, panel, row, note, sheet, confirmSheet } from './dom.js';
import { selectField, checkField } from './form.js';
import * as voice from './voice.js';
import * as L from '../core/ledger.js';
import { COUNCILS, report, reportTitle } from '../core/council.js';
import { findings, results, STATUS } from '../core/advice.js';
import { EXAMPLES } from '../core/consult.js';
import { respond } from '../core/assistant.js';
import * as ear from './listen.js';
import { yen } from '../core/money.js';
import { today, monthTitle } from '../core/date.js';

/** 読み上げの操作 */
export function speechControls(lines) {
  const message = h('p', { className: 'note', role: 'status' });
  const start = () => {
    message.textContent = '';
    if (!voice.supported() || !voice.speak(lines())) message.textContent = 'この端末で使える日本語の声が見つかりません。端末の設定で日本語の読み上げの声を追加してください。';
  };
  return h('div', { className: 'speech no-print' }, h('div', { className: 'actions start' },
    button('🔊 読み上げ', start, 'outline small'), button('一時停止', voice.pause, 'outline small'), button('再開', voice.resume, 'outline small'), button('停止', voice.stop, 'outline small')), message);
}

const reportBody = (r) => h('div', { className: 'report' }, h('h2', {}, reportTitle(r)), h('p', { className: 'note' }, `作成日 ${r.createdDay}`),
  r.sections.map((s) => panel(s.title, s.lines.map((line) => h('p', { className: 'message' }, line)))));
const reportLines = (r) => [reportTitle(r), ...r.sections.flatMap((s) => [s.title, ...s.lines])];

export function councilView(app) {
  const { data } = app.store;
  const current = report(data, app.councilKind, today(), app.scope);
  const saved = L.live(data.councils).sort((a, b) => b.createdAt - a.createdAt);
  return h('div', { className: 'stack' },
    h('div', { className: 'tabs four no-print' }, Object.entries(COUNCILS).map(([id, text]) => button(text, () => { voice.stop(); app.councilKind = id; app.render(); }, id === app.councilKind ? 'gold' : 'outline', { 'aria-pressed': String(id === app.councilKind), 'data-council': id }))),
    h('div', { className: 'controls no-print' }, app.scopeSelect()),
    speechControls(() => reportLines(current)),
    h('div', { className: 'actions start no-print' },
      button('この軍議を保存', async () => { if (await app.perform(() => app.store.saveCouncil(current))) app.toast('軍議を保存しました。'); }, 'gold', { id: 'save-council' }),
      button('印刷・PDFにする', () => window.print(), 'outline')),
    reportBody(current),
    panel('保存した軍議', saved.length ? saved.slice(0, 50).map((r) => h('div', { className: 'due' }, h('span', {}, reportTitle(r), h('small', {}, `作成日 ${r.createdDay}`)),
      button('開く', () => savedSheet(app, r), 'outline small', { 'aria-label': `${reportTitle(r)}を開く` }))) : note('保存した軍議はまだありません。')));
}

function savedSheet(app, r) {
  sheet('保存した軍議', (close) => {
    const done = () => { voice.stop(); close(); };
    return h('div', {}, note('保存した時点の内容です。', 'message'), speechControls(() => reportLines(r)), reportBody(r),
      h('div', { className: 'actions' }, button('削除', async () => {
        if (!(await confirmSheet('この軍議を削除しますか？', reportTitle(r), '削除する'))) return;
        if (await app.perform(async () => { await app.store.deleteCouncil(r.id); return true; })) { done(); app.render(); }
      }, 'danger'), button('閉じる', done, 'gold')));
  }, { className: 'full', head: 'council' });
}

export function adviceView(app) {
  const { data } = app.store;
  const now = today();
  const list = findings(data, now, app.scope);
  const done = results(data, now);
  const judge = (f, status) => async () => { await app.perform(() => app.store.setImprovement(f, status, now)); app.render(); };
  const undo = (id) => async () => { await app.perform(() => app.store.clearImprovement(id)); app.render(); };
  const priority = { 1: '優先度 高', 2: '優先度 中', 3: '優先度 低' };
  const card = (f) => h('section', { className: 'panel finding', 'data-type': f.type },
    h('p', { className: 'tags' }, h('span', { className: `badge p${f.priority}` }, priority[f.priority]), h('span', { className: 'badge' }, f.type), f.judgment?.status === 'planned' ? h('span', { className: 'badge plan' }, '実行する予定') : null),
    h('h2', {}, f.title), row('対象', f.target), f.current ? row('現在', f.current) : null, row('問題点', f.problem), row('判断の根拠', f.basis), row('改善の方法', f.action),
    row('月の削減可能額', f.monthlySaving == null ? '分かりません' : yen(f.monthlySaving)), row('年の削減可能額', f.yearlySaving == null ? '分かりません' : yen(f.yearlySaving), f.yearlySaving ? 'income' : ''),
    f.caution ? note(`注意：${f.caution}`, 'note warn') : null, f.assumption ? note(`推定の条件：${f.assumption}`) : null,
    h('div', { className: 'actions start' }, ['planned', 'done', 'dismissed'].map((s) => button(STATUS[s], judge(f, s), 'outline small', { 'aria-label': `${f.title}：${STATUS[s]}`, disabled: f.judgment?.status === s }))));
  return h('div', { className: 'stack' },
    h('div', { className: 'controls' }, app.scopeSelect()),
    panel('見直しの候補', row('件数', `${list.items.length}件`), row('削減できる可能性（年・推定）', yen(list.yearlySaving), 'large income'),
      note('記録と登録内容から機械的に見つけた候補です。不要かどうかは、あなたが決めてください。同じ対象の削減額は1回だけ数えます。支出の分類は「設定」→「項目の管理」で変えられます。')),
    list.items.length ? h('div', { className: 'cards' }, list.items.map(card)) : panel(null, note('今の記録からは、見直し候補は見つかりません。記録が増えると、比べられることが増えます。', 'message')),
    done.length ? panel('実行した改善と、その後の実績', done.map((r) => h('div', { className: 'due' }, h('span', {}, r.improvement.title, h('small', {},
      r.saved == null ? (r.months ? '金額を比べられない提案です' : '次の月度が終わると、実績を比べます') : `${monthTitle(r.improvement.startMonth)}度の後の${r.months}か月度：${r.saved >= 0 ? `削減 ${yen(r.saved)}` : `増加 ${yen(-r.saved)}`}`)),
    button('取り消す', undo(r.improvement.id), 'outline small', { 'aria-label': `${r.improvement.title}の実行を取り消す` }))), note('実績の差には、ほかの理由で増減した分も含まれます。')) : null,
    list.hidden.length ? panel('対象外にした候補', list.hidden.map((f) => h('div', { className: 'due' }, h('span', {}, f.title),
      button('戻す', undo(f.judgment.id), 'outline small', { 'aria-label': `${f.title}を戻す` })))) : null);
}

export function consultView(app) {
  const { data } = app.store;
  const history = L.live(data.consultations).sort((a, b) => a.createdAt - b.createdAt).slice(-30);
  const conf = voice.settings();
  const input = h('textarea', { rows: 2, 'aria-label': '三成への質問', placeholder: '例：今月の食費はいくら？' });
  const message = h('p', { className: 'error', role: 'alert' });
  async function ask(question) {
    const text = question.trim();
    if (!text) return;
    let lines;
    if (!(await app.perform(async () => {
      const earlier = L.live(app.store.data.consultations).sort((a, b) => a.createdAt - b.createdAt).slice(-10).map((c) => c.question);
      const result = await respond({ data: app.store.data, question: text, today: today(), scope: app.scope, history: earlier });
      lines = [result.title, ...result.lines];
      await app.store.saveConsultation(text, lines);
      return true;
    }))) return;
    app.render();
    document.getElementById('latest-answer')?.scrollIntoView({ block: 'nearest' });
    const talking = app.talking;
    if (voice.settings().auto || talking) {
      // 会話を続ける場合は、読み上げが終わってから次の質問を聞く
      if (!voice.speak(voice.settings().length === 'short' ? voice.brief(lines) : lines, () => { if (app.talking && app.route === 'analysis' && app.analysisTab === 'consult') document.getElementById('mic')?.click(); })) app.talking = false;
    }
  }
  const send = button('相談する', () => ask(input.value), 'gold', { id: 'ask' });
  const hearing = h('p', { className: 'note', role: 'status', id: 'hearing' });
  async function startListening(button_) {
    message.textContent = '';
    voice.stop();
    const local = await ear.onDevice();
    if (local !== 'available' && !ear.consented()) { consentSheet(app, () => startListening(button_)); return; }
    let heard = '';
    const session = ear.listen({ mode: local === 'available' ? 'local' : 'cloud',
      onText: (text) => { input.value = text; heard = text; },
      onError: (text) => { message.textContent = text; app.talking = false; },
      onEnd: (text) => {
        button_.textContent = '🎤 声で質問する'; hearing.textContent = '';
        if (!text) { if (!heard) app.talking = false; return; }
        input.value = text;
        if (voice.settings().autoSend || app.talking) ask(text); else hearing.textContent = '聞き取った内容を確かめて「相談する」を押してください。';
      } });
    if (session) { button_.textContent = '■ 聞き取りをやめる'; hearing.textContent = local === 'available' ? '聞き取っています（端末の中で認識）…' : '聞き取っています（ブラウザの音声認識）…'; }
  }
  const mic = ear.supported() ? button('🎤 声で質問する', () => {
    if (ear.listening()) { ear.stop(); app.talking = false; mic.textContent = '🎤 声で質問する'; hearing.textContent = ''; } else startListening(mic);
  }, 'outline wide', { id: 'mic' }) : null;
  const talk = checkField('会話を続ける（回答を読み上げた後、続けて聞き取る）', !!app.talking);
  talk.input.addEventListener('change', () => { app.talking = talk.input.checked; if (!app.talking) ear.stop(); });
  const autoSend = checkField('聞き取ったら、そのまま相談する', voice.settings().autoSend);
  autoSend.input.addEventListener('change', () => voice.save('autosend', autoSend.input.checked ? 'on' : 'off'));
  const names = voice.voices();
  const voiceName = names.length ? selectField('声', names.map((v) => [v.name, v.name]), voice.chosenVoice()?.name) : null;
  voiceName?.input.addEventListener('change', () => voice.save('name', voiceName.input.value));
  const rate = selectField('読み上げの速さ', [['0.8', 'ゆっくり'], ['1', 'ふつう'], ['1.2', '少し速い'], ['1.5', '速い']], String(conf.rate));
  rate.input.addEventListener('change', () => voice.save('rate', rate.input.value));
  const amount = selectField('自動の読み上げ', [['short', '要点だけ'], ['full', 'すべて']], conf.length);
  amount.input.addEventListener('change', () => voice.save('length', amount.input.value));
  const auto = checkField('回答を自動で読み上げる', conf.auto);
  auto.input.addEventListener('change', () => voice.save('auto', auto.input.checked ? 'on' : 'off'));
  return h('div', { className: 'stack' },
    panel('三成に相談する', note('記録を計算して答える仕組みです。生成AIではないため、決まった種類の質問に答えます。質問も記録も外部に送りません。', 'message'),
      note('収支・項目や店ごとの支出・前の期間との比較・多い順・支払いの予定・資産・予算・貯蓄などを聞けます。続けて「先月は？」のように聞くこともできます。'),
      note(mic ? '「声で質問する」を使うときだけ、マイクを使います。キーボードのマイク（音声入力）でも質問できます。' : 'この開き方では、アプリの音声認識は使えません。入力欄を選んで、キーボードのマイク（音声入力）を使ってください。')),
    history.length ? h('div', { className: 'chat' }, history.map((c, i) => h('div', { className: 'turn', id: i === history.length - 1 ? 'latest-answer' : null },
      h('p', { className: 'question' }, c.question),
      h('div', { className: 'panel reply' }, h('b', {}, c.answer[0]), c.answer.slice(1).map((line) => h('p', { className: 'message' }, line)),
        h('div', { className: 'actions start' }, button('🔊', () => { if (!voice.speak(c.answer)) { message.textContent = '使える日本語の声が見つかりません。'; } }, 'outline small', { 'aria-label': `「${c.question}」の回答を読み上げる` }),
          button('削除', async () => { await app.perform(() => app.store.deleteConsultations(c.id)); app.render(); }, 'outline small', { 'aria-label': `「${c.question}」の相談を削除` })))))) : null,
    h('div', { className: 'panel ask-box' }, mic, hearing, h('form', { onsubmit: (e) => { e.preventDefault(); ask(input.value); } }, input, h('div', { className: 'actions' }, button('読み上げ停止', () => { app.talking = false; voice.stop(); ear.stop(); }, 'outline small'), send)), message,
      h('div', { className: 'chips' }, EXAMPLES.map((q) => h('div', { className: 'chip' }, button(q, () => ask(q), 'chip-name'))))),
    panel('音声と履歴', voiceName?.element ?? note('日本語の声は、端末が対応している場合に使えます。'), rate.element, auto.element, amount.element, mic ? [autoSend.element, talk.element] : null,
      mic && ear.consented() ? h('div', { className: 'actions start' }, button('ブラウザの音声認識の同意を取り消す', () => { ear.consent(false); ear.stop(); app.render(); }, 'outline', { id: 'revoke-voice' })) : null,
      history.length ? h('div', { className: 'actions start' }, button('相談の履歴をすべて削除', async () => {
        if (!(await confirmSheet('相談の履歴をすべて削除しますか？', '質問と回答の内容を消します。元に戻せません。', 'すべて削除する'))) return;
        await app.perform(() => app.store.deleteConsultations()); app.render();
      }, 'danger', { id: 'delete-history' })) : null));
}

/** 音声が外部に送られることがある認識を使う前の確認 */
function consentSheet(app, then) {
  sheet('音声認識の確認', (close) => h('div', {},
    note('この端末では、端末の中だけでの音声認識が使えるか確認できませんでした。', 'message'),
    note('ブラウザの音声認識を使うと、話した音声が、ブラウザや端末の会社（Apple や Google など）のサーバーに送られることがあります。金額など、話した内容も含まれます。', 'note warn'),
    note('このアプリに保存した記録は送りません。送りたくない場合は「使わない」を選び、キーボードのマイクか文字で質問してください。同意は、この画面の「音声と履歴」で取り消せます。'),
    h('div', { className: 'actions' }, button('使わない', () => { app.talking = false; close(); }, 'gold', { id: 'voice-refuse' }),
      button('同意して使う', () => { ear.consent(true); close(); app.render(); document.getElementById('mic')?.click(); }, 'outline', { id: 'voice-agree' }))), { head: 'consult' });
}
