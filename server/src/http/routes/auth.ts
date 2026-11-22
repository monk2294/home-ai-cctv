import type { FastifyInstance } from 'fastify';
import type { AuthService, CreatedSession } from '../../auth/service.js';
import { AuthError } from '../../auth/service.js';
import { buildLogoutCookie, buildSessionCookie, parseSessionCookie } from '../../auth/guards.js';

interface AuthRouteDeps {
  auth: AuthService;
  sessionCookieSecure: boolean;
}

const loginSchema = {
  body: {
    type: 'object',
    required: ['username', 'password'],
    additionalProperties: false,
    properties: {
      username: { type: 'string', enum: ['admin'] },
      password: { type: 'string', minLength: 1, maxLength: 1024 },
    },
  },
} as const;

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  app.post('/api/v1/auth/session', { schema: loginSchema }, async (request, reply) => {
    const body = request.body as { username: string; password: string };
    const session: CreatedSession = await deps.auth.login(body.username, body.password, request.clientIp);
    const maxAgeSec = Math.max(0, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000));
    void reply.header('Set-Cookie', buildSessionCookie(session.sessionToken, deps.sessionCookieSecure, maxAgeSec));
    return reply.status(200).send({ username: session.username, expires_at: session.expiresAt });
  });

  app.delete('/api/v1/auth/session', async (request, reply) => {
    const token = parseSessionCookie(request);
    if (!token) {
      throw new AuthError(401, 'UNAUTHORIZED', 'Требуется действующая сессия администратора.');
    }
    deps.auth.logout(token);
    void reply.header('Set-Cookie', buildLogoutCookie(deps.sessionCookieSecure));
    return reply.status(204).send();
  });

  // Endpoint для Caddy forward_auth (спецификация 30, раздел 4).
  app.get('/api/v1/auth/verify', async (request, reply) => {
    const token = parseSessionCookie(request);
    const session = token ? deps.auth.verifySession(token) : null;
    if (!session) {
      throw new AuthError(401, 'UNAUTHORIZED', 'Требуется действующая сессия администратора.');
    }
    return reply.status(204).send();
  });
}
