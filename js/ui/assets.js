// 資産管理：口座・カード・固定費・保険・サブスク・負債の追加と編集
import { h, button, sheet, panel, row, note, screenHead } from './dom.js';
import { field, textField, moneyField, dateField, selectField, checkField, accountField, sourceField, editorSheet, requireValid } from './form.js';
import { categoryPicker } from './picker.js';
import { entryRow } from './screens.js';
import { paymentsView } from './payments.js';
import { calendarView } from './calendar.js';
import * as L from '../core/ledger.js';
import * as F from '../core/finance.js';
import * as S from '../core/schedule.js';
import { yen, signed } from '../core/money.js';
import { today, addDays, monthTitle, shortRange, weekdayName } from '../core/date.js';

const TABS = [['accounts', '口座'], ['cards', 'カード'], ['fixed', '固定費'], ['insurance', '保険'], ['subscription', 'サブスク'], ['loan', '負債'], ['payments', '支払い予定'], ['calendar', 'カレンダー']];
const dayOptions = [['', '未入力'], ...Array.from({ length: 31 }, (_, i) => [String(i + 1), i === 30 ? '月末' : `${i + 1}日`])];
const int = (v) => (v == null ? null : Number(v));
const editButton = (label, onClick, text = '編集') => button(text, onClick, 'outline small', { 'aria-label': label });
const title = (text, ...controls) => h('div', { className: 'panel-head' }, h('h2', {}, text), ...controls);

export function assetsView(app) {
  const { data } = app.store;
  const now = today();
  const assets = F.totalAssets(data, now);
  const debt = S.liabilities(data);
  const tab = app.assetTab;
  const body = tab === 'accounts' ? accounts(app, now) : tab === 'cards' ? cards(app, now) : tab === 'payments' ? paymentsView(app) : tab === 'calendar' ? calendarView(app) : recurring(app, tab, now);
  const schedule = tab === 'payments' || tab === 'calendar';
  const notes = [assets.unknown ? `初期残高が未入力の口座${assets.unknown}件は総資産に含みません。` : null,
    debt.unknownLoans ? `元本残高が未入力の負債${debt.unknownLoans}件は含みません。` : null,
    L.live(data.cards).some((c) => !F.isConfigured(c)) ? '締め日が未設定のカードは未払いに含みません。' : null].filter(Boolean);
  return h('div', { className: 'screen' },
    screenHead(tab),
    schedule ? null : panel(null, row('総資産（今日時点）', assets.amount == null ? '未入力' : yen(assets.amount), 'large income'),
      row('負債（カード未払い＋ローン残高）', yen(debt.total), 'expense'),
      row('純資産', assets.amount == null ? '未入力' : yen(assets.amount - debt.total), 'large net'), notes.map((n) => note(n))),
    h('div', { className: 'tabs' }, TABS.map(([id, text]) => button(text, () => app.go('assets', id), id === tab ? 'gold' : 'outline', { 'aria-pressed': String(id === tab), 'data-tab': id }))),
    body);
}

// ---- 口座

function accounts(app, now) {
  const { data } = app.store;
  const without = L.live(data.transactions).filter((t) => !t.accountID && !t.cardID).length;
  return h('div', { className: 'stack' },
    h('div', { className: 'actions start' }, button('口座を追加', () => accountEditor(app), 'gold'), button('振替・チャージ', () => transferEditor(app))),
    without ? note(`支払い方法・入金先が未入力の記録が${without}件あります。残高には反映されません。`, 'note warn') : null,
    h('div', { className: 'cards' }, L.live(data.accounts).sort((a, b) => Number(a.isArchived) - Number(b.isArchived) || a.sortOrder - b.sortOrder).map((a) => {
      const value = F.balance(data, a, now);
      return h('section', { className: 'panel' }, title(a.name, a.isArchived ? h('small', {}, '非表示') : null, editButton(`口座${a.name}を編集`, () => accountEditor(app, a))),
        row(S.ACCOUNT_TYPES[a.type] ?? 'その他', value == null ? '残高は未入力' : yen(value), 'large'), a.openingDay ? note(`基準日 ${a.openingDay} から計算`) : null);
    })));
}

