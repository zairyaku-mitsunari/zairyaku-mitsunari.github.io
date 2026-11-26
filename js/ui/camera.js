// アプリ内の専用カメラ。撮影した画像はこのアプリの中だけで扱い、写真アプリには保存しない。
import { h, button, sheet, note } from './dom.js';

export function openCamera(done) {
  let stream = null;
  const shots = [];
  sheet('レシートを撮影', (close) => {
    const video = h('video', { autoplay: true, muted: true, playsInline: true, 'aria-label': 'カメラの映像' });
    const strip = h('div', { className: 'shots' });
    const status = note('カメラを準備しています…');
    const shutter = button('撮影する', capture, 'gold', { id: 'shutter', disabled: true });
    const undo = button('最後の1枚を撮り直す', () => { const old = shots.pop(); if (old) URL.revokeObjectURL(old.url); draw(); }, 'outline', { id: 'retake', disabled: true });
    const use = button('読み取る', () => { stop(); close(); done(shots.map((s) => s.blob)); shots.forEach((s) => URL.revokeObjectURL(s.url)); }, 'gold', { id: 'use-shots', disabled: true });
    const fallback = h('input', { type: 'file', accept: 'image/*', capture: 'environment', multiple: true, hidden: true,
      onchange: () => { const files = [...fallback.files]; fallback.value = ''; if (files.length) { stop(); close(); done(files); } } });
    function stop() { stream?.getTracks().forEach((t) => t.stop()); stream = null; }
    function draw() {
      strip.replaceChildren(...shots.map((s, i) => h('img', { src: s.url, alt: `撮影した${i + 1}枚目` })));
      undo.disabled = use.disabled = !shots.length;
      use.textContent = shots.length ? `${shots.length}枚を読み取る` : '読み取る';
    }
    async function capture() {
      if (!video.videoWidth) return;
      const canvas = Object.assign(document.createElement('canvas'), { width: video.videoWidth, height: video.videoHeight });
      canvas.getContext('2d').drawImage(video, 0, 0);
      canvas.toBlob((blob) => { if (blob) { shots.push({ blob, url: URL.createObjectURL(blob) }); draw(); } }, 'image/jpeg', 0.92);
    }
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1920 } } });
        if (!video.isConnected) { stop(); return; }
        video.srcObject = stream;
        await video.play().catch(() => {});
        shutter.disabled = false;
        status.textContent = 'レシート全体が入るように、明るい場所で真上から撮ってください。長い場合は分けず、離して撮ります。';
      } catch (error) {
        status.textContent = error?.name === 'NotAllowedError' ? 'カメラの使用が許可されていません。端末の設定で許可するか、下の「端末のカメラで撮る」を使ってください。'
          : 'このアプリ内ではカメラを使えません。下の「端末のカメラで撮る」を使ってください。';
        video.hidden = true;
      }
    })();
    return h('div', { className: 'camera' }, status, video, strip,
      h('div', { className: 'actions' }, button('閉じる', () => { stop(); close(); shots.forEach((s) => URL.revokeObjectURL(s.url)); }), undo, shutter, use),
      h('div', { className: 'actions start' }, button('端末のカメラで撮る', () => fallback.click(), 'link'), fallback));
  }, { onClose: () => { stream?.getTracks().forEach((t) => t.stop()); } });
}
