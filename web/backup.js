const FORMAT = 'fingerprint-browser/encrypted-backup';
const ITERATIONS = 600000;
const encoder = new TextEncoder();
const aad = encoder.encode(FORMAT + '/1');

// The service accepts at most 20 MiB of JSON. Allow for Base64 on disk.
const maxPayload = 20 * 1024 * 1024;
export const maxFileSize = 4 * Math.ceil((maxPayload + 16) / 3) + 4096;

function base64(bytes) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  }
  return btoa(chunks.join(''));
}

function unbase64(value) {
  if (typeof value !== 'string') throw new Error('备份文件缺少加密数据');
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}

async function keyFor(password, salt) {
  if (!crypto.subtle) throw new Error('当前浏览器无法加解密，请在本机管理端打开此页面');
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptBackup(payload, password) {
  const plain = encoder.encode(JSON.stringify(payload));
  if (plain.length > maxPayload) throw new Error('配置超过管理端导入上限 20 MiB');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFor(password, salt);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plain);
  return { format: FORMAT, version: 1, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS,
    cipher: 'AES-256-GCM', salt: base64(salt), iv: base64(iv), ciphertext: base64(new Uint8Array(cipher)) };
}

export function isEncryptedBackup(value) {
  return value?.format === FORMAT;
}

export async function decryptBackup(value, password) {
  if (!isEncryptedBackup(value) || value.version !== 1 || value.iterations !== ITERATIONS
      || value.kdf !== 'PBKDF2-SHA256' || value.cipher !== 'AES-256-GCM') {
    throw new Error('不支持的加密备份格式或版本');
  }
  let salt, iv, cipher;
  try {
    salt = unbase64(value.salt);
    iv = unbase64(value.iv);
    cipher = unbase64(value.ciphertext);
  } catch {
    throw new Error('加密备份数据损坏');
  }
  if (salt.length !== 16 || iv.length !== 12 || cipher.length < 16 || cipher.length > maxPayload + 16) {
    throw new Error('加密备份数据长度异常');
  }
  const key = await keyFor(password, salt);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, cipher);
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new Error('备份密码错误或文件已损坏');
  }
}