function accountEditor(app, account = null) {
  editorSheet(app, account ? '口座の編集' : '口座の追加', () => {
    const name = textField('口座の名前', account?.name, { placeholder: '例：〇〇銀行 普通' });
    const type = selectField('種類', Object.entries(S.ACCOUNT_TYPES), account?.type ?? 'bank');
    const balance = moneyField('初期残高（円）', account?.openingBalance, { negative: true });
    const day = dateField('基準日（任意）', account?.openingDay);
    const hidden = checkField('非表示にする（入力の候補から外す。残高は総資産に残る）', account?.isArchived);
    return {
      content: [name.element, type.element, balance.element, day.element,
        note('基準日の朝の残高を入力します。基準日以降の記録を足し引きして現在の残高を計算します。空欄なら、すべての記録を反映します。'), account ? hidden.element : null],
      save: async () => {
        requireValid(balance);
        await app.store.saveAccount({ name: name.value(), type: type.value(), openingBalance: balance.value(), openingDay: day.value(), isArchived: account ? hidden.value() : false }, account?.id);
      },
    };
  }, { head: 'accounts' });
}

export function transferEditor(app, entry = null) {
  editorSheet(app, entry ? '振替の編集' : '振替・チャージ', () => {
    const from = accountField(app, '振替元（出る口座）', entry?.accountID);
    const to = accountField(app, '振替先（入る口座）', entry?.destinationAccountID);
    const amount = moneyField('金額（円）', entry?.amount);
    const day = dateField('日付', entry?.day ?? today());
    const memo = textField('メモ', entry?.memo);
    return {
      content: [from.element, to.element, amount.element, day.element, memo.element, note('口座の間でお金を動かすだけなので、収入にも支出にも数えません。')],
      save: async () => { requireValid(amount); await app.store.saveTransfer({ from: from.value(), to: to.value(), amount: amount.value(), day: day.value(), memo: memo.value() }, entry?.id); },
      remove: entry ? deletion(app, entry) : null,
    };
  }, { head: 'input' });
}

const deletion = (app, entry) => ({
  title: 'この記録を削除しますか？', message: `${entry.day}　${L.kindTitle[entry.kind]}　${yen(entry.amount)}`,
  run: async () => { await app.store.deleteTransaction(entry.id); app.deleted = entry.id; },
});

export function cardPaymentEditor(app, entry) {
  editorSheet(app, '引き落としの編集', () => {
    const account = accountField(app, '引き落とし口座', entry.accountID);
    const amount = moneyField('金額（円）', entry.amount);
    const day = dateField('引き落とし日', entry.day);
    const memo = textField('メモ', entry.memo);
    return {
      content: [note(`${L.find(app.store.data.cards, entry.cardID)?.name ?? 'カード'}　${entry.billingMonth ? monthTitle(entry.billingMonth) : ''}締め分`, 'message'), account.element, amount.element, day.element, memo.element],
      save: async () => { requireValid(amount); await app.store.saveCardPayment({ cardID: entry.cardID, closingMonth: entry.billingMonth, accountID: account.value(), amount: amount.value(), day: day.value(), memo: memo.value() }, entry.id); },
      remove: deletion(app, entry),
    };
  }, { head: 'cards' });
}

// ---- カード

function cards(app, now) {
  const { data } = app.store;
  const range = F.periodRange(app.month, data);
  return h('div', { className: 'stack' },
    h('div', { className: 'actions start' }, button('カードを追加', () => cardEditor(app), 'gold')),
    note('カード番号・暗証番号・セキュリティコードは保存しません。土日祝の引き落とし日の変更は、請求の画面で直せます。'),
    h('div', { className: 'cards' }, L.live(data.cards).sort((a, b) => a.sortOrder - b.sortOrder).map((card) => {
      const bills = F.bills(data, card);
      const open = bills.filter((b) => !b.settled && b.remaining > 0);
      const sum = (list) => list.reduce((s, b) => s + b.remaining, 0);
      const next = open.filter((b) => b.paymentDay >= now).sort((a, b) => (a.paymentDay < b.paymentDay ? -1 : 1))[0];
      const overdue = open.filter((b) => b.paymentDay < now).length;
      return h('section', { className: 'panel' }, title(card.name, card.isArchived ? h('small', {}, '非表示') : null, editButton(`${card.name}の設定`, () => cardEditor(app, card), '設定')),
        row(`利用額（${shortRange(range)}）`, yen(L.cardUsage(data, range, 'all', card.id)), 'large'),
        F.isConfigured(card) ? [row('未確定の請求', yen(sum(open.filter((b) => b.confirmed == null)))), row('確定した請求（未払い）', yen(sum(open.filter((b) => b.confirmed != null)))),
          row('次回の引き落とし', next ? `${next.paymentDay}　${yen(next.remaining)}` : '予定なし'),
          card.creditLimit != null ? row('利用可能額（限度額−未払い）', yen(card.creditLimit - sum(open))) : null,
          overdue ? note(`引き落とし日を過ぎて記録がない請求が${overdue}件`, 'note warn') : null]
          : note('締め日・引き落とし日を設定すると、請求額と引き落とし予定を計算します。'),
        h('div', { className: 'actions start' }, button('請求と利用履歴', () => cardDetail(app, card.id), 'outline', { 'aria-label': `${card.name}の請求と利用履歴` })));
    })));
}

