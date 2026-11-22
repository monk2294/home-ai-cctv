import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { TestContext } from './helpers.js';
import { buildTestApp } from './helpers.js';

describe('Health endpoints', () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await buildTestApp({ mediaAvailable: true });
  });
  after(async () => {
    await ctx.close();
  });

  test('live возвращает ok без диагностики секретов', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/health/live' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok', components: { process: 'ok' } });
  });

  test('ready возвращает ready при доступных компонентах', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { status: string; components: Record<string, string> };
    assert.equal(body.status, 'ready');
    assert.deepEqual(body.components, { database: 'ok', migrations: 'ok', media: 'ok' });
  });

  test('недоступный media даёт degraded, но не 503', async () => {
    const degradedCtx = await buildTestApp({ mediaAvailable: false });
    try {
      const response = await degradedCtx.app.inject({ method: 'GET', url: '/api/v1/health/ready' });
      assert.equal(response.statusCode, 200);
      const body = response.json() as { status: string; components: Record<string, string> };
      assert.equal(body.status, 'degraded');
      assert.equal(body.components.media, 'unavailable');
    } finally {
      await degradedCtx.close();
    }
  });

  test('неприменённые миграции дают not_ready и 503', async () => {
    const notReadyCtx = await buildTestApp({ migrationsDone: false });
    try {
      const response = await notReadyCtx.app.inject({ method: 'GET', url: '/api/v1/health/ready' });
      assert.equal(response.statusCode, 503);
      const body = response.json() as { status: string };
      assert.equal(body.status, 'not_ready');
    } finally {
      await notReadyCtx.close();
    }
  });
});
