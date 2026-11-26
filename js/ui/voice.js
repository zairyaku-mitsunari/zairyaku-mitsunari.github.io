// 回答の読み上げ（端末に入っている声だけを使う）。インターネットで声を作る方式は使わない。
// 音声の聞き取りは、このアプリでは行わない（ブラウザの聞き取り機能は、音声が外部に送られることがあるため）。

export const supported = () => typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
const stored = (key, fallback) => { try { return localStorage.getItem(`zairyaku-voice-${key}`) ?? fallback; } catch { return fallback; } };
export const settings = () => ({ rate: Number(stored('rate', '1')), name: stored('name', ''), auto: stored('auto', 'off') === 'on', autoSend: stored('autosend', 'off') === 'on', length: stored('length', 'short') });
export const save = (key, value) => localStorage.setItem(`zairyaku-voice-${key}`, value);

/** この端末の中で動く日本語の声 */
export const voices = () => (supported() ? speechSynthesis.getVoices().filter((v) => v.localService && /^ja([-_]|$)/i.test(v.lang)) : []);

/** 選んだ声。なければ男性の声（Otoya・Hattori など）、それもなければ最初の声。 */
export function chosenVoice(list = voices(), name = settings().name) {
  return list.find((v) => v.name === name) ?? list.find((v) => /otoya|hattori|ichiro|keita/i.test(v.name)) ?? list[0] ?? null;
}

/** 読み上げ用の文に直す（記号や日付を言葉にする） */
export function spoken(text) {
  return String(text)
    .replace(/±¥0/g, '0円')
    .replace(/([+-])?¥([\d,]+)/g, (_, sign, n) => `${sign === '-' ? 'マイナス' : sign === '+' ? 'プラス' : ''}${n.replace(/,/g, '')}円`)
    .replace(/(\d{4})-(\d{2})-(\d{2})/g, (_, y, m, d) => `${y}年${Number(m)}月${Number(d)}日`)
    .replace(/〜/g, 'から').replace(/／/g, '、').replace(/→/g, 'から').replace(/[【】]/g, '。');
}

/** 要点だけ：題名と、根拠などを除いた初めの3行。省いた場合はそのことを伝える。 */
export function brief(lines) {
  const [title, ...rest] = lines;
  const body = rest.filter((l) => !/^(根拠|対象|比べた期間)：|^【/.test(l));
  return [title, ...body.slice(0, 3), ...(body.length > 3 ? ['続きは画面で確かめてください。'] : [])];
}

/** 読み上げる。声がない端末では false。 */
export function speak(lines, onEnd = () => {}) {
  const voice = chosenVoice();
  if (!voice) return false;
  speechSynthesis.cancel();
  const { rate } = settings();
  const list = lines.map(spoken).filter(Boolean);
  list.forEach((text, i) => {
    const u = new SpeechSynthesisUtterance(text);
    Object.assign(u, { voice, lang: voice.lang, rate, pitch: 0.95 });
    if (i === list.length - 1) u.onend = onEnd;
    speechSynthesis.speak(u);
  });
  return true;
}
export const pause = () => supported() && speechSynthesis.pause();
export const resume = () => supported() && speechSynthesis.resume();
export const stop = () => supported() && speechSynthesis.cancel();