function cardEditor(app, card = null) {
  editorSheet(app, card ? 'カードの設定' : 'カードの追加', () => {
    const name = textField('カードの名前', card?.name, { list: 'card-names' });
    const presets = selectField('候補から名前を選ぶ', [['', '—'], ...['イオンカード', '三井住友カード', 'JCBカード'].map((n) => [n, n])]);
    presets.input.addEventListener('change', () => { if (presets.input.value) name.input.value = presets.input.value; });
    const closing = selectField('締め日', dayOptions, card?.closingDay != null ? String(card.closingDay) : '');
    const offset = selectField('引き落とし月', [['', '未入力'], ['0', '締め日と同じ月'], ['1', '翌月'], ['2', '翌々月']], card?.paymentMonthOffset != null ? String(card.paymentMonthOffset) : '');
    const payment = selectField('引き落とし日', dayOptions, card?.paymentDay != null ? String(card.paymentDay) : '');
    const account = accountField(app, '引き落とし口座', card?.withdrawalAccountID);
    const limit = moneyField('利用可能額・限度額（円）', card?.creditLimit);
    const fee = moneyField('年会費（円）', card?.annualFee);
    const hidden = checkField('非表示にする（入力の候補から外す）', card?.isArchived);
    return {
      content: [name.element, card ? null : presets.element, closing.element, offset.element, payment.element, account.element, limit.element, fee.element, card ? hidden.element : null],
      save: async () => {
        requireValid(limit, fee);
        await app.store.saveCard({ name: name.value(), closingDay: int(closing.value()), paymentDay: int(payment.value()), paymentMonthOffset: int(offset.value()),
          withdrawalAccountID: account.value(), creditLimit: limit.value(), annualFee: fee.value(), isArchived: card ? hidden.value() : false }, card?.id);
      },
    };
  }, { head: 'cards' });
}

export function cardDetail(app, cardID) {
  sheet('請求と利用履歴', (close) => {
    const body = h('div', { className: 'stack' });
    function draw(open = null) {
      const { data } = app.store;
      const card = L.find(data.cards, cardID);
      const bills = F.bills(data, card).reverse();
      const history = L.live(data.transactions).filter((t) => t.cardID === cardID).sort(L.newestFirst);
      body.replaceChildren(h('h3', {}, card.name),
        !F.isConfigured(card) ? note('締め日・引き落とし日が未設定のため、請求は計算していません。', 'message') : !bills.length ? note('このカードの利用はまだありません。', 'message') : '',
        ...bills.map((bill) => billPanel(app, card, bill, open, draw)),
        panel('利用履歴', history.slice(0, 100).map((t) => entryRow(app, t, () => { close(); app.edit(t); })), history.length ? null : note('記録はありません。')));
    }
    draw();
    return h('div', {}, body, h('div', { className: 'actions' }, button('閉じる', () => { close(); app.render(); }, 'gold')));
  }, { className: 'full', head: 'cards' });
}

