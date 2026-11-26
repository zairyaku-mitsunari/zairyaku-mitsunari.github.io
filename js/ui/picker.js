// 項目の選択と作成（入力画面を離れずに）
import { h, button, sheet, note } from './dom.js';
import * as L from '../core/ledger.js';

export function categoryPicker(app, kind, selected, choose, suggestedName = '') {
  sheet(`${L.kindTitle[kind]}項目を選ぶ`, (close) => {
    const search = h('input', { type: 'search', placeholder: '項目を検索（例：ガソリン）', 'aria-label': '項目を検索', oninput: () => draw() });
    const list = h('div', { className: 'picker-list' });
    const groupSelect = h('select', { 'aria-label': '大項目' }, h('option', { value: '' }, '大項目なし'),
      L.groups(app.store.data, kind).map((g) => h('option', { value: g.id }, g.name)));
    const pick = (id) => { close(); choose(id); };
    const create = button('', async () => {
      const name = search.value.trim() || suggestedName.trim();
      const created = await app.perform(() => app.store.addCategory(kind, name, groupSelect.value || null));
      if (created) pick(created.id);
    }, 'gold', { id: 'create-category' });
    function section(title, items) {
      if (!items.length) return null;
      return h('div', {}, h('h3', {}, title), h('div', { className: 'chips' }, items.map((c) => h('div', { className: `chip ${c.id === selected ? 'selected' : ''}` },
        button(c.name, () => pick(c.id), 'chip-name'),
        button(c.isFavorite ? '★' : '☆', async () => { await app.perform(() => app.store.setFavorite(c.id, !c.isFavorite)); draw(); }, 'star',
          { 'aria-label': `${c.name}をお気に入り${c.isFavorite ? 'から外す' : 'に追加'}` })))));
    }
    function draw() {
      const data = app.store.data;
      const word = search.value.trim();
      const all = L.selectable(data, kind);
      const recent = [...new Set(L.live(data.transactions).filter((t) => t.kind === kind).sort((a, b) => b.createdAt - a.createdAt).map((t) => t.categoryID))]
        .slice(0, 6).map((id) => all.find((c) => c.id === id)).filter(Boolean);
      const found = all.filter((c) => L.categoryPath(data, c.id).includes(word));
      list.replaceChildren(...(word ? [found.length ? section('検索結果', found) : note('一致する項目はありません。下のボタンから作れます。')]
        : [section('お気に入り', all.filter((c) => c.isFavorite)), section('最近使った項目', recent),
          ...L.groups(data, kind).map((g) => section(g.name, L.items(data, kind, g.id))),
          section(L.groups(data, kind).length ? '大項目なし' : 'すべての項目', L.items(data, kind, null))]).filter(Boolean));
      // 検索していないときは、読み取った商品名を新しい項目の名前として提案する
      const name = word || suggestedName.trim();
      const exists = all.some((c) => c.name === name);
      create.textContent = name && !exists ? `「${name}」を新しい項目として作る` : '新しい項目は、上に名前を入力すると作れます';
      create.disabled = !name || exists;
    }
    draw();
    return h('div', {}, search, list, h('label', { className: 'field' }, h('span', {}, '新しい項目の大項目'), groupSelect),
      h('div', { className: 'actions' }, button('閉じる', close), create));
  });
}
