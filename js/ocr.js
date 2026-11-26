// 無料の文字認識（Tesseract.js、同梱）。画像は端末の中だけで処理し、外部には送らない。
const BASE = new URL('../vendor/tesseract/', import.meta.url).href;
let library = null;
let worker = null;
let progress = () => {};
/** 精度の測定で、設定と学習データを替えて比べるためのもの（アプリは変えない） */
export const options = { psm: null };
let currentMode = null;

function loadLibrary() {
  library ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${BASE}tesseract.min.js`;
    script.onload = () => resolve(window.Tesseract);
    script.onerror = () => { library = null; reject(new Error('文字認識の部品を読み込めません。通信できる状態で一度試してください。')); };
    document.head.append(script);
  });
  return library;
}

async function start() {
  const Tesseract = await loadLibrary();
  const made = await Tesseract.createWorker('jpn', 1, {
    workerPath: `${BASE}worker.min.js`, corePath: `${BASE}core`, langPath: `${BASE}lang`, gzip: true,
    cacheMethod: 'none', // 部品の保存は Service Worker に任せる
    logger: (m) => { if (m.status === 'recognizing text') progress(m.progress); },
  });
  await made.setParameters({ preserve_interword_spaces: '1' });
  currentMode = null;
  return made;
}

/** 認識した単語と位置（0〜1、左上が原点）を返す */
export async function recognize(canvas, onProgress = () => {}, pageMode = '6') {
  progress = onProgress;
  try { worker ??= await start(); } catch (error) { worker = null; throw new Error(error?.message ?? '文字認識を開始できません。'); }
  const mode = options.psm ?? pageMode;
  if (mode !== currentMode) { await worker.setParameters({ tessedit_pageseg_mode: mode }); currentMode = mode; }
  const { data } = await worker.recognize(canvas, {}, { blocks: true });
  const fragments = [];
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) {
          const text = word.text.trim();
          if (!text || word.confidence < 15) continue; // 自信がほとんど無い断片（模様や汚れ）は使わない
          const { x0, x1 } = word.bbox;
          // 縦の位置は行の枠を使う（単語ごとの枠は記号で高さがばらつく）
          const { y0, y1 } = line.bbox;
          fragments.push({ text, x: x0 / canvas.width, y: y0 / canvas.height, width: (x1 - x0) / canvas.width, height: (y1 - y0) / canvas.height });
        }
      }
    }
  }
  return { fragments, text: data.text, confidence: data.confidence };
}

export async function stop() {
  if (worker) { const old = worker; worker = null; await old.terminate(); }
}
