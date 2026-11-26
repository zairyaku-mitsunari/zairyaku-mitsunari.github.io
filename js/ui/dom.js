// 画面部品を作る小さな道具。文字は必ず文字として入れる（HTMLとして解釈しない）。
import { HEADS } from './heads.js';
export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on')) element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'style') Object.assign(element.style, value);
    else if (key in element && key !== 'list') element[key] = value;
    else element.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined && child !== false) element.append(child);
  }
  return element;
}

export const panel = (title, ...children) => h('section', { className: 'panel' }, title ? h('h2', {}, title) : null, ...children);
export const row = (label, value, className = '') => h('div', { className: `row ${className}` }, h('span', { className: 'label' }, label), h('span', { className: 'value' }, value));
export const button = (text, onClick, className = 'outline', props = {}) => h('button', { type: 'button', className, onclick: onClick, ...props }, text);
export const note = (text, className = 'note') => h('p', { className }, text);

/** 画面の見出し（正式デザイン）：風景の絵に、黄金の筆文字の題字と添え書き */
export function screenHead(id) {
  const [title, subtitle, strong] = HEADS[id];
  return h('header', { className: 'screen-head', 'data-head': id, 'data-strong': strong ? 'true' : null },
    h('img', { className: 'head-art', src: `theme/head_${id}.svg`, alt: '', draggable: false }),
    h('h1', {}, h('img', { src: `theme/title_${id}.svg`, alt: title, draggable: false })),
    h('p', {}, subtitle));
}

/** 下から出る入力画面。閉じると要素ごと消える。head を指定すると、画面の見出しを付ける。 */
export function sheet(title, build, { className = '', onClose, head } = {}) {
  const dialog = h('dialog', { className: `sheet ${className}` });
  const close = () => { onClose?.(); dialog.close(); dialog.remove(); };
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  const body = build(close);
  dialog.append(...[head ? screenHead(head) : null, h('h2', { className: 'sheet-title' }, title), body].filter(Boolean));
  document.body.append(dialog);
  dialog.showModal();
  return close;
}

/** 確認（はい/いいえ） */
export function confirmSheet(title, message, actionText) {
  return new Promise((resolve) => {
    sheet(title, (close) => h('div', {}, note(message, 'message'), h('div', { className: 'actions' },
      button('キャンセル', () => { close(); resolve(false); }),
      button(actionText, () => { close(); resolve(true); }, 'gold'))));
  });
}

/** ファイルを渡す。iPhone は共有の画面、それ以外はダウンロード。取り消したら false。 */
export async function saveFile(content, name, type) {
  const file = new File([content], name, { type });
  if (navigator.canShare?.({ files: [file] }) && /iP(hone|ad)/.test(navigator.userAgent)) {
    try { await navigator.share({ files: [file] }); return true; } catch (error) { if (error.name === 'AbortError') return false; }
  }
  const link = h('a', { href: URL.createObjectURL(file), download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60000);
  return true;
}
