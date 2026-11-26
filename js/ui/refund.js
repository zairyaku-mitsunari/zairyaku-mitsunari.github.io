// 返金・取消の記録と編集
import { note, row } from './dom.js';
import { moneyField, dateField, textField, sourceField, editorSheet, requireValid } from './form.js';
import * as L from '../core/ledger.js';
import { yen } from '../core/money.js';
import { today } from '../core/date.js';

/** original：返金する支出。entry：編集する返金の記録（なければ新規） */
export function refundEditor(app, original, entry = null) {
  editorSheet(app, entry ? '返金の編集' : '返金・取消の記録', () => {
    const { data } = app.store;
    const refunded = app.store.refunded(data, original.id) - (entry?.amount ?? 0);
    const remaining = original.amount - refunded;
    const amount = moneyField('返金された金額（円）', entry?.amount ?? (remaining > 0 ? remaining : null));
    const day = dateField('返金された日', entry?.day ?? today());
    const base = entry ?? original;
    const source = sourceField(app, base.accountID, base.cardID);
    const memo = textField('メモ', entry?.memo);
    return {
      saveText: entry ? '保存' : '返金を記録',
      content: [note(`${original.day}　${L.categoryName(data, original.categoryID)}${original.storeName ? `　${original.storeName}` : ''}`, 'message'),
        row('支払った金額', yen(original.amount)), refunded ? row('ほかの返金', yen(refunded)) : null, row('返金できる残り', yen(remaining)),
        amount.element, day.element, source.element, memo.element,
        note('返金は、返金された日の支出を減らします。収入にはしません。カードへの返金は、そのカードの請求から引きます。')],
      save: async () => {
        requireValid(amount);
        const draft = { amount: amount.value() ?? 0, day: day.value(), ...source.value(), memo: memo.value() };
        if (entry) await app.store.updateTransaction(entry.id, { ...entry, ...draft });
        else await app.store.addRefund(original.id, draft);
      },
      remove: entry ? { title: 'この返金の記録を削除しますか？', message: `${entry.day}　${yen(entry.amount)}`,
        run: async () => { await app.store.deleteTransaction(entry.id); app.deleted = entry.id; } } : null,
    };
  }, { head: 'input' });
}
