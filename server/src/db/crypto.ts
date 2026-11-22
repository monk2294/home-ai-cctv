import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 1;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

/** Шифрует строку через AES-256-GCM. Формат: version || nonce || tag || ciphertext (base64). */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), nonce, tag, ciphertext]).toString('base64');
}

/** Расшифровывает значение из encryptSecret. */
export function decryptSecret(payload: string, key: Buffer): string {
  const raw = Buffer.from(payload, 'base64');
  if (raw.length < 1 + NONCE_LENGTH + TAG_LENGTH + 1) {
    throw new Error('Неверный формат зашифрованного значения');
  }
  const version = raw[0];
  if (version !== VERSION) {
    throw new Error(`Неподдерживаемая версия шифра: ${version}`);
  }
  const nonce = raw.subarray(1, 1 + NONCE_LENGTH);
  const tag = raw.subarray(1 + NONCE_LENGTH, 1 + NONCE_LENGTH + TAG_LENGTH);
  const ciphertext = raw.subarray(1 + NONCE_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
