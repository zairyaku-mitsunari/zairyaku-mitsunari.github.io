// レシート・明細の取り込み → 読み取り → 確認 → 一括登録、原本の表示
import { h, button, sheet, panel, row, note, confirmSheet } from './dom.js';
import { categoryPicker } from './picker.js';
import { openCamera } from './camera.js';
import { overlapField } from './unknown.js';
import { offset } from '../core/unknown.js';
import * as L from '../core/ledger.js';
import * as R from '../core/receipt.js';
import { Classifier, sourceTitle } from '../core/classify.js';
import { apply as learnedName, remember } from '../core/learn-names.js';
import { parseAmount, yen, signed } from '../core/money.js';
import { today, isDay } from '../core/date.js';
import { monthContaining } from '../core/finance.js';
import { decode, compress } from '../image.js';

const kindName = { receipt: 'レシート・領収書', bill: '請求明細', statement: '利用明細・入出金明細' };
const paymentName = { cash: '現金', card: 'クレジットカード', paypay: 'PayPay', emoney: '電子マネー' };

/** 直した商品名の覚え書き（この端末だけ。記録やバックアップには入れない） */
const NAMES = 'ocr-names';
const learnedNames = async (app) => (await app.store.persistence.local(NAMES).catch(() => null)) ?? [];

