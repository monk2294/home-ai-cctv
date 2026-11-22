import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { decryptSecret, encryptSecret } from '../src/db/crypto.js';

const KEY = Buffer.alloc(32, 7);

describe('AES-256-GCM для секретов камер', () => {
  test('roundtrip шифрования и дешифрования', () => {
    const ciphertext = encryptSecret('s3cret-пароль', KEY);
    assert.notEqual(ciphertext, 's3cret-пароль');
    assert.equal(decryptSecret(ciphertext, KEY), 's3cret-пароль');
  });

  test('каждая операция использует новый nonce', () => {
    const a = encryptSecret('same', KEY);
    const b = encryptSecret('same', KEY);
    assert.notEqual(a, b);
  });

  test('подмена ciphertext обнаруживается', () => {
    const ciphertext = encryptSecret('secret', KEY);
    const raw = Buffer.from(ciphertext, 'base64');
    const last = raw.length - 1;
    raw[last] = (raw[last] ?? 0) ^ 0xff;
    assert.throws(() => decryptSecret(raw.toString('base64'), KEY));
  });

  test('другой ключ не дешифрует', () => {
    const ciphertext = encryptSecret('secret', KEY);
    const otherKey = Buffer.alloc(32, 8);
    assert.throws(() => decryptSecret(ciphertext, otherKey));
  });

  test('отклоняет короткий payload и неизвестную версию', () => {
    assert.throws(() => decryptSecret('AAAA', KEY));
    const raw = Buffer.from(encryptSecret('x', KEY), 'base64');
    raw[0] = 99;
    assert.throws(() => decryptSecret(raw.toString('base64'), KEY), /версия/);
  });
});
