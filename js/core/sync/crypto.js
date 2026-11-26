// 同期の鍵と暗号化。暗号の鍵は端末の外に出さない。置き場（サーバー）は中身を読めない。
// 同期キー（256ビットの乱数）から、HKDF で「暗号の鍵」「認証の合言葉」「保管庫の番号」を作る。

const LETTERS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // 読み間違えやすい I L O U を除く
const text = new TextEncoder();
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
export const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function encode32(bytes) {
  let out = '', bits = 0, value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += LETTERS[(value >>> (bits - 5)) & 31]; bits -= 5; }
    value &= (1 << bits) - 1;
  }
  if (bits) out += LETTERS[(value << (5 - bits)) & 31];
  return out;
}

function decode32(string, length) {
  const out = new Uint8Array(length);
  let bits = 0, value = 0, at = 0;
  for (const c of string) {
    value = (value << 5) | LETTERS.indexOf(c); bits += 5;
    if (bits >= 8 && at < length) { out[at++] = (value >>> (bits - 8)) & 255; bits -= 8; }
    value &= (1 << bits) - 1;
  }
  return out;
}

/** 同期キー（打ち間違いを見つけられる確認の文字つき） */
export async function formatKey(raw) {
  const check = (await sha256(raw)).subarray(0, 2);
  const joined = new Uint8Array(34);
  joined.set(raw); joined.set(check, 32);
  return `ZR1-${encode32(joined).match(/.{1,5}/g).join('-')}`;
}
export const makeKey = () => random(32);

export async function parseKey(input) {
  let s = String(input).normalize('NFKC').toUpperCase().replace(/[\s-]/g, '');
  if (s.startsWith('ZR1')) s = s.slice(3);
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== 55 || [...s].some((c) => !LETTERS.includes(c))) throw new Error('同期キーの文字数か文字が正しくありません。');
  const bytes = decode32(s, 34);
  const raw = bytes.slice(0, 32);
  const check = (await sha256(raw)).subarray(0, 2);
  if (check[0] !== bytes[32] || check[1] !== bytes[33]) throw new Error('同期キーに打ち間違いがあります。');
  return raw;
}

export async function deriveKeys(raw) {
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const params = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: text.encode('zairyaku-sync-v1'), info: text.encode(info) });
  const key = await crypto.subtle.deriveKey(params('encrypt'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); // 取り出せない鍵
  const token = base64url(new Uint8Array(await crypto.subtle.deriveBits(params('authenticate'), base, 256)));
  const vault = hex(new Uint8Array(await crypto.subtle.deriveBits(params('vault'), base, 128)));
  return { key, token, vault };
}

const through = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

/** 何をどの版として保存するかを認証する（入れ替えや古い版への差し替えを見つける） */
export const context = (vault, kind, name, version = 0) => `zairyaku:v1:${vault}:${kind}:${name}:${version}`;

export async function seal(key, bytes, aad, { compress = false } = {}) {
  const body = compress ? await through(bytes, new CompressionStream('gzip')) : bytes;
  const iv = random(12);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: text.encode(aad) }, key, body));
  const out = new Uint8Array(14 + sealed.length);
  out[0] = 1; out[1] = compress ? 1 : 0; out.set(iv, 2); out.set(sealed, 14);
  return out;
}

/** 開けない（鍵が違う・改ざん・版の取り違え）ときは例外 */
export async function open(key, data, aad) {
  if (data.length < 30 || data[0] !== 1) throw new Error('暗号化されたデータの形式が違います。');
  const body = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.subarray(2, 14), additionalData: text.encode(aad) }, key, data.subarray(14)));
  return data[1] ? through(body, new DecompressionStream('gzip')) : body;
}