export async function fingerprint(buffer) {
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const value = (text) => { const t = String(text).trim(); if (!t) return null; if (/^[0０]+$/.test(t)) return 0; return parseAmount(t).value ?? null; };

/** 文字の入力欄（変更のたびに state を更新） */
function textInput(label, initial, onInput, props = {}) {
  const input = h('input', { type: 'text', value: initial ?? '', 'aria-label': label, ...props, oninput: () => onInput(input.value) });
  return input;
}

function sourceSelect(app, initial, onChange) {
  const { data } = app.store;
  const option = (prefix, x) => h('option', { value: `${prefix}:${x.id}` }, x.name);
  const select = h('select', { 'aria-label': '支払い方法', onchange: () => onChange(select.value) }, h('option', { value: '' }, '未入力'),
    h('optgroup', { label: '口座・現金' }, L.live(data.accounts).filter((a) => !a.isArchived).map((a) => option('account', a))),
    h('optgroup', { label: 'クレジットカード' }, L.live(data.cards).filter((c) => !c.isArchived).map((c) => option('card', c))));
  select.value = initial;
  return select;
}
const sourceIDs = (text) => { const [prefix, id] = text.split(':'); return { accountID: prefix === 'account' ? id : null, cardID: prefix === 'card' ? id : null }; };

/** 読み取った支払い方法に合う口座が1つだけなら選ぶ */
function suggestedSource(app, hint) {
  const type = hint === 'cash' ? 'cash' : hint === 'paypay' ? 'paypay' : null;
  const matches = type ? L.live(app.store.data.accounts).filter((a) => a.type === type && !a.isArchived) : [];
  return matches.length === 1 ? `account:${matches[0].id}` : '';
}

export function openImport(app, inputs = []) {
  const jobs = [];
  let index = 0;
  let registered = 0;
  let busy = false;
  let closed = false;

  sheet('レシート・明細の読み取り', (close) => {
    const body = h('div', { className: 'import' });
    const message = h('p', { className: 'error', role: 'alert' });
    const files = h('input', { type: 'file', accept: 'image/*,application/pdf,.pdf', multiple: true, hidden: true, id: 'import-images', onchange: () => { add([...files.files]); files.value = ''; } });
    const native = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, id: 'native-camera', onchange: () => { add([...native.files]); native.value = ''; } });
    const pasted = h('textarea', { rows: 5, 'aria-label': '貼り付ける文字', placeholder: '写真アプリなどでコピーしたレシートの文字を、ここに貼り付けます' });
    const done = () => { closed = true; document.removeEventListener('paste', onPaste); close(); app.render(); };

    function onPaste(event) {
      if (!body.isConnected) return;
      const found = [...(event.clipboardData?.files ?? [])];
      if (found.length) { event.preventDefault(); add(found); }
    }
    document.addEventListener('paste', onPaste);

    async function pasteButton() {
      try {
        const items = await navigator.clipboard.read();
        const blobs = [];
        let text = '';
        for (const item of items) {
          const type = item.types.find((t) => t.startsWith('image/'));
          if (type) blobs.push(await item.getType(type));
          else if (item.types.includes('text/plain')) text += await (await item.getType('text/plain')).text();
        }
        if (blobs.length) add(blobs);
        else if (text.trim()) { pasted.value = text; message.textContent = ''; }
        else message.textContent = 'クリップボードに画像や文字がありません。';
      } catch { message.textContent = '貼り付けできませんでした。文字の欄を長押しして「ペースト」するか、画像を選んでください。'; }
    }

    function add(blobs) {
      for (const blob of blobs) {
        if (blob.type === 'application/pdf' || /\.pdf$/i.test(blob.name ?? '')) { jobs.push({ pdf: blob }); continue; }
        if (blob.type && !blob.type.startsWith('image/')) { message.textContent = '画像かPDFを選んでください。'; continue; }
        jobs.push({ blob });
      }
      process();
    }

    function addText() {
      const text = pasted.value.trim();
      if (!text) { message.textContent = '文字を貼り付けてください。'; return; }
      jobs.push({ text });
      pasted.value = '';
      process();
    }

    /** 1件ずつ読み取る */
    async function process() {
      if (busy) return;
      draw();
      const job = jobs[index];
      if (!job || job.result || job.failure) return;
      busy = true;
      try {
        job.names = await learnedNames(app);
        if (job.text) {
          const lines = job.text.split(/\r?\n/);
          job.result = { lines, parsed: R.parseDocument(lines, today()), files: [], fingerprint: await fingerprint(new TextEncoder().encode(job.text)) };
        } else if (job.pdf) {
          const status = body.querySelector('.progress');
          job.result = await readDocument(job.pdf, (text) => { if (status) status.textContent = text; });
          job.pdf = null;
        } else {
          const status = body.querySelector('.progress');
          const canvas = await decode(job.blob);
          const { scan } = await import('../scan.js');
          const read = await scan(canvas, today(), (p) => { if (status) status.textContent = `読み取っています… ${Math.round(p * 100)}%`; });
          const saved = await compress(canvas);
          job.result = { ...read, files: [{ data: await saved.arrayBuffer(), extension: 'jpg' }], url: URL.createObjectURL(saved), fingerprint: await fingerprint(await job.blob.arrayBuffer()) };
          job.blob = null;
        }
      } catch (error) { job.failure = error.message || '読み取れませんでした。'; }
      busy = false;
      if (!closed) { draw(); }
    }

    function next(didRegister) {
      if (didRegister) registered += 1;
      const job = jobs[index];
      if (job?.result?.url) URL.revokeObjectURL(job.result.url);
      jobs[index] = { finished: true };
      index += 1;
      draw();
      process();
    }

    function draw() {
      message.textContent = '';
      const job = jobs[index];
      if (!job) { body.replaceChildren(chooser()); return; }
      const count = jobs.length > 1 ? `（${index + 1}／${jobs.length}件目）` : '';
      if (job.failure) body.replaceChildren(note(job.failure, 'error'), h('div', { className: 'actions' }, button('次へ', () => next(false), 'gold')));
      else if (!job.result) body.replaceChildren(h('p', { className: 'progress', role: 'status' }, `読み取っています…${count}`), note('はじめての読み取りは、文字認識の部品（約46MB）を読み込むので時間がかかります。画像は端末の外に送りません。'));
      else {
        const skip = button('この書類は登録しない', () => next(false));
        const view = job.result.parsed.kind === 'statement' ? statementReview(app, job.result, next) : receiptReview(app, job, next, draw);
        const warnings = [
          job.result.fallback ? note('高精度の文字認識を使えなかったため、簡易の方式で読みました。読み違いが増えます。通信できる状態で、もう一度試してください。', 'note warn') : null,
          job.result.confidence != null && job.result.confidence < 0.85 ? note('文字がはっきり読めていません。明るい場所で真上から撮り直すと、良くなることがあります。', 'note warn') : null,
        ];
        body.replaceChildren(h('div', { className: 'actions' }, h('strong', {}, `確認${count}`), skip), ...warnings.filter(Boolean), view);
      }
    }

    function chooser() {
      const drop = h('div', { className: 'drop panel', ondragover: (e) => { e.preventDefault(); }, ondrop: (e) => { e.preventDefault(); add([...e.dataTransfer.files]); } },
        note('画像やPDFをここへドラッグ＆ドロップ（コピーした画像は貼り付けもできます）', 'message'));
      return h('div', {},
        registered ? note(`${registered}件の書類を登録しました。`, 'done') : null,
        h('div', { className: 'choices' },
          button('端末のカメラで撮影（おすすめ）', () => native.click(), 'gold', { id: 'native-shot' }),
          button('アプリ内カメラ（続けて撮影）', () => openCamera(add), 'outline', { id: 'open-camera' }),
          button('画像・PDFを選ぶ', () => files.click()),
          button('貼り付け', pasteButton, 'outline', { id: 'paste-button' })),
        files, native, drop,
        note('撮り方：レシート全体を入れ、明るい場所で真上から。影が入らないようにし、ぼけていないことを確かめてください。'),
        panel('文字を貼り付けて読み取る', note('iPhoneの写真アプリでは、画像の文字を長押ししてコピーできます（テキスト認識表示）。文字認識より正確な場合があります。'), pasted,
          h('div', { className: 'actions' }, button('文字から読み取る', addText, 'gold', { id: 'read-text' }))),
        note('読み取りはこの端末の中で行い、画像も文字も外部には送りません。撮影した画像は写真アプリに保存しません。確認して登録するまで、記録は増えません。'),
        note('文字認識は読み間違えます。登録の前に、必ず原本と見比べてください。', 'note warn'));
    }

    draw();
    if (inputs.length) add(inputs);
    return h('div', {}, h('div', { className: 'sheet-close' }, button('閉じる', done, 'outline', { id: 'close-import' })), message, body);
  }, { className: 'full', head: 'receipt', onClose: () => {
    closed = true;
    import('../ocr-paddle.js').then((m) => m.stop()).catch(() => {}); // 読み取り用のメモリを返す
  } });
}

