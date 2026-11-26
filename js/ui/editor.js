// 収入・支出の登録と編集、項目の選択と作成
import { h, button, sheet, note, confirmSheet } from './dom.js';
import * as L from '../core/ledger.js';
import { parseAmount, yen } from '../core/money.js';
import { today, isDay } from '../core/date.js';
import { monthContaining } from '../core/finance.js';
import { categoryPicker } from './picker.js';
import { openImport, openReceipt } from './import.js';
import { transferEditor, cardPaymentEditor } from './assets.js';
import { refundEditor } from './refund.js';

export function openEditor(app, { kind = 'expense', entry = null } = {}) {
  const data = () => app.store.data;
  if (entry?.kind === 'transfer') return transferEditor(app, entry);
  if (entry?.kind === 'cardPayment') return cardPaymentEditor(app, entry);
  if (entry?.kind === 'refund') {
    const original = app.store.data.transactions.find((t) => t.id === entry.refundOfID && t.deletedAt == null);
    return original ? refundEditor(app, original, entry) : openOrphanRefund(app, entry);
  }
  const state = entry ? { ...entry } : { kind, day: today(), categoryID: null, scope: app.scope === 'business' ? 'business' : 'personal' };

  sheet(entry ? `${L.kindTitle[state.kind]}の編集` : `${L.kindTitle[state.kind]}の登録`, (close) => {
    const message = h('p', { className: 'error', role: 'alert' });
    const preview = h('p', { className: 'note' });
    const amount = h('input', { type: 'text', inputMode: 'numeric', placeholder: '例：1200', value: entry ? String(entry.amount) : '', className: 'amount', 'aria-label': '金額（円）', oninput: () => refresh() });
    const day = h('input', { type: 'date', value: state.day, 'aria-label': '日付', oninput: () => refresh() });
    const categoryButton = button('', () => categoryPicker(app, state.kind, state.categoryID, (id) => {
      state.categoryID = id;
      const preset = L.find(data().categories, id)?.defaultScope;
      if (!entry && preset) { state.scope = preset; scope.value = preset; }
      refresh();
    }), 'select', { id: 'category-button' });
    const kindSelect = h('select', { 'aria-label': '種類', onchange: () => { state.kind = kindSelect.value; state.categoryID = null; drawSources(); refresh(); } },
      h('option', { value: 'expense' }, '支出'), h('option', { value: 'income' }, '収入'));
    kindSelect.value = state.kind;
    const scope = h('select', { 'aria-label': '区分', onchange: () => { state.scope = scope.value; } }, h('option', { value: 'personal' }, '個人用'), h('option', { value: 'business' }, '事業用'));
    scope.value = state.scope;
    const source = h('select', { 'aria-label': '支払い方法・入金先' });
    function drawSources() {
      const value = source.value || (state.cardID ? `card:${state.cardID}` : state.accountID ? `account:${state.accountID}` : '');
      const option = (prefix, x) => h('option', { value: `${prefix}:${x.id}` }, x.name);
      const accounts = L.live(data().accounts).filter((a) => !a.isArchived || a.id === state.accountID);
      const cards = L.live(data().cards).filter((c) => !c.isArchived || c.id === state.cardID);
      source.replaceChildren(h('option', { value: '' }, '未入力'), h('optgroup', { label: '口座・現金' }, accounts.map((a) => option('account', a))),
        ...(state.kind === 'expense' ? [h('optgroup', { label: 'クレジットカード' }, cards.map((c) => option('card', c)))] : []));
      source.value = [...source.options].some((o) => o.value === value) ? value : '';
    }
    const store = h('input', { type: 'text', value: state.storeName ?? '', 'aria-label': '店舗名・入金元' });
    const memo = h('input', { type: 'text', value: state.memo ?? '', 'aria-label': 'メモ' });
    const save = button('保存', async () => {
      const [prefix, id] = source.value.split(':');
      const draft = { ...state, day: day.value, amount: parseAmount(amount.value).value, accountID: prefix === 'account' ? id : null,
        cardID: prefix === 'card' ? id : null, storeName: store.value, memo: memo.value };
      try {
        if (entry) await app.store.updateTransaction(entry.id, draft);
        else await app.store.addTransaction(draft);
        app.month = monthContaining(draft.day, data());
        if (app.scope !== 'all' && app.scope !== draft.scope) app.setScope(draft.scope);
        close();
        app.render();
      } catch (error) { message.textContent = error.message; }
    }, 'gold', { id: 'save' });
    function refresh() {
      const parsed = parseAmount(amount.value);
      preview.textContent = parsed.value ? yen(parsed.value) : parsed.error === 'empty' ? '' : parsed.error;
      categoryButton.textContent = state.categoryID ? L.categoryPath(data(), state.categoryID) : '項目を選んでください ›';
      save.disabled = !(parsed.value && state.categoryID && isDay(day.value));
      message.textContent = '';
    }
    drawSources();
    refresh();
    const field = (label, control) => h('label', { className: 'field' }, h('span', {}, label), control);
    const receipt = entry?.receiptID && data().receipts.find((r) => r.id === entry.receiptID);
    const refunded = entry?.kind === 'expense' ? app.store.refunded(data(), entry.id) : 0;
    return h('form', { onsubmit: (e) => { e.preventDefault(); if (!save.disabled) save.click(); } },
      entry ? null : button('レシート・明細を読み取って入力', () => { close(); openImport(app); }, 'outline wide', { id: 'open-import' }),
      receipt ? button('📎 レシートを表示', () => openReceipt(app, receipt.id), 'outline wide', { id: 'show-receipt' }) : null,
      refunded ? note(`返金の記録 ${yen(refunded)}`, 'note warn') : null,
      entry?.kind === 'expense' && refunded < entry.amount ? button('返金・取消を記録', () => { close(); refundEditor(app, entry); }, 'outline wide', { id: 'add-refund' }) : null,
      refunded ? null : field('種類', kindSelect), field('日付', day), field('金額（円）', amount), preview,
      h('div', { className: 'field' }, h('span', {}, '項目'), categoryButton),
      field('区分', scope), field('支払い方法・入金先', source), field('店舗名・入金元', store), field('メモ', memo), message,
      h('div', { className: 'actions' },
        entry ? button('削除', () => remove(app, entry, close), 'danger', { id: 'delete' }) : null,
        button('キャンセル', close), save));
  }, { head: 'input' });
}

async function remove(app, entry, close) {
  const ok = await confirmSheet('この記録を削除しますか？', `${entry.day}　${L.entryTitle(app.store.data, entry)}　${yen(entry.amount)}`, '削除する');
  if (!ok) return;
  if (await app.perform(async () => { await app.store.deleteTransaction(entry.id); return true; })) {
    app.deleted = entry.id;
    close();
    app.render();
  }
}

/** 元の支出が見つからない返金（取り込みなどで起きる）。削除だけできる。 */
function openOrphanRefund(app, entry) {
  sheet(L.kindTitle[entry.kind], (close) => h('div', {},
    note(`${entry.day}　${yen(entry.amount)}`, 'message'), note(L.sourceName(app.store.data, entry)),
    note('返金の元になる支出がないため、編集できません。不要な場合は削除してください。'),
    h('div', { className: 'actions' }, button('削除', () => remove(app, entry, close), 'danger'), button('閉じる', close, 'gold'))), { head: 'input' });
}
