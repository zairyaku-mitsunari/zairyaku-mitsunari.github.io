// 入力画面の共通部品
import { h, button, sheet, note, confirmSheet } from './dom.js';
import * as L from '../core/ledger.js';
import { parseAmount, yen } from '../core/money.js';

export const field = (label, control) => h('label', { className: 'field' }, h('span', {}, label), control);

export function textField(label, initial = '', props = {}) {
  const input = h('input', { type: 'text', value: initial ?? '', 'aria-label': label, ...props });
  return { element: field(label, input), input, value: () => input.value.trim() };
}

/** 金額の欄。空欄は「未入力」（null）。 */
export function moneyField(label, initial = null, { negative = false } = {}) {
  const input = h('input', { type: 'text', inputMode: negative ? 'text' : 'numeric', value: initial == null ? '' : String(initial), placeholder: '未入力', 'aria-label': label });
  const hint = h('small', { className: 'hint' });
  function read() {
    let text = input.value.trim();
    if (!text) return { value: null };
    let sign = 1;
    if (negative && /^[-−－]/.test(text)) { sign = -1; text = text.slice(1); }
    if (/^[¥￥]?[0０]+円?$/.test(text)) return { value: 0 };
    const parsed = parseAmount(text);
    return parsed.value ? { value: sign * parsed.value } : { error: parsed.error };
  }
  const show = () => { const r = read(); hint.textContent = r.error ?? (r.value == null ? '' : yen(r.value)); hint.className = r.error ? 'hint error' : 'hint'; };
  input.addEventListener('input', show);
  show();
  return { element: h('div', {}, field(label, input), hint), input, value: () => read().value ?? null, valid: () => !read().error };
}

export function dateField(label, initial = '') {
  const input = h('input', { type: 'date', value: initial ?? '', 'aria-label': label });
  return { element: field(label, input), input, value: () => input.value || null };
}

export function selectField(label, options, initial = '') {
  const input = h('select', { 'aria-label': label }, options.map(([value, text]) => h('option', { value }, text)));
  input.value = initial ?? '';
  return { element: field(label, input), input, value: () => input.value || null };
}

export function checkField(label, initial = false) {
  const input = h('input', { type: 'checkbox', checked: initial, 'aria-label': label });
  return { element: h('label', { className: 'check' }, input, h('span', {}, label)), input, value: () => input.checked };
}

export function accountField(app, label, initial = '', { keep } = {}) {
  const list = L.live(app.store.data.accounts).filter((a) => !a.isArchived || a.id === initial || a.id === keep);
  return selectField(label, [['', '未選択'], ...list.map((a) => [a.id, a.name])], initial);
}

/** 支払い方法（口座かカードのどちらか） */
export function sourceField(app, initialAccount, initialCard) {
  const { data } = app.store;
  const option = (prefix, x) => h('option', { value: `${prefix}:${x.id}` }, x.name);
  const input = h('select', { 'aria-label': '支払い方法' }, h('option', { value: '' }, '未入力'),
    h('optgroup', { label: '口座・現金' }, L.live(data.accounts).filter((a) => !a.isArchived || a.id === initialAccount).map((a) => option('account', a))),
    h('optgroup', { label: 'クレジットカード' }, L.live(data.cards).filter((c) => !c.isArchived || c.id === initialCard).map((c) => option('card', c))));
  input.value = initialCard ? `card:${initialCard}` : initialAccount ? `account:${initialAccount}` : '';
  return { element: field('支払い方法', input), input, value: () => { const [prefix, id] = input.value.split(':'); return { accountID: prefix === 'account' ? id : null, cardID: prefix === 'card' ? id : null }; } };
}

/**
 * 入力画面。fields を並べ、保存（失敗したら理由を表示して閉じない）と、必要なら削除。
 * save() は例外で失敗を知らせる。
 */
export function editorSheet(app, title, build, options = {}) {
  sheet(title, (close) => {
    const { content, save, saveText = '保存', remove } = build(close);
    const failure = h('p', { className: 'error', role: 'alert' });
    const submit = button(saveText, async () => {
      if (submit.disabled) return;
      submit.disabled = true;
      try { await save(); close(); app.render(); } catch (error) { failure.textContent = error.message; submit.disabled = false; }
    }, 'gold', { id: 'save' });
    const form = h('form', { onsubmit: (e) => { e.preventDefault(); submit.click(); }, oninput: () => { failure.textContent = ''; submit.disabled = false; } }, content, failure,
      h('div', { className: 'actions' },
        remove ? button(remove.text ?? '削除', async () => {
          if (!(await confirmSheet(remove.title, remove.message, remove.confirm ?? '削除する'))) return;
          try { await remove.run(); close(); app.render(); } catch (error) { failure.textContent = error.message; }
        }, 'danger', { id: 'delete' }) : null,
        button('キャンセル', close), submit));
    return form;
  }, options);
}

/** 未入力の欄があって保存できないときの例外 */
export function requireValid(...fields) {
  if (fields.some((f) => f.valid && !f.valid())) throw new Error('金額は整数の数字で入力してください。');
}
export { note };
