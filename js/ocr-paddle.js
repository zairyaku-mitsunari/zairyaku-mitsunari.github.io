// 高精度の文字認識を呼び出す入口。処理は ocr-worker.js（画面とは別の場所）で行う。
let worker = null;
let serial = 0;
const waiting = new Map();

function start() {
  const made = new Worker(new URL('./ocr-worker.js', import.meta.url), { type: 'module' });
  made.onmessage = ({ data }) => {
    const job = waiting.get(data.id);
    if (!job) return;
    if (data.progress !== undefined) { job.progress(data.progress); return; }
    waiting.delete(data.id);
    if (data.error) job.reject(new Error(data.error)); else job.resolve(data.result);
  };
  made.onerror = (event) => {
    for (const job of waiting.values()) job.reject(new Error(event.message || '文字認識を開始できません。'));
    waiting.clear();
    made.terminate();
    if (worker === made) worker = null;
  };
  return made;
}

/** canvas の文字を読む。options は ocr-worker.js の read を参照。 */
export function recognize(canvas, onProgress = () => {}, options = {}) {
  worker ??= start();
  const { data, width, height } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  const id = ++serial;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject, progress: onProgress });
    worker.postMessage({ id, image: { data, width, height }, options }, [data.buffer]);
  });
}

/** 使い終わったら、メモリを返す */
export function stop() {
  worker?.terminate();
  worker = null;
  for (const job of waiting.values()) job.reject(new Error('読み取りを中止しました。'));
  waiting.clear();
}