/** PDF：文字があれば文字を取り出し、写真だけのPDFは文字認識する */
async function readDocument(blob, progress) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  progress('PDFを読んでいます…');
  const { readPDF, japan1Table } = await import('../core/pdf.js');
  const pdf = await readPDF(bytes, { japan1: japan1Table });
  if (pdf.encrypted) throw new Error('パスワードや暗号化で保護されたPDFは読み取れません。画面を撮って画像で取り込むか、文字をコピーして貼り付けてください。');
  let lines = pdf.pages.flatMap((page) => R.layoutLines(page.fragments)).map((l) => R.normalize(l).trim()).filter(Boolean);
  let scanned = false;
  if (lines.filter((l) => /\d/.test(l)).length < 2) {
    const images = pdf.pages.map((page) => [...page.images].sort((a, b) => b.width * b.height - a.width * a.height)[0]).filter(Boolean);
    if (!images.length) throw new Error('このPDFからは、文字も読み取れる画像も取り出せませんでした。画面を撮って画像で取り込むか、文字をコピーして貼り付けてください。');
    const { scan } = await import('../scan.js');
    lines = [];
    scanned = true;
    for (const [i, image] of images.entries()) {
      let canvas = await decode(new Blob([image.data], { type: 'image/jpeg' }));
      const turn = pdf.pages[i].rotate;
      if (turn) canvas = (await import('../image.js')).rotate(canvas, turn, '#fff');
      const read = await scan(canvas, today(), (p) => progress(`${i + 1}／${images.length}ページ目を読み取っています… ${Math.round(p * 100)}%`));
      lines.push(...read.lines);
    }
  }
  return { lines, parsed: R.parseDocument(lines, today()), scanned, pdfName: blob.name ?? '書類.pdf', files: [{ data: buffer, extension: 'pdf' }],
    url: URL.createObjectURL(new Blob([buffer], { type: 'application/pdf' })), fingerprint: await fingerprint(buffer), pages: pdf.pages.length };
}

