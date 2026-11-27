// オフライン用。アプリ本体（画面と素材）だけを端末に保存する。記録（IndexedDB）には触れない。
// このファイルは scripts/make_web.py が作る。直接は編集しない。
// 画面は通信できれば最新を確認し、3秒で取れなければ保存済みを使う（古い画面が残り続けるのを防ぐ）。
const CACHE = 'zairyaku-0.14.0-a429754642';
const VENDOR = 'zairyaku-vendor-945bf172cd';
const FILES = ['./','./assets/home_analysis_left.png','./assets/home_analysis_right.png','./assets/home_analysis_title.png','./assets/home_card_left.png','./assets/home_card_right.png','./assets/home_card_title.png','./assets/home_coins.png','./assets/home_council_left.png','./assets/home_council_right.png','./assets/home_council_title.png','./assets/home_crest.png','./assets/home_fixed_left.png','./assets/home_fixed_right.png','./assets/home_fixed_title.png','./assets/home_goal_left.png','./assets/home_goal_right.png','./assets/home_goal_title.png','./assets/home_hero.png','./assets/home_input_left.png','./assets/home_input_right.png','./assets/home_input_title.png','./css/app.css','./css/theme.css','./data/classifier.json','./data/defaults.json','./icons/icon-180.png','./icons/icon-192.png','./icons/icon-512.png','./icons/icon-maskable-512.png','./js/config.js','./js/core/advice.js','./js/core/assistant.js','./js/core/backup.js','./js/core/calendar.js','./js/core/category-store.js','./js/core/classify.js','./js/core/combine.js','./js/core/consult.js','./js/core/council.js','./js/core/csv.js','./js/core/date.js','./js/core/diagnosis.js','./js/core/finance-store.js','./js/core/finance.js','./js/core/holidays.js','./js/core/ics.js','./js/core/learn-names.js','./js/core/ledger.js','./js/core/lock.js','./js/core/merge.js','./js/core/money.js','./js/core/notify.js','./js/core/ocr-geometry.js','./js/core/payroll.js','./js/core/pdf.js','./js/core/planning.js','./js/core/precise.js','./js/core/receipt.js','./js/core/schedule.js','./js/core/storage.js','./js/core/store.js','./js/core/sync/crypto.js','./js/core/sync/engine.js','./js/core/sync/merge3.js','./js/core/trends.js','./js/core/unknown.js','./js/image.js','./js/main.js','./js/ocr-paddle.js','./js/ocr-worker.js','./js/ocr.js','./js/scan.js','./js/ui/analysis.js','./js/ui/assets.js','./js/ui/backup.js','./js/ui/calendar.js','./js/ui/camera.js','./js/ui/categories.js','./js/ui/chart.js','./js/ui/device.js','./js/ui/diagnosis.js','./js/ui/dom.js','./js/ui/editor.js','./js/ui/export.js','./js/ui/form.js','./js/ui/goals.js','./js/ui/heads.js','./js/ui/home.js','./js/ui/icons.js','./js/ui/import.js','./js/ui/insight.js','./js/ui/listen.js','./js/ui/lock.js','./js/ui/notify.js','./js/ui/payday.js','./js/ui/payments.js','./js/ui/picker.js','./js/ui/refund.js','./js/ui/screens.js','./js/ui/sync.js','./js/ui/unknown.js','./js/ui/voice.js','./theme/clouds.svg','./theme/head_accounts.svg','./theme/head_advice.svg','./theme/head_analysis.svg','./theme/head_budget.svg','./theme/head_calendar.svg','./theme/head_cards.svg','./theme/head_consult.svg','./theme/head_council.svg','./theme/head_diagnosis.svg','./theme/head_fixed.svg','./theme/head_goals.svg','./theme/head_history.svg','./theme/head_input.svg','./theme/head_insurance.svg','./theme/head_loan.svg','./theme/head_payments.svg','./theme/head_receipt.svg','./theme/head_settings.svg','./theme/head_subscription.svg','./theme/head_sync.svg','./theme/sakura.svg','./theme/title_accounts.svg','./theme/title_advice.svg','./theme/title_analysis.svg','./theme/title_budget.svg','./theme/title_calendar.svg','./theme/title_cards.svg','./theme/title_consult.svg','./theme/title_council.svg','./theme/title_diagnosis.svg','./theme/title_fixed.svg','./theme/title_goals.svg','./theme/title_history.svg','./theme/title_input.svg','./theme/title_insurance.svg','./theme/title_loan.svg','./theme/title_payments.svg','./theme/title_receipt.svg','./theme/title_settings.svg','./theme/title_subscription.svg','./theme/title_sync.svg','./theme/waves.svg','./index.html','./manifest.webmanifest'];
const VENDOR_FILES = ['./vendor/adobe/Adobe-Japan1-UCS2.txt','./vendor/ort/ort-wasm-simd-threaded.mjs','./vendor/ort/ort-wasm-simd-threaded.wasm','./vendor/ort/ort.wasm.min.mjs','./vendor/paddle/det.onnx','./vendor/paddle/rec.onnx','./vendor/paddle/rec.yml'];

// 画面からの依頼：文字認識とPDFの部品を端末に保存する／保存の状況を答える
self.addEventListener('message', (event) => {
  const port = event.ports[0];
  if (!port || (event.data !== 'vendor-status' && event.data !== 'prepare-vendor')) return;
  event.waitUntil(caches.open(VENDOR).then(async (cache) => {
    if (event.data === 'prepare-vendor') {
      for (const url of VENDOR_FILES) if (!(await cache.match(url))) await cache.add(url);
    }
    const found = await Promise.all(VENDOR_FILES.map((url) => cache.match(url)));
    port.postMessage({ ok: true, saved: found.filter(Boolean).length, total: VENDOR_FILES.length });
  }).catch(() => port.postMessage({ ok: false, saved: 0, total: VENDOR_FILES.length })));
});

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE)
    .then((cache) => cache.addAll(FILES.map((url) => new Request(url, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('zairyaku-') && k !== CACHE && k !== VENDOR).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.includes('/vendor/')) {
    event.respondWith(caches.open(VENDOR).then((cache) => cache.match(event.request).then((hit) => hit
      || fetch(event.request).then((r) => { if (r.ok) cache.put(event.request, r.clone()); return r; }))));
    return;
  }
  const cached = () => caches.match(event.request, { ignoreSearch: true })
    .then((hit) => hit || (event.request.mode === 'navigate' ? caches.match('./index.html') : undefined));
  if (event.request.mode === 'navigate' && self.navigator.onLine !== false) {
    const network = fetch(event.request.url, { cache: 'no-store' }).then((r) => (r.ok ? r : Promise.reject(new Error(String(r.status)))));
    const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
    event.respondWith(Promise.race([network.catch(() => undefined), timeout])
      .then((r) => r || cached()).then((r) => r || network));
    return;
  }
  event.respondWith(cached().then((hit) => hit || fetch(event.request)));
});
