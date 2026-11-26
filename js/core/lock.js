// アプリロックの計算。パスコードと復元コードは、そのまま保存せず、変換した値だけを端末に置く。
// 画面を開けないようにする仕組みで、保存データそのものは暗号化しない。
export const ITERATIONS = 310000;
export const TIMEOUTS = { 0: 'すぐ', 60: '1分後', 300: '5分後', 900: '15分後' };

const toBase64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const random = (n) => crypto.getRandomValues(new Uint8Array(n));

async function derive(secret, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveBits']);
  return toBase64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

/** 使えないパスコードなら理由を返す */
export function passcodeProblem(code) {
  if (!/^\d{6,12}$/.test(code)) return 'パスコードは6〜12桁の数字にしてください。';
  if (/^(\d)\1+$/.test(code) || '01234567890123456789'.includes(code) || '98765432109876543210'.includes(code)) return '同じ数字や順番に並んだ数字は使えません。';
  return null;
}

/** 復元コード：読み間違えにくい文字16個（4文字ずつ） */
export function makeRecoveryCode() {
  const letters = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const out = [];
  while (out.length < 16) {
    for (const b of random(32)) if (b < letters.length * Math.floor(256 / letters.length) && out.length < 16) out.push(letters[b % letters.length]);
  }
  return out.join('').match(/.{4}/g).join('-');
}
export const normalizeRecovery = (text) => String(text).normalize('NFKC').toUpperCase().replace(/[^0-9A-Z]/g, '');

export async function createLock(passcode, { iterations = ITERATIONS, timeout = 60 } = {}) {
  const problem = passcodeProblem(passcode);
  if (problem) throw new Error(problem);
  const code = makeRecoveryCode();
  const salt = random(16), recoverySalt = random(16);
  return {
    code,
    record: {
      version: 1, iterations, timeout, failures: 0, blockedUntil: 0, salt: toBase64(salt), hash: await derive(passcode, salt, iterations),
      recoverySalt: toBase64(recoverySalt), recoveryHash: await derive(normalizeRecovery(code), recoverySalt, iterations),
    },
  };
}

/** 失敗が続いたときの待ち時間（秒） */
export const delayAfter = (failures) => (failures < 5 ? 0 : failures === 5 ? 30 : failures === 6 ? 60 : 300);

/**
 * パスコードか復元コードを確かめる。結果 { ok, wait, record }。record は失敗回数などを更新したもの。
 */
export async function check(record, secret, { recovery = false, now = Date.now() } = {}) {
  if (record.blockedUntil > now) return { ok: false, wait: Math.ceil((record.blockedUntil - now) / 1000), record };
  const value = await derive(recovery ? normalizeRecovery(secret) : secret, fromBase64(recovery ? record.recoverySalt : record.salt), record.iterations);
  if (value === (recovery ? record.recoveryHash : record.hash)) return { ok: true, wait: 0, record: { ...record, failures: 0, blockedUntil: 0 } };
  const failures = record.failures + 1;
  const wait = delayAfter(failures);
  return { ok: false, wait, record: { ...record, failures, blockedUntil: wait ? now + wait * 1000 : 0 } };
}

export const shouldLock = (hiddenAt, now, timeout) => hiddenAt != null && now - hiddenAt >= timeout * 1000;

// ---- Face ID・Touch ID（端末の本人確認。WebAuthn。サーバーは使わない）

/** IPアドレスの住所（127.0.0.1 など）では使えない */
export async function biometricAvailable(host = globalThis.location?.hostname ?? '') {
  if (!globalThis.PublicKeyCredential || !globalThis.navigator?.credentials || /^[\d.]+$|:/.test(host)) return false;
  try { return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch { return false; }
}

export async function registerBiometric(credentials = navigator.credentials) {
  const made = await credentials.create({ publicKey: {
    challenge: random(32), rp: { name: '財略三成' }, user: { id: random(16), name: 'zairyaku-lock', displayName: '財略三成のロック解除' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' }, timeout: 60000,
  } });
  if (!made) throw new Error('登録できませんでした。');
  return toBase64(made.rawId);
}

/** 本人確認ができたら true。端末が「本人を確認した」と答えた場合だけ。 */
export async function verifyBiometric(credentialID, credentials = navigator.credentials) {
  const challenge = random(32);
  const result = await credentials.get({ publicKey: { challenge, allowCredentials: [{ type: 'public-key', id: fromBase64(credentialID) }], userVerification: 'required', timeout: 60000 } });
  if (!result) return false;
  const client = JSON.parse(new TextDecoder().decode(result.response.clientDataJSON));
  const expected = toBase64(challenge).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const flags = new Uint8Array(result.response.authenticatorData)[32];
  return client.type === 'webauthn.get' && client.challenge === expected && (flags & 0x04) !== 0;
}