function billPanel(app, card, bill, open, draw) {
  const now = today();
  const start = addDays(F.periodStart(card, bill.month), 0);
  const end = F.closingDate(card, bill.month);
  const status = bill.settled ? '支払い済み' : now > end ? '締め済み・未払い' : '利用中（未締め）';
  const form = open?.month === bill.month ? billForm(app, card, bill, open.kind, draw) : null;
  return h('section', { className: 'panel' }, title(`${monthTitle(bill.month)}締め分`, h('small', { className: bill.settled ? 'done' : 'warn-text' }, status)),
    row('利用期間', `${start} 〜 ${end}`), row('引き落とし日', bill.paymentDay), row('記録した利用の合計', yen(bill.usage)),
    row('確定請求額', bill.confirmed == null ? '未確定' : yen(bill.confirmed)),
    bill.confirmed != null && bill.confirmed !== bill.usage ? note(`記録との差 ${signed(bill.confirmed - bill.usage)}。利用の記録もれや手数料がないか確認してください（自動では支出に足しません）。`, 'note warn') : null,
    row('支払い済み', yen(bill.paid)), row('残り', yen(bill.remaining), 'large'),
    h('div', { className: 'actions start' },
      button('請求額を確定・修正', () => draw({ month: bill.month, kind: 'confirm' }), 'outline', { 'aria-label': `${monthTitle(bill.month)}締め分の請求額を確定` }),
      !bill.settled && bill.remaining > 0 ? button('引き落としを記録', () => draw({ month: bill.month, kind: 'pay' }), 'outline', { 'aria-label': `${monthTitle(bill.month)}締め分の引き落としを記録` }) : null),
    form);
}

function billForm(app, card, bill, kind, draw) {
  const now = today();
  const amount = moneyField(kind === 'confirm' ? '実際の請求額（空欄で未確定）' : '引き落とし額（円）', Math.max(0, kind === 'confirm' ? bill.confirmed ?? bill.usage : bill.remaining));
  const day = dateField(kind === 'confirm' ? '実際の引き落とし日' : '引き落とした日', kind === 'confirm' ? bill.paymentDay : bill.paymentDay < now ? bill.paymentDay : now);
  const account = accountField(app, '引き落とし口座', card.withdrawalAccountID);
  const confirms = checkField('この金額を確定請求額にする', true);
  const failure = h('p', { className: 'error', role: 'alert' });
  const submit = button(kind === 'confirm' ? '確定する' : '記録する', async () => {
    submit.disabled = true;
    try {
      requireValid(amount);
      if (kind === 'confirm') await app.store.setStatement(card.id, bill.month, amount.value(), day.value() === F.nominalPaymentDate(card, bill.month) ? null : day.value());
      else await app.store.saveCardPayment({ cardID: card.id, closingMonth: bill.month, accountID: account.value(), amount: amount.value() ?? 0, day: day.value(), confirms: bill.confirmed == null && confirms.value() });
      draw();
    } catch (error) { failure.textContent = error.message; submit.disabled = false; }
  }, 'gold', { id: 'bill-submit' });
  return h('div', { className: 'subform' }, amount.element, day.element, kind === 'pay' ? [account.element, bill.confirmed == null ? confirms.element : null] : null, failure,
    h('div', { className: 'actions' }, button('取りやめる', () => draw()), submit));
}

// ---- 固定費・保険・サブスク・負債

const PRESETS = {
  fixed: ['住宅ローン', '家賃', '電気代', 'ガス代', '水道代', '携帯電話料金', 'インターネット料金'],
  subscription: ['ChatGPT', 'Claude', 'Gemini', 'Canva', 'Suno'],
};