function originalPreview(result) {
  if (!result.url) return null;
  if (!result.pdfName) return h('img', { src: result.url, alt: '取り込んだ画像' });
  return h('div', { className: 'panel' }, note(`PDF（${result.pages}ページ）${result.scanned ? '：写真のページを文字認識しました。' : '：PDFの中の文字を取り出しました。'}`, 'message'),
    h('a', { href: result.url, download: result.pdfName, className: 'note' }, 'PDFを開いて見比べる（保存）'),
    h('pre', { className: 'pdf-text' }, result.lines.slice(0, 200).join('\n')));
}

/** 原本の画像と、読み取った文字（直して読み直せる） */
function original(job, redraw) {
  const { result } = job;
  const text = h('textarea', { rows: 8, 'aria-label': '読み取った文字', value: result.lines.join('\n') });
  return h('div', { className: 'original' },
    originalPreview(result),
    h('details', {}, h('summary', {}, '読み取った文字を直して読み直す'), text,
      button('この文字で読み直す', () => {
        result.lines = text.value.split(/\r?\n/);
        result.parsed = R.parseDocument(result.lines, today());
        job.state = null;
        redraw();
      }, 'outline', { id: 'reparse' })));
}

function receiptReview(app, job, next, redraw) {
  const { result } = job;
  const parsed = result.parsed;
  const store = app.store;
  if (!job.state) {
    const classifier = new Classifier(store.data, app.classifier);
    let items = parsed.items;
    if (!items.length && parsed.total != null) items = [{ name: parsed.storeName ?? kindName[parsed.kind], amount: parsed.total, discount: 0 }]; // 内訳は作らない
    job.state = {
      storeName: parsed.storeName ?? '', day: parsed.day ?? '', total: parsed.total != null ? String(parsed.total) : '',
      discount: parsed.discount ? String(parsed.discount) : '', tax: parsed.addedTax ? String(parsed.addedTax) : '',
      source: suggestedSource(app, parsed.payment), anyway: false,
      lines: items.map((item) => {
        const read = parsed.items.length ? item.name : null; // 内訳がないときは、名前を覚えない
        const { name, from } = read == null ? { name: item.name, from: null } : learnedName(job.names ?? [], store.data, read);
        const s = classifier.suggest(name, parsed.storeName, { fuzzy: !job.text }); // 画像の読み取りは読み違いを考慮
        return { name, read, renamed: from, doubtful: (result.doubtful ?? []).includes(item.name), quantity: item.quantity ?? null, unitPrice: item.unitPrice ?? null,
          amount: String(item.amount), discount: item.discount, categoryID: s.categoryID, suggested: s.categoryID, source: s.source };
      }),
    };
  }
  const state = job.state;
  const list = h('div', { className: 'lines' });
  const duplicates = h('div');
  const summary = h('div');
  const problems = h('div');
  const failure = h('p', { className: 'error', role: 'alert' });
  const register = button('確認して一括登録', submit, 'gold wide', { id: 'register' });
  const covered = overlapField(app, () => [{ kind: 'expense', day: state.day, categoryID: null, accountID: sourceIDs(state.source).accountID,
    amount: payable().reduce((a, b) => a + b, 0) }]);

  const payable = () => R.payableAmounts(state.lines.map((l) => ({ amount: value(l.amount) ?? 0, discount: l.discount })), value(state.discount) ?? 0, value(state.tax) ?? 0);
  const record = () => ({
    kind: parsed.kind, storeName: state.storeName, day: state.day, total: value(state.total),
    tax: parsed.includedTax + (value(state.tax) ?? 0) || null, discount: (value(state.discount) ?? 0) + state.lines.reduce((s, l) => s + l.discount, 0) || null,
    lines: state.lines.map((l, i) => ({ name: l.name, quantity: l.quantity, amount: payable()[i], categoryID: l.categoryID })),
    fingerprints: [result.fingerprint],
  });

  function drawLines() {
    list.replaceChildren(...state.lines.map((line, i) => h('div', { className: 'line' },
      h('div', { className: 'line-main' },
        textInput(`${i + 1}行目の商品名`, line.name, (v) => { line.name = v; }, { className: 'name' }),
        textInput(`${i + 1}行目の金額`, line.amount, (v) => { line.amount = v; update(); }, { className: 'price', inputMode: 'numeric' }),
        button('✕', () => { state.lines.splice(i, 1); drawLines(); update(); }, 'link', { 'aria-label': `${i + 1}行目を削除` })),
      h('div', { className: 'line-sub' },
        button(line.categoryID ? L.categoryName(store.data, line.categoryID) : '項目を選ぶ・作る', () => categoryPicker(app, 'expense', line.categoryID, (id) => { line.categoryID = id; drawLines(); update(); }, line.name),
          `chip-button ${line.categoryID ? '' : 'missing'}`, { 'data-line': String(i) }),
        h('small', {}, line.categoryID ? (line.categoryID === line.suggested ? sourceTitle[line.source] : '修正済み') : '要確認'),
        line.quantity > 1 || line.unitPrice ? h('small', {}, `${line.quantity ?? '?'}点${line.unitPrice ? ` × 単価 ${yen(line.unitPrice)}` : ''}`) : null,
        line.discount ? h('small', {}, `値引 ${yen(line.discount)}`) : null),
      line.quantity && line.unitPrice && value(line.amount) != null && line.quantity * line.unitPrice !== value(line.amount)
        ? note('数量 × 単価と金額が合いません。原本を確かめてください。', 'note warn') : null,
      line.doubtful ? note('この行は読み取りに自信がありません。原本と見比べてください。', 'note warn') : null,
      line.renamed && line.name !== line.read ? h('div', { className: 'line-sub' },
        h('small', {}, `${line.renamed === 'learned' ? '前に直した名前' : '以前の記録の名前'}を使いました（読み取り：${line.read}）`),
        button('読み取りに戻す', () => { line.name = line.read; line.renamed = null; drawLines(); }, 'link', { 'data-restore': String(i) })) : null)));
  }

  function update() {
    const amounts = payable();
    const total = value(state.total);
    const sum = amounts.reduce((a, b) => a + b, 0);
    const difference = total == null ? null : total - sum;
    const same = R.sameFile(store.data, [result.fingerprint]).length > 0;
    const similar = total && isDay(state.day) ? R.similarEntries(store.data, total, state.day) : [];

    duplicates.replaceChildren(...(same || similar.length ? [panel(null,
      note(same ? '同じ画像・文字は、すでに取り込んでいます。' : '同じ金額の記録が近い日にあります。二重登録に注意してください。', 'note warn'),
      similar.slice(0, 4).map((s) => {
        const attached = store.data.transactions.some((t) => s.entryIDs.includes(t.id) && t.receiptID);
        return h('div', { className: 'row' }, h('span', {}, `${s.day}　${yen(s.amount)}　${s.storeName}`),
          attached ? h('small', {}, 'レシート添付済み') : button('この記録にレシートを付ける', async () => {
            try { await store.attachDocument(record(), s.entryIDs, result.files); next(true); } catch (error) { failure.textContent = error.message; }
          }, 'outline'));
      }),
      h('label', { className: 'check' }, h('input', { type: 'checkbox', checked: state.anyway, id: 'register-anyway', onchange: (e) => { state.anyway = e.target.checked; update(); } }), '別の支払いなので、新しく登録する'))] : []));

    summary.replaceChildren(row('振り分けの合計', yen(sum), 'large'),
      parsed.includedTax ? row('価格に含まれる消費税（参考）', yen(parsed.includedTax)) : '',
      difference == null || !state.lines.length ? '' : difference === 0 ? note('合計と一致しています。', 'done')
        : h('div', {}, note(`差額 ${signed(difference)}。読み間違いがないか、原本と見比べてください。`, 'note warn'),
          button('差額を1行追加', () => {
            if (difference > 0) state.lines.push({ name: '差額', quantity: null, amount: String(difference), discount: 0, categoryID: null, suggested: null, source: 'unknown' });
            else { state.discount = String((value(state.discount) ?? 0) - difference); discount.value = state.discount; }
            drawLines(); update();
          }, 'outline', { id: 'add-difference' })));

    const list_ = [];
    if (!isDay(state.day)) list_.push('購入日を指定してください。');
    if (!(total > 0)) list_.push('支払った合計額を入力してください。');
    if (!state.lines.length) list_.push('商品の行がありません。');
    if (state.lines.some((l) => !l.categoryID)) list_.push('項目が決まっていない商品があります。');
    if (state.lines.some((l) => !(value(l.amount) > 0))) list_.push('金額が未入力の商品があります。');
    if (amounts.some((a) => a < 0)) list_.push('値引きが商品の金額を超えています。');
    if (difference) list_.push(`合計と振り分けの合計が ${signed(difference)} ずれています。`);
    if ((same || similar.length) && !state.anyway) list_.push('重複の確認をしてください。');
    problems.replaceChildren(...list_.map((p) => note(p, 'note warn')));
    register.disabled = list_.length > 0;
    failure.textContent = '';
    covered.update();
  }

  async function submit() {
    if (register.disabled) return;
    register.disabled = true; // 二度押しで二重に登録しない
    const amounts = payable();
    const groups = new Map();
    state.lines.forEach((line, i) => {
      const g = groups.get(line.categoryID) ?? { amount: 0, names: [] };
      g.amount += amounts[i]; g.names.push(R.redact(line.name)); groups.set(line.categoryID, g);
    });
    const drafts = [...groups].filter(([, g]) => g.amount > 0).map(([categoryID, g]) => ({
      kind: 'expense', day: state.day, amount: g.amount, categoryID,
      scope: L.find(store.data.categories, categoryID)?.defaultScope ?? (app.scope === 'business' ? 'business' : 'personal'),
      ...sourceIDs(state.source), storeName: state.storeName, memo: g.names.join('、').slice(0, 80),
    }));
    const corrections = parsed.items.length ? state.lines.filter((l) => l.categoryID !== l.suggested && l.name !== '差額').map((l) => ({ name: l.name, categoryID: l.categoryID })) : [];
    try {
      await store.registerDocument(record(), drafts, { files: result.files, corrections, alongside: covered.checked() ? offset : undefined });
      const pairs = state.lines.filter((l) => l.read != null && R.redact(l.read) === l.read).map((l) => ({ read: l.read, name: R.redact(l.name) }));
      // 名前の覚え書きは補助なので、保存できなくても登録は成功のまま
      if (pairs.length) await store.persistence.setLocal(NAMES, remember(await learnedNames(app), pairs)).catch(() => {});
      app.month = monthContaining(state.day, store.data);
      next(true);
    } catch (error) { failure.textContent = error.message; register.disabled = false; }
  }

  const field = (label, control) => h('label', { className: 'field' }, h('span', {}, label), control);
  const day = h('input', { type: 'date', value: state.day, 'aria-label': '購入日', oninput: () => { state.day = day.value; update(); } });
  const total = textInput('支払った合計', state.total, (v) => { state.total = v; update(); }, { inputMode: 'numeric' });
  const discount = textInput('全体の値引き', state.discount, (v) => { state.discount = v; update(); }, { inputMode: 'numeric' });
  const tax = textInput('上乗せされる消費税', state.tax, (v) => { state.tax = v; update(); }, { inputMode: 'numeric' });
  drawLines();
  update();
  return h('div', { className: 'review' }, original(job, redraw), h('div', { className: 'review-main' },
    panel(kindName[parsed.kind],
      field('店舗名', textInput('店舗名', state.storeName, (v) => { state.storeName = v; })),
      field('購入日', day), parsed.day ? null : note('購入日は読み取れませんでした。', 'note warn'),
      field('支払い方法', sourceSelect(app, state.source, (v) => { state.source = v; update(); })),
      note(parsed.payment ? `読み取った支払い方法：${paymentName[parsed.payment]}` : '支払い方法は読み取れませんでした。')),
    duplicates,
    panel('商品と支出項目', parsed.items.length ? null : note('商品の内訳は読み取れないため、合計だけを1行にしています。内訳は作りません。'), list,
      button('行を追加', () => { state.lines.push({ name: '', quantity: null, amount: '', discount: 0, categoryID: null, suggested: null, source: 'unknown' }); drawLines(); update(); }, 'outline')),
    panel('金額の照合', field('支払った合計', total), field('全体の値引き', discount), field('上乗せされる消費税（外税）', tax), summary, problems, covered.element, failure, register)));
}

