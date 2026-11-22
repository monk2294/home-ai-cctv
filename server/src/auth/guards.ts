import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthService } from './service.js';
import { AuthError } from './service.js';
import { tokensEqual } from './tokens.js';

export const SESSION_COOKIE = 'homecctv_session';

export function parseSessionCookie(request: FastifyRequest): string | null {
  const header = request.headers.cookie;
  if (!header) {
    return null;
  }
  for (const part of header.split(';')) {
    const eqIndex = part.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }
    const name = part.slice(0, eqIndex).trim();
    if (name === SESSION_COOKIE) {
      const value = part.slice(eqIndex + 1).trim();
      return value.length > 0 ? decodeURIComponent(value) : null;
    }
  }
  return null;
}

export function buildSessionCookie(token: string, secure: boolean, maxAgeSec: number): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function buildLogoutCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/** Требует действующую администраторскую сессию. Единый 401 (раздел 8.3). */
export function requireAdmin(auth: AuthService) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const token = parseSessionCookie(request);
    const session = token ? auth.verifySession(token) : null;
    if (!session) {
      throw new AuthError(401, 'UNAUTHORIZED', 'Требуется вход администратора.');
    }
    request.adminSession = session;
  };
}

/** Проверяет Bearer-токен ИИ. Даёт доступ только к /api/v1/ai/* (раздел 8.2). */
export function requireAiToken(aiApiToken: string) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization;
    let provided: string | null = null;
    if (header && header.startsWith('Bearer ')) {
      provided = header.slice('Bearer '.length).trim();
    }
    if (!provided || !tokensEqual(provided, aiApiToken)) {
      throw new AuthError(401, 'UNAUTHORIZED', 'Требуется действующий Bearer-токен.');
    }
  };
}