function recurring(app, kind, now) {
  const { data } = app.store;
  const list = L.live(data.recurringCosts).filter((c) => c.kind === kind).sort((a, b) => Number(!a.isActive) - Number(!b.isActive) || a.createdAt - b.createdAt);
  const total = S.plannedTotal(list, now);
  const due = S.unpaid(data, addDays(now, 45), (c) => c.kind === kind && c.deletedAt == null);
  const presets = PRESETS[kind] ? selectField('候補から追加', [['', '—'], ...PRESETS[kind].map((n) => [n, n])]) : null;
  presets?.input.addEventListener('change', () => { if (presets.input.value) recurringEditor(app, kind, null, presets.input.value); presets.input.value = ''; });
  return h('div', { className: 'stack' },
    h('div', { className: 'actions start' }, button(`${S.KINDS[kind]}を追加`, () => recurringEditor(app, kind), 'gold', { id: 'add-recurring' }), presets?.element),
    panel(null, row('月あたり（予定額を換算）', yen(total.monthly), 'large'), row('1年あたり（予定額）', yen(total.yearly)),
      note(`予定の金額から計算した目安です。実際の支払いは取引履歴で確認してください。${total.unknown ? `金額が未入力の${total.unknown}件は含みません。` : ''}`)),
    due.length ? panel('支払い予定（45日以内と記録のない過去分）', due.slice(0, 24).map((o) => {
      const cost = data.recurringCosts.find((c) => c.id === o.recurringID);
      return h('div', { className: 'due' }, h('span', {}, h('b', {}, cost.name), h('small', { className: o.dueDay < now ? 'warn-text' : '' }, `${o.dueDay}（${weekdayName(o.dueDay)}）${o.dueDay < now ? '・期限を過ぎています' : ''}`)),
        h('span', {}, cost.plannedAmount == null ? '金額未定' : yen(cost.plannedAmount)), button('支払い', () => paymentSheet(app, o), 'outline small', { 'aria-label': `${cost.name} ${o.dueDay}の支払いを記録` }));
    })) : null,
    list.length ? h('div', { className: 'cards' }, list.map((c) => recurringPanel(app, c, now))) : panel(null, note('まだ登録がありません。', 'message')));
}

function recurringPanel(app, cost, now) {
  const { data } = app.store;
  const next = S.nextUnpaid(data, cost, now);
  const extra = [];
  if (cost.insurance) {
    const d = cost.insurance;
    extra.push(row(d.type === 'other' && d.customType ? d.customType : S.INSURANCE[d.type], d.company || '保険会社は未入力'));
    if (d.insured) extra.push(row('被保険者', d.insured));
    if (d.renewalDay) extra.push(row('更新日', d.renewalDay));
    if (cost.endDay) extra.push(row('満了日', cost.endDay));
  }
  if (cost.subscription) {
    const d = cost.subscription;
    if (d.plan) extra.push(row('プラン', d.plan));
    if (d.trialEndDay) extra.push(row('無料期間の終了', d.trialEndDay));
    extra.push(row('利用頻度', S.USAGE[d.usage] ?? '未入力'));
  }
  if (cost.loan) {
    const balance = S.loanBalance(data, cost);
    extra.push(row('元本残高', balance ? yen(balance.amount) : '未入力', 'expense'));
    if (balance?.missing) extra.push(note(`元本の内訳が未入力の返済が${balance.missing}件あり、残高に反映していません。`, 'note warn'));
    if (cost.loan.annualRateMilli != null) extra.push(row('年利', `${rateText(cost.loan.annualRateMilli)}%`));
  }
  return h('section', { className: 'panel' }, title(cost.name, cost.isActive ? null : h('small', {}, '解約・停止'), editButton(`${cost.name}を編集`, () => recurringEditor(app, cost.kind, cost))),
    row(`予定額（${S.CYCLES[cost.cycle]}）`, cost.plannedAmount == null ? '未入力' : yen(cost.plannedAmount), 'large'),
    row('次の支払い予定', next?.dueDay ?? 'なし'), row('支払い方法', S.paymentMethod(data, cost)), extra);
}

const rateText = (milli) => `${Math.floor(milli / 1000)}.${String(milli % 1000).padStart(3, '0')}`;
function parseRate(text) {
  const m = text.match(/^(\d{1,3})(?:\.(\d{1,3}))?$/);
  if (!m || +m[1] > 100) return undefined;
  return +m[1] * 1000 + Number((m[2] ?? '').padEnd(3, '0'));
}