function statementReview(app, result, next) {
  const store = app.store;
  const parsed = result.parsed;
  const classifier = new Classifier(store.data, app.classifier);
  const statuses = R.statementStatus(store.data, parsed.rows);
  const imported = R.sameFile(store.data, [result.fingerprint]).length > 0;
  const rows = parsed.rows.map((r, i) => ({ ...r, status: statuses[i].type, included: !imported && statuses[i].type === 'new' && !!r.day,
    categoryID: r.isIncome ? null : classifier.suggest(r.description, r.description).categoryID }));
  let source = suggestedSource(app, parsed.payment);
  const list = h('div');
  const totals = h('div');
  const failure = h('p', { className: 'error', role: 'alert' });
  const register = button('選んだ行を一括登録', submit, 'gold wide', { id: 'register' });
  const draftsNow = () => rows.filter((r) => r.included).map((r) => ({ kind: r.isIncome ? 'income' : 'expense', day: r.day, amount: r.amount, categoryID: r.categoryID, accountID: sourceIDs(source).accountID }));
  const covered = overlapField(app, draftsNow);
  const note_ = (r) => (r.status === 'cardWithdrawal' ? 'カード代金の引き落とし（支出にしません）' : r.status === 'recorded' ? '同じ金額の記録があります（登録済みの可能性）' : r.isYearAssumed ? '年の記載がないため推定した日付です' : '新しい明細');
  function draw() {
    list.replaceChildren(...rows.map((r, i) => h('div', { className: 'line' },
      h('label', { className: 'check' }, h('input', { type: 'checkbox', checked: r.included, disabled: r.status === 'cardWithdrawal' || !r.day, 'data-row': String(i), onchange: (e) => { r.included = e.target.checked; draw(); } }),
        h('span', {}, `${r.day ?? '日付不明'}　${r.description}`), h('b', { className: `money ${r.isIncome ? 'income' : 'expense'}` }, `${r.isIncome ? '+' : '-'}${yen(r.amount)}`)),
      h('div', { className: 'line-sub' }, h('small', {}, note_(r)),
        r.included ? [button(r.isIncome ? '支出にする' : '収入にする', () => { r.isIncome = !r.isIncome; r.categoryID = null; draw(); }, 'link'),
          button(r.categoryID ? L.categoryName(store.data, r.categoryID) : '項目を選ぶ', () => categoryPicker(app, r.isIncome ? 'income' : 'expense', r.categoryID, (id) => { r.categoryID = id; draw(); }),
            `chip-button ${r.categoryID ? '' : 'missing'}`)] : null))));
    const chosen = rows.filter((r) => r.included);
    totals.replaceChildren(row(`選んだ支出の合計（${chosen.filter((r) => !r.isIncome).length}行）`, yen(chosen.filter((r) => !r.isIncome).reduce((s, r) => s + r.amount, 0)), 'large'),
      ...(chosen.some((r) => !r.categoryID) ? [note('項目が決まっていない行があります。', 'note warn')] : []));
    register.disabled = !chosen.length || chosen.some((r) => !r.categoryID);
    covered.update();
  }
  async function submit() {
    if (register.disabled) return;
    register.disabled = true;
    const chosen = rows.filter((r) => r.included);
    const drafts = chosen.map((r) => ({ kind: r.isIncome ? 'income' : 'expense', day: r.day, amount: r.amount, categoryID: r.categoryID,
      scope: L.find(store.data.categories, r.categoryID)?.defaultScope ?? (app.scope === 'business' ? 'business' : 'personal'),
      accountID: sourceIDs(source).accountID, cardID: r.isIncome ? null : sourceIDs(source).cardID, storeName: r.description }));
    const latest = drafts.map((d) => d.day).sort().at(-1);
    try {
      await store.registerDocument({ kind: 'statement', storeName: parsed.storeName ?? '利用明細', day: latest, total: drafts.reduce((s, d) => s + d.amount, 0),
        lines: chosen.map((r) => ({ name: r.description, amount: r.amount, categoryID: r.categoryID })), fingerprints: [result.fingerprint] }, drafts, { files: result.files, alongside: covered.checked() ? offset : undefined });
      app.month = monthContaining(latest, store.data);
      next(true);
    } catch (error) { failure.textContent = error.message; register.disabled = false; }
  }
  draw();
  return h('div', { className: 'review' }, h('div', { className: 'original' }, originalPreview(result)),
    h('div', { className: 'review-main' },
      panel(`明細の取り込み（${rows.length}行）`, h('label', { className: 'field' }, h('span', {}, '支払い方法'), sourceSelect(app, source, (v) => { source = v; covered.update(); })),
        note('カードの明細はそのカードを、銀行の明細はその口座を選んでください。同じ金額の記録がある行と、カード代金の引き落としは、はじめは選んでいません。読み落とした行がないか原本と見比べてください。')),
      panel(null, list, totals, covered.element, failure, register)));
}

