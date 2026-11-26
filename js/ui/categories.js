// 項目の管理：追加・名前の変更・分類・並べ替え・非表示・削除
import { h, button, sheet, panel, note } from './dom.js';
import { textField, selectField, checkField, editorSheet } from './form.js';
import * as L from '../core/ledger.js';
import { NECESSITY, categoryUsage, usageTotal } from '../core/category-store.js';

export function categoryManager(app) {
  sheet('項目の管理', (close) => {
    const kind = h('select', { 'aria-label': '収入か支出か', onchange: () => draw() }, h('option', { value: 'expense' }, '支出の項目'), h('option', { value: 'income' }, '収入の項目'));
    const search = h('input', { type: 'search', placeholder: '項目を検索', 'aria-label': '管理する項目を検索', oninput: () => draw() });
    const body = h('div', { className: 'stack' });
    const failure = h('p', { className: 'error', role: 'alert' });
    const move = async (id, step) => { try { await app.store.moveCategory(id, step); draw(); } catch (error) { failure.textContent = error.message; } };
    function line(c) {
      const marks = [c.isHidden ? '非表示' : null, c.necessity ? NECESSITY[c.necessity] : null].filter(Boolean).join('・');
      return h('div', { className: `category-line ${c.isHidden ? 'dim' : ''}` }, h('span', {}, c.name, marks ? h('small', {}, marks) : null),
        button('↑', () => move(c.id, -1), 'step', { 'aria-label': `${c.name}を上へ` }), button('↓', () => move(c.id, 1), 'step', { 'aria-label': `${c.name}を下へ` }),
        button('編集', () => categoryEditor(app, c, draw), 'outline small', { 'aria-label': `項目${c.name}を編集` }));
    }
    function draw() {
      const { data } = app.store;
      const word = search.value.trim();
      const match = (c) => !word || c.name.includes(word);
      const groups = L.groups(data, kind.value, true);
      const sections = groups.map((g) => {
        const list = L.items(data, kind.value, g.id, true).filter((c) => match(c) || g.name.includes(word));
        if (word && !list.length && !match(g)) return null;
        return panel(null, h('div', { className: 'category-line group' }, h('h3', {}, g.name),
          button('↑', () => move(g.id, -1), 'step', { 'aria-label': `大項目${g.name}を上へ` }), button('↓', () => move(g.id, 1), 'step', { 'aria-label': `大項目${g.name}を下へ` }),
          button('編集', () => categoryEditor(app, g, draw), 'outline small', { 'aria-label': `大項目${g.name}を編集` })), list.map(line));
      }).filter(Boolean);
      const loose = L.items(data, kind.value, null, true).filter(match);
      body.replaceChildren(...sections, ...(loose.length ? [panel(groups.length ? '大項目なし' : null, loose.map(line))] : []),
        ...(sections.length || loose.length ? [] : [note('一致する項目はありません。', 'message')]));
    }
    draw();
    return h('div', {},
      note('名前を変えても、過去の記録とのつながりは変わりません。', 'message'), kind, search,
      h('div', { className: 'actions start' },
        button('項目を追加', () => categoryEditor(app, { kind: kind.value, isGroup: false }, draw), 'gold', { id: 'add-category' }),
        button('大項目を追加', () => categoryEditor(app, { kind: kind.value, isGroup: true }, draw), 'outline', { id: 'add-group' })),
      failure, body, h('div', { className: 'actions' }, button('閉じる', () => { close(); app.render(); }, 'gold')));
  }, { className: 'full', head: 'settings' });
}

function categoryEditor(app, category, done) {
  const { data } = app.store;
  const isNew = !category.id;
  const label = category.isGroup ? '大項目' : '項目';
  editorSheet(app, `${label}の${isNew ? '追加' : '編集'}`, () => {
    const name = textField(`${label}の名前`, category.name);
    const groups = L.groups(data, category.kind, true);
    const parent = category.isGroup ? null : selectField('大項目', [['', '大項目なし'], ...groups.map((g) => [g.id, g.name])], category.parentID ?? '');
    const scope = category.isGroup ? null : selectField('区分の初期値', [['', '共通'], ['personal', '個人用'], ['business', '事業用']], category.defaultScope ?? '');
    const expense = category.kind === 'expense' && !category.isGroup;
    const nature = expense ? selectField('固定費・変動費', [['', '未設定'], ['fixed', '固定費'], ['variable', '変動費']], category.costNature ?? (isNew ? 'variable' : '')) : null;
    const need = expense ? selectField('支出の分類（見直しに使います）', [['', '未分類'], ...Object.entries(NECESSITY)], category.necessity ?? '') : null;
    const hidden = isNew ? null : checkField('非表示にする（入力の候補から外す。記録は残る）', category.isHidden);
    const count = isNew || category.isGroup ? 0 : usageTotal(data, category.id);
    const others = count ? selectField('削除するときの移し替え先', [['', '選んでください'], ...L.selectable(data, category.kind).filter((c) => c.id !== category.id).map((c) => [c.id, L.categoryPath(data, c.id)])]) : null;
    const usage = count ? categoryUsage(data, category.id) : null;
    return {
      content: [name.element, parent?.element, scope?.element, nature?.element, need?.element, hidden?.element,
        count ? note(`使用中：記録${usage.entries}件、固定費など${usage.recurring}件、給料の設定${usage.incomes}件、予算${usage.budgets}件。削除する場合は、移し替え先を選ぶか、非表示にしてください。`, 'note warn') : null,
        others?.element],
      save: async () => {
        const changes = { name: name.value(), parentID: parent?.value(), defaultScope: scope?.value(), costNature: nature?.value(), necessity: need?.value() };
        if (isNew) {
          const made = category.isGroup ? await app.store.addGroup(category.kind, name.value()) : await app.store.addCategory(category.kind, name.value(), parent.value());
          if (!category.isGroup) await app.store.updateCategory(made.id, changes);
        } else {
          await app.store.updateCategory(category.id, Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)));
          if (hidden.value() !== !!category.isHidden) await app.store.setCategoryHidden(category.id, hidden.value());
        }
        done();
      },
      remove: isNew ? null : { title: `「${category.name}」を削除しますか？`, message: count ? '使っている記録と設定は、選んだ移し替え先の項目になります。記録は消えません。' : 'この項目を一覧から削除します。',
        run: async () => { await app.store.deleteCategory(category.id, others?.value() ?? null); done(); } },
    };
  }, { head: 'settings' });
}