export function recurringEditor(app, kind, cost = null, preset = '', defaults = {}) {
  editorSheet(app, `${S.KINDS[kind]}の${cost ? '編集' : '登録'}`, () => {
    const { data } = app.store;
    let categoryID = cost?.categoryID ?? (preset ? L.selectable(data, 'expense').find((c) => c.name === preset)?.id : null) ?? null;
    const name = textField('名前', cost?.name ?? preset);
    const categoryButton = button('', () => categoryPicker(app, 'expense', categoryID, (id) => { categoryID = id; show(); }), 'select', { id: 'recurring-category' });
    const show = () => { categoryButton.textContent = categoryID ? L.categoryPath(app.store.data, categoryID) : '項目を選んでください ›'; };
    show();
    const amount = moneyField('1回の予定額（円）', cost?.plannedAmount);
    const cycle = selectField('支払い周期', Object.entries(S.CYCLES), cost?.cycle ?? defaults.cycle ?? 'monthly');
    const first = dateField('最初の支払い予定日', cost?.firstDueDay ?? today());
    const source = sourceField(app, cost?.accountID, cost?.cardID);
    const scope = selectField('区分', [['personal', '個人用'], ['business', '事業用']], cost?.scope ?? 'personal');
    const active = checkField('契約中（支払い予定を作る）', cost?.isActive ?? true);
    const end = dateField(kind === 'insurance' ? '満了日（任意）' : '終了日（任意）', cost?.endDay);
    const memo = textField('メモ', cost?.memo);
    const money = [amount];
    const content = [name.element, h('div', { className: 'field' }, h('span', {}, '支出項目'), categoryButton), amount.element, cycle.element, first.element, source.element, scope.element, active.element, end.element];
    let detail = () => ({});
    const section = (text) => content.push(h('h3', {}, text));
    const add = (...fields) => content.push(...fields.map((f) => f.element));
    if (kind === 'subscription') {
      const d = cost?.subscription ?? {};
      const plan = textField('契約プラン', d.plan), trial = dateField('無料期間の終了日', d.trialEndDay), purpose = textField('利用目的', d.purpose);
      const usage = selectField('利用頻度', [['', '未入力'], ...Object.entries(S.USAGE)], d.usage ?? '');
      section('サブスク'); add(plan, trial, purpose, usage);
      detail = () => ({ subscription: { plan: plan.value(), trialEndDay: trial.value(), purpose: purpose.value(), usage: usage.value() } });
    }
    if (kind === 'insurance') {
      const d = cost?.insurance ?? {};
      const type = selectField('保険の種類', Object.entries(S.INSURANCE), d.type ?? 'life');
      const texts = Object.fromEntries([['customType', '種類の名前（その他のとき）'], ['company', '保険会社名'], ['policyholder', '契約者'], ['insured', '被保険者'], ['target', '対象の車・住宅'],
        ['coverage', '保障内容'], ['riders', '特約'], ['exclusions', '免責事項'], ['contact', '担当者の連絡先']].map(([k, label]) => [k, textField(label, d[k])]));
      const coverage = moneyField('保障金額（円）', d.coverageAmount), surrender = moneyField('解約返戻金（円）', d.surrenderValue);
      const renewal = dateField('更新日', d.renewalDay), review = dateField('見直しの時期', d.reviewDay);
      money.push(coverage, surrender);
      section('契約内容'); add(type, texts.customType, texts.company, texts.policyholder, texts.insured, texts.target, renewal, review);
      section('保障'); add(texts.coverage, coverage, texts.riders, texts.exclusions, surrender, texts.contact);
      content.push(note('保険の内容はこの端末にだけ保存し、外部には送りません。解約や変更は自動では行いません。'));
      detail = () => ({ insurance: { type: type.value(), ...Object.fromEntries(Object.entries(texts).map(([k, f]) => [k, f.value()])), coverageAmount: coverage.value(), surrenderValue: surrender.value(), renewalDay: renewal.value(), reviewDay: review.value() } });
    }
    if (kind === 'loan') {
      const d = cost?.loan ?? {};
      const lender = textField('借入先', d.lender), borrowed = moneyField('借入金額（円）', d.borrowedAmount), borrowedDay = dateField('借入日', d.borrowedDay);
      const rate = textField('年利（%）', d.annualRateMilli != null ? rateText(d.annualRateMilli) : '', { placeholder: '例：1.475', inputMode: 'decimal' });
      const balance = moneyField('元本残高（円）', d.principalBalance), balanceDay = dateField('残高の基準日', d.balanceDay);
      money.push(borrowed, balance);
      section('借入'); add(lender, borrowed, borrowedDay, rate, balance, balanceDay);
      content.push(note('残高は、支払いを記録するときに入力した元本の分だけ減ります。利息や将来の残高は推測しません。'));
      detail = () => {
        const value = rate.value() ? parseRate(rate.value()) : null;
        if (value === undefined) throw new Error('年利は 1.475 のように入力してください（小数第3位まで）。');
        return { loan: { lender: lender.value(), borrowedAmount: borrowed.value(), borrowedDay: borrowedDay.value(), annualRateMilli: value, principalBalance: balance.value(), balanceDay: balanceDay.value() } };
      };
    }
    content.push(memo.element);
    return {
      content,
      save: async () => {
        requireValid(...money);
        await app.store.saveRecurring({ kind, name: name.value(), categoryID, plannedAmount: amount.value(), cycle: cycle.value(), firstDueDay: first.value(), endDay: end.value(),
          isActive: active.value(), scope: scope.value(), ...source.value(), memo: memo.value(), ...detail() }, cost?.id);
      },
      remove: cost ? { title: `「${cost.name}」の予定を削除しますか？`, message: '予定を削除します。支払いとして記録した支出は残ります。', run: () => app.store.deleteRecurring(cost.id) } : null,
    };
  }, { head: kind });
}

