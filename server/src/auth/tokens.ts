import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTES = 32; // не менее 256 бит энтропии (спецификация 10, раздел 8.1)

/** Генерирует opaque session token. */
export function newSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** SHA-256 hex от токена — единственное, что попадает в SQLite. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Сравнивает Bearer-токен с ожидаемым за постоянное время (раздел 8.2). */
export function tokensEqual(provided: string, expected: string): boolean {
  // codeql[js/insufficient-password-hash]: SHA-256 применяется к высокоэнтропийному token, а не к паролю.
  const a = createHash('sha256').update(provided, 'utf8').digest();
  // codeql[js/insufficient-password-hash]: Hash нужен для timing-safe comparison одинаковой длины, не для password storage.
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}
