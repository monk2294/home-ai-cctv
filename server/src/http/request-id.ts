import { randomBytes } from 'node:crypto';

export const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Принимает только 1–128 символов A–Z a–z 0–9 . _ -. Иначе создаёт новый ID. */
export function resolveRequestId(header: unknown): string {
  if (typeof header === 'string' && REQUEST_ID_PATTERN.test(header)) {
    return header;
  }
  return `req_${randomBytes(18).toString('base64url')}`;
}

/** RFC 3339 UTC с суффиксом Z. */
export function nowIso(): string {
  return new Date().toISOString();
}