export function paymentSheet(app, occurrence) {
  const cost = app.store.data.recurringCosts.find((c) => c.id === occurrence.recurringID);
  editorSheet(app, '支払いの記録', () => {
    const { data } = app.store;
    const now = today();
    let categoryID = cost.categoryID ?? null;
    const method = selectField('記録のしかた', [['new', '新しく記録する'], ['link', '登録済みの支出を使う'], ['skip', '今回は払わない']], 'new');
    const amount = moneyField('支払った金額（円）', cost.plannedAmount);
    const day = dateField('支払った日', occurrence.dueDay < now ? occurrence.dueDay : now);
    const source = sourceField(app, cost.accountID, cost.cardID);
    const categoryButton = button('', () => categoryPicker(app, 'expense', categoryID, (id) => { categoryID = id; show(); }), 'select', { id: 'pay-category' });
    const show = () => { categoryButton.textContent = categoryID ? L.categoryPath(app.store.data, categoryID) : '項目を選んでください ›'; };
    show();
    const from = addDays(occurrence.dueDay, -45), to = addDays(occurrence.dueDay, 45);
    const candidates = L.live(data.transactions).filter((t) => t.kind === 'expense' && t.day >= from && t.day <= to && !S.isLinked(data, t.id))
      .sort((a, b) => Number(a.categoryID !== cost.categoryID) - Number(b.categoryID !== cost.categoryID) || L.newestFirst(a, b));
    const linked = selectField('支出', [['', '選んでください'], ...candidates.map((t) => [t.id, `${t.day}　${L.categoryName(data, t.categoryID)}　${yen(t.amount)}`])]);
    const principal = moneyField('うち元本（分からなければ空欄）', null);
    const parts = {
      new: h('div', {}, amount.element, day.element, source.element, h('div', { className: 'field' }, h('span', {}, '支出項目'), categoryButton),
        note('すでに支出を登録している場合は「登録済みの支出を使う」を選んでください（二重に数えないため）。')),
      link: h('div', {}, linked.element, candidates.length ? null : note('予定日の前後45日に、使える支出がありません。')),
      skip: h('div', {}, note('支出は記録せず、この回の予定だけを済みにします。', 'message')),
    };
    const area = h('div', {}, parts.new);
    const loan = cost.kind === 'loan' ? h('div', {}, principal.element) : null;
    method.input.addEventListener('change', () => { area.replaceChildren(parts[method.input.value]); if (loan) loan.hidden = method.input.value === 'skip'; });
    return {
      saveText: '記録する',
      content: [note(`${cost.name}　予定日 ${occurrence.dueDay}`, 'message'), row('予定額', cost.plannedAmount == null ? '未定' : yen(cost.plannedAmount)), method.element, area, loan],
      save: async () => {
        const kind = method.value();
        const part = cost.kind === 'loan' && kind !== 'skip' ? principal.value() : null;
        if (cost.kind === 'loan') requireValid(principal);
        if (kind === 'new') {
          requireValid(amount);
          await app.store.payRecurring(occurrence, { kind: 'expense', day: day.value(), amount: amount.value() ?? 0, categoryID, scope: cost.scope, ...source.value(), storeName: cost.name, memo: '' }, part);
        } else if (kind === 'link') {
          if (!linked.value()) throw new Error('支出を選んでください。');
          await app.store.linkRecurring(occurrence, linked.value(), part);
        } else await app.store.skipRecurring(occurrence);
      },
    };
  }, { head: 'payments' });
}
