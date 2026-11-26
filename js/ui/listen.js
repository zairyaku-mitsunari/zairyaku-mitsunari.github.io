// 音声の聞き取り（ブラウザの音声認識）。
// 端末の中だけで認識できる場合はそれを使う。できない場合は、音声が外部に送られることがあるため、
// 利用者が同意した場合だけ使う（初めは使わない）。
const Recognition = () => globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition ?? null;
let current = null;

const read = (key, fallback) => { try { return localStorage.getItem(`zairyaku-voice-${key}`) ?? fallback; } catch { return fallback; } };
export const consented = () => read('cloud', 'no') === 'yes';
export const consent = (value) => localStorage.setItem('zairyaku-voice-cloud', value ? 'yes' : 'no');

export const supported = () => !!Recognition();

/** 端末の中での認識：'available' 使える / 'downloadable' 部品を入れれば使える / 'unavailable' */
export async function onDevice(R = Recognition()) {
  if (!R || typeof R.available !== 'function' || !('processLocally' in R.prototype)) return 'unavailable';
  try {
    const state = await R.available({ langs: ['ja-JP'], processLocally: true });
    return state === 'available' ? 'available' : state === 'downloadable' || state === 'downloading' ? 'downloadable' : 'unavailable';
  } catch { return 'unavailable'; }
}

export const ERRORS = {
  'not-allowed': 'マイクの利用が許可されていません。端末の設定で許可するか、キーボードのマイクを使ってください。',
  'service-not-allowed': 'この開き方では音声認識を使えません。キーボードのマイクを使ってください。',
  'no-speech': '声が聞き取れませんでした。',
  network: '音声認識のサーバーに接続できませんでした。',
  'audio-capture': 'マイクが見つかりません。',
  'language-not-supported': '日本語の音声認識に対応していません。',
};

/**
 * 聞き取りを始める。mode: 'local'（端末の中）か 'cloud'（同意が必要）。
 * onText(text, final)、onEnd(finalText)、onError(message)
 */
export function listen({ mode, onText, onEnd, onError }, R = Recognition()) {
  if (!R) { onError('この端末のブラウザは音声認識に対応していません。'); return null; }
  if (mode !== 'local' && !consented()) { onError('音声認識を使うには、同意が必要です。'); return null; }
  stop();
  const recognition = new R();
  recognition.lang = 'ja-JP';
  recognition.interimResults = true;
  recognition.continuous = false;
  if (mode === 'local') recognition.processLocally = true; // 端末の中で認識できなければ失敗する（外部に送らない）
  let finalText = '';
  let failed = false;
  recognition.onresult = (event) => {
    const results = [...event.results];
    finalText = results.filter((r) => r.isFinal).map((r) => r[0].transcript).join('');
    onText(results.map((r) => r[0].transcript).join(''), results.every((r) => r.isFinal));
  };
  recognition.onerror = (event) => { if (event.error === 'aborted') return; failed = true; onError(ERRORS[event.error] ?? '音声認識でエラーが起きました。'); };
  recognition.onend = () => { if (current === recognition) current = null; onEnd(failed ? '' : finalText); };
  try { recognition.start(); } catch { onError('音声認識を始められませんでした。'); return null; }
  current = recognition;
  return { stop };
}

/** 途中でやめる（結果は使わない） */
export function stop() {
  if (!current) return;
  const old = current;
  current = null;
  old.onresult = null; old.onerror = null; old.onend = null;
  try { old.abort(); } catch { /* すでに終わっている */ }
}
export const listening = () => !!current;
