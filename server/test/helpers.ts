import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth/service.js';
import { createDb, type DbHandle } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';

export const TEST_ADMIN_PASSWORD = 'test-admin-password-123';
export const TEST_AI_TOKEN = 'test-ai-token-0123456789abcdefghijklmnopqrstuvwxyz';

export interface TestContext {
  app: FastifyInstance;
  auth: AuthService;
  handle: DbHandle;
  close: () => Promise<void>;
}

export async function buildTestApp(options?: {
  sessionCookieSecure?: boolean;
  mediaAvailable?: boolean;
  migrationsDone?: boolean;
}): Promise<TestContext> {
  const handle = createDb(':memory:');
  runMigrations(handle.db);
  const auth = new AuthService(handle.db, TEST_ADMIN_PASSWORD);
  await auth.bootstrapAdmin();

  let migrationsDone = options?.migrationsDone ?? true;
  const app = await buildApp({
    db: handle,
    auth,
    aiApiToken: TEST_AI_TOKEN,
    sessionCookieSecure: options?.sessionCookieSecure ?? false,
    logLevel: 'error',
    loggerEnabled: false,
    migrationsDone: () => migrationsDone,
    media: {
      checkAvailability: async () => (options?.mediaAvailable ?? true ? 'ok' : 'unavailable'),
    },
  });

  return {
    app,
    auth,
    handle,
    close: async () => {
      await app.close();
      handle.close();
    },
  };
}

/** Выполняет вход и возвращает значение session cookie. */
export async function login(app: FastifyInstance, password: string = TEST_ADMIN_PASSWORD): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/session',
    payload: { username: 'admin', password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`login failed: ${response.statusCode} ${response.body}`);
  }
  const setCookie = response.headers['set-cookie'];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!cookieHeader) {
    throw new Error('login response has no Set-Cookie');
  }
  return cookieHeader.split(';')[0] ?? '';
}
