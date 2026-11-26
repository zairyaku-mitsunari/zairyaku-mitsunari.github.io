// 下部メニューなどの線画アイコン（参考画像の形に合わせた自作の図形）
const SHAPES = {
  home: 'M3 11 12 3.5 21 11M5.5 9.5V20.5H9.7V14.5H14.3V20.5H18.5V9.5',
  assets: 'M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM13.5 13.5H20V20h-6.5z',
  history: 'M6 3h8.5L19 7.5V21H6zM14 3v5h5M9 12.5h7M9 16.5h7',
  analysis: 'M6.5 20v-6M12 20V5M17.5 20v-9M3 20.5h18',
  settings: 'M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8zM10.3 3h3.4l.5 2.4 1.7.7 2.1-1.4 2.4 2.4-1.4 2.1.7 1.7 2.4.5v3.4l-2.4.5-.7 1.7 1.4 2.1-2.4 2.4-2.1-1.4-1.7.7-.5 2.4h-3.4l-.5-2.4-1.7-.7-2.1 1.4-2.4-2.4 1.4-2.1-.7-1.7-2.4-.5v-3.4l2.4-.5.7-1.7-1.4-2.1 2.4-2.4 2.1 1.4 1.7-.7z',
  calendar: 'M4 5.5h16V21H4zM4 10h16M8 3v4.5M16 3v4.5M8 13.5h.01M12 13.5h.01M16 13.5h.01M8 17h.01M12 17h.01M16 17h.01',
};

export function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', SHAPES[name]);
  svg.append(path);
  return svg;
}
