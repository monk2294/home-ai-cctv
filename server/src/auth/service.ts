import { eq, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { adminSessions, adminUsers } from '../db/schema.js';
import { hashAdminPassword, verifyAdminPassword } from './passwords.js';
import { hashToken, newSessionToken } from './tokens.js';

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_TTL_MS = 24 * 60 * 60 * 1000;
export const ADMIN_USERNAME = 'admin';

export interface SessionInfo {
  username: string;
  expiresAt: string;
}

/** Результат успешного входа. sessionToken передаётся только в Set-Cookie. */
export interface CreatedSession extends SessionInfo {
  sessionToken: string;
}

export class AuthError extends Error {
  constructor(
    public readonly statusCode: 401 | 429,
    public readonly code: 'UNAUTHORIZED' | 'TOO_MANY_LOGIN_ATTEMPTS',
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

interface RateBucket {
  count: number;
  resetAt: number;
}

const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Вход, выход, сессии администратора и первичный bootstrap.
 * Bearer-токен ИИ проверяет отдельный guard (bearer.ts).
 */
export class AuthService {
  private readonly loginBuckets = new Map<string, RateBucket>();

  constructor(
    private readonly db: Db,
    private readonly bootstrapPassword: string,
  ) {}

  /** Создаёт запись admin при первом запуске. Повторный вызов — no-op. */
  async bootstrapAdmin(): Promise<void> {
    const existing = this.db.select().from(adminUsers).all();
    if (existing.length > 0) {
      return;
    }
    if (this.bootstrapPassword.length < 12) {
      throw new Error('Пароль администратора из ADMIN_PASSWORD_FILE короче 12 символов');
    }
    const passwordHash = await hashAdminPassword(this.bootstrapPassword);
    this.db.insert(adminUsers).values({ username: ADMIN_USERNAME, passwordHash, createdAt: nowIso() }).run();
  }

  private checkLoginRateLimit(ip: string): void {
    const now = Date.now();
    const bucket = this.loginBuckets.get(ip);
    if (bucket && bucket.resetAt > now && bucket.count >= RATE_LIMIT_MAX_ATTEMPTS) {
      throw new AuthError(429, 'TOO_MANY_LOGIN_ATTEMPTS', 'Слишком много попыток входа. Повторите позже.');
    }
  }

  private recordLoginFailure(ip: string): void {
    const now = Date.now();
    let bucket = this.loginBuckets.get(ip);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
      this.loginBuckets.set(ip, bucket);
    }
    bucket.count += 1;
  }

  private clearLoginFailures(ip: string): void {
    this.loginBuckets.delete(ip);
  }

  /** Единый 401 для неверного логина и неверной сессии (раздел 8.3). */
  async login(username: string, password: string, ip: string): Promise<CreatedSession> {
    this.checkLoginRateLimit(ip);
    // Намеренная непостоянность времени: argon2.verify выполняется всегда.
    const rows = this.db.select().from(adminUsers).where(eq(adminUsers.username, username)).all();
    const user = rows[0];
    const passwordValid = user ? await verifyAdminPassword(user.passwordHash, password) : false;
    if (!user || !passwordValid) {
      this.recordLoginFailure(ip);
      throw new AuthError(401, 'UNAUTHORIZED', 'Неверное имя пользователя или пароль.');
    }
    this.clearLoginFailures(ip);

    const token = newSessionToken();
    const createdAtMs = Date.now();
    const expiresAtMs = createdAtMs + SESSION_TTL_MS;
    this.db
      .insert(adminSessions)
      .values({
        tokenHash: hashToken(token),
        createdAt: new Date(createdAtMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        absoluteExpiresAt: new Date(createdAtMs + SESSION_ABSOLUTE_TTL_MS).toISOString(),
      })
      .run();

    return { username, expiresAt: new Date(expiresAtMs).toISOString(), sessionToken: token };
  }

  /**
   * Проверяет сессию и продлевает её (sliding expiration до абсолютного потолка).
   * Возвращает null для истёкшей или отсутствующей сессии.
   */
  verifySession(token: string): SessionInfo | null {
    const rows = this.db.select().from(adminSessions).where(eq(adminSessions.tokenHash, hashToken(token))).all();
    const session = rows[0];
    if (!session) {
      return null;
    }
    const nowMs = Date.now();
    if (nowMs >= Date.parse(session.absoluteExpiresAt) || nowMs >= Date.parse(session.expiresAt)) {
      this.db.delete(adminSessions).where(eq(adminSessions.tokenHash, session.tokenHash)).run();
      return null;
    }
    const nextExpiryMs = Math.min(nowMs + SESSION_TTL_MS, Date.parse(session.absoluteExpiresAt));
    if (nextExpiryMs > Date.parse(session.expiresAt)) {
      this.db
        .update(adminSessions)
        .set({ expiresAt: new Date(nextExpiryMs).toISOString() })
        .where(eq(adminSessions.tokenHash, session.tokenHash))
        .run();
    }
    return { username: ADMIN_USERNAME, expiresAt: new Date(nextExpiryMs).toISOString() };
  }

  logout(token: string): void {
    this.db.delete(adminSessions).where(eq(adminSessions.tokenHash, hashToken(token))).run();
  }

  /** Удаляет истёкшие сессии. Вызывается периодически. */
  purgeExpiredSessions(): void {
    this.db.delete(adminSessions).where(lt(adminSessions.expiresAt, nowIso())).run();
  }
}
