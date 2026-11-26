// バックアップ（記録とレシート原本を1つのファイルに）と、合言葉による暗号化（AES-GCM。合言葉は保存しない）。
import { parseLedger, LedgerError } from './store.js';

const FORMAT = 'zairyaku-backup';
const ENCRYPTED = 'zairyaku-backup-encrypted';
export const ITERATIONS = 600000;

export function toBase64(bytes) {
  const data = new Uint8Array(bytes);
  let text = '';
  for (let i = 0; i < data.length; i += 0x8000) text += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(text);
}
export function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const safeName = /^[0-9A-F-]{36}\.(jpg|pdf)$/;

export async function makeBackup(store) {
  const files = {};
  const missing = [];
  for (const name of new Set(store.data.receipts.flatMap((r) => r.files))) {
    const data = await store.persistence.file(name);
    if (data) files[name] = toBase64(data); else missing.push(name);
  }
  return { text: JSON.stringify({ format: FORMAT, version: 1, createdAt: store.now(), ledger: store.data, files }), count: Object.keys(files).length, missing: missing.length };
}

async function key(password, salt, iterations) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encrypt(text, password) {
  if (password.length < 8) throw new LedgerError('合言葉は8文字以上にしてください。');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(password, salt, ITERATIONS), new TextEncoder().encode(text));
  return JSON.stringify({ format: ENCRYPTED, version: 1, iterations: ITERATIONS, salt: toBase64(salt), iv: toBase64(iv), data: toBase64(data) });
}

export const isEncrypted = (text) => { try { return JSON.parse(text).format === ENCRYPTED; } catch { return false; } };

async function decrypt(box, password) {
  if (!Number.isInteger(box.iterations) || box.iterations < 100000 || box.iterations > 5000000) throw new LedgerError('暗号化の形式が正しくありません。');
  try {
    const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(box.iv) }, await key(password, fromBase64(box.salt), box.iterations), fromBase64(box.data));
    return new TextDecoder().decode(data);
  } catch { throw new LedgerError('合言葉が違うか、ファイルが壊れています。'); }
}

/** バックアップ、暗号化バックアップ、Mac版の ledger.json を読み取る。内容を検査してから返す。 */
export async function readBackup(text, password = null) {
  let box;
  try { box = JSON.parse(text); } catch { throw new LedgerError('ファイルを読み込めません。財略三成のバックアップか確認してください。'); }
  if (box?.format === ENCRYPTED) {
    if (!password) throw new LedgerError('合言葉が必要です。');
    return readBackup(await decrypt(box, password));
  }
  if (box?.format !== FORMAT) { parseLedger(text); return { ledgerText: text, files: [], createdAt: null }; }
  if (box.version !== 1) throw new LedgerError('新しい形式のバックアップです。アプリを更新してください。');
  const ledgerText = JSON.stringify(box.ledger);
  parseLedger(ledgerText);
  const files = Object.entries(box.files ?? {}).map(([name, base64]) => {
    if (!safeName.test(name)) throw new LedgerError('バックアップの中のファイル名が正しくありません。');
    return { name, data: fromBase64(base64).buffer };
  });
  return { ledgerText, files, createdAt: box.createdAt };
}