export function openReceipt(app, id) {
  const receipt = app.store.data.receipts.find((r) => r.id === id);
  if (!receipt) return;
  const urls = [];
  sheet('レシート・明細', (close) => {
    const images = h('div', { className: 'original' }, note('原本を読み込んでいます…'));
    const done = () => { urls.forEach(URL.revokeObjectURL); close(); };
    (async () => {
      const found = [];
      for (const name of receipt.files) {
        const data = await app.store.persistence.file(name);
        if (!data) continue;
        if (name.endsWith('.pdf')) { const url = URL.createObjectURL(new Blob([data], { type: 'application/pdf' })); urls.push(url); found.push(h('a', { href: url, download: name, className: 'note' }, 'PDFの原本を保存')); }
        else { const url = URL.createObjectURL(new Blob([data], { type: 'image/jpeg' })); urls.push(url); found.push(h('img', { src: url, alt: 'レシートの原本' })); }
      }
      images.replaceChildren(...(found.length ? found : [note('原本は保存していないか、削除されています（別の端末で取り込んだ場合は、その端末のバックアップを合わせてください）。')]));
    })();
    return h('div', {},
      panel(kindName[receipt.kind], row('店舗名', receipt.storeName || '未入力'), row('日付', receipt.day), row('合計', yen(receipt.total), 'large'),
        receipt.lines.map((l) => row(`${l.name}（${L.categoryName(app.store.data, l.categoryID)}）`, yen(l.amount)))),
      images,
      h('div', { className: 'actions' },
        receipt.files.length ? button('原本を削除', async () => {
          if (!(await confirmSheet('レシートの原本を削除しますか？', '画像は元に戻せません。支出の記録は残ります。', '原本を削除する'))) return;
          if (await app.perform(async () => { await app.store.deleteReceiptFiles(id); return true; })) done();
        }, 'danger', { id: 'delete-original' }) : null,
        button('閉じる', done, 'gold')));
  }, { className: 'full', head: 'receipt' });
}
