import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { TestContext } from './helpers.js';
import { buildTestApp, login, TEST_ADMIN_PASSWORD } from './helpers.js';

function sessionCookieFrom(setCookie: string | string[] | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(header, 'Set-Cookie отсутствует');
  return header;
}

describe('Авторизация администратора', () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await buildTestApp();
  });
  after(async () => {
    await ctx.close();
  });

  test('успешный вход возвращает AuthSession и HttpOnly cookie', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      payload: { username: 'admin', password: TEST_ADMIN_PASSWORD },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { username: string; expires_at: string };
    assert.equal(body.username, 'admin');
    assert.match(body.expires_at, /Z$/);

    const cookie = sessionCookieFrom(response.headers['set-cookie']);
    const pair = cookie.split(';')[0] ?? '';
    assert.match(pair, /^homecctv_session=[A-Za-z0-9_-]+$/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Max-Age=\d+/);
    assert.doesNotMatch(cookie, /Secure/);
  });

  test('неверный пароль даёт общий 401 без cookie', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      remoteAddress: '10.10.0.2',
      payload: { username: 'admin', password: 'wrong-password' },
    });
    assert.equal(response.statusCode, 401);
    const body = response.json() as { code: string };
    assert.equal(body.code, 'UNAUTHORIZED');
    assert.equal(response.headers['set-cookie'], undefined);
  });

  test('verify принимает действующую сессию и отклоняет отсутствующую', async () => {
    const cookie = await login(ctx.app);
    const ok = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/verify', headers: { cookie } });
    assert.equal(ok.statusCode, 204);

    const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/verify' });
    assert.equal(anonymous.statusCode, 401);
  });

  test('logout удаляет сессию на сервере', async () => {
    const cookie = await login(ctx.app);
    const logout = await ctx.app.inject({ method: 'DELETE', url: '/api/v1/auth/session', headers: { cookie } });
    assert.equal(logout.statusCode, 204);

    const afterVerify = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/verify', headers: { cookie } });
    assert.equal(afterVerify.statusCode, 401);
  });

  test('logout без cookie возвращает 401', async () => {
    const response = await ctx.app.inject({ method: 'DELETE', url: '/api/v1/auth/session' });
    assert.equal(response.statusCode, 401);
  });

  test('после 5 неудачных попыток вход блокируется с 429', async () => {
    for (let i = 0; i < 5; i += 1) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/session',
        remoteAddress: '10.10.0.9',
        payload: { username: 'admin', password: 'wrong' },
      });
      assert.equal(response.statusCode, 401);
    }
    const blocked = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      remoteAddress: '10.10.0.9',
      payload: { username: 'admin', password: TEST_ADMIN_PASSWORD },
    });
    assert.equal(blocked.statusCode, 429);
    const body = blocked.json() as { code: string };
    assert.equal(body.code, 'TOO_MANY_LOGIN_ATTEMPTS');
  });

  test('чужой Origin на мутирующем запросе даёт 403', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      remoteAddress: '10.10.0.3',
      headers: { origin: 'https://evil.example', host: 'localhost:8000' },
      payload: { username: 'admin', password: TEST_ADMIN_PASSWORD },
    });
    assert.equal(response.statusCode, 403);
  });

  test('совпадающий Origin проходит', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      remoteAddress: '10.10.0.4',
      headers: { origin: 'http://localhost:8000', host: 'localhost:8000' },
      payload: { username: 'admin', password: TEST_ADMIN_PASSWORD },
    });
    assert.equal(response.statusCode, 200);
  });

  test('невалидный JSON даёт единую обёртку Error с 422', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      payload: { username: 'admin' },
    });
    assert.equal(response.statusCode, 422);
    const body = response.json() as { code: string; request_id: string };
    assert.equal(body.code, 'VALIDATION_ERROR');
    assert.ok(body.request_id.length > 0);
  });
});

describe('Secure cookie', () => {
  test('SESSION_COOKIE_SECURE добавляет флаг Secure', async () => {
    const ctx = await buildTestApp({ sessionCookieSecure: true });
    try {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/session',
        payload: { username: 'admin', password: TEST_ADMIN_PASSWORD },
      });
      const cookie = sessionCookieFrom(response.headers['set-cookie']);
      assert.match(cookie, /Secure/);
    } finally {
      await ctx.close();
    }
  });
});
