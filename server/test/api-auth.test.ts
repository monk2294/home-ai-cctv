import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, login } from './helpers.js';
import { PtzService } from '../src/ptz/service.js';
import { SseHub } from '../src/events/sse.js';
import { EventService } from '../src/events/service.js';
import { buildApp } from '../src/app.js';

describe('Изоляция прав camera/AI API (T-13, security checks)', () => {
  let app: FastifyInstance;
  let close: () => Promise<void>;

  before(async () => {
    const ctx = await buildTestApp();
    const notImplemented = (async (): Promise<never> => {
      throw new Error('not implemented in auth test');
    }) as never;
    app = await buildApp({
      db: ctx.handle,
      auth: ctx.auth,
      aiApiToken: 'test-ai-token-0123456789abcdefghijklmnopqrstuvwxyz',
      sessionCookieSecure: false,
      logLevel: 'error',
      loggerEnabled: false,
      migrationsDone: () => true,
      media: { checkAvailability: async () => 'ok' },
      cameras: {
        manager: {
          listCameras: () => [],
          getCamera: notImplemented,
          streamName: (id: string) => `cam_${id}`,
          snapshot: notImplemented,
        } as never,
        ptz: new PtzService(),
        events: new EventService(ctx.handle.db),
        sse: new SseHub(),
        openMjpeg: notImplemented,
        audio: { capture: notImplemented, playback: notImplemented },
      },
    });
    close = ctx.close;
  });
  after(async () => {
    await app.close();
    await close();
  });

  test('аноним не получает camera API (401)', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/cameras'],
      ['POST', '/api/v1/cameras'],
      ['GET', '/api/v1/cameras/123/snapshot.jpg'],
      ['GET', '/api/v1/cameras/123/events'],
      ['GET', '/api/v1/events'],
      ['POST', '/api/v1/cameras/123/ptz/move'],
    ] as const) {
      const response = await app.inject({ method: method as 'GET', url });
      assert.equal(response.statusCode, 401, `${method} ${url}: ожидался 401, получен ${response.statusCode}`);
    }
  });

  test('AI Bearer не даёт admin API (401), но даёт AI snapshot (до handler-а)', async () => {
    const bearer = { authorization: 'Bearer test-ai-token-0123456789abcdefghijklmnopqrstuvwxyz' };
    const denied = await app.inject({ method: 'GET', url: '/api/v1/cameras', headers: bearer });
    assert.equal(denied.statusCode, 401);
    const deniedPtz = await app.inject({ method: 'POST', url: '/api/v1/cameras/123/ptz/move', headers: bearer, payload: { pan: 1, tilt: 0, zoom: 0 } });
    assert.equal(deniedPtz.statusCode, 401);
  });

  test('admin cookie не даёт AI API (401)', async () => {
    const cookie = await login(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/ai/cameras/123/snapshot.jpg',
      headers: { cookie },
    });
    assert.equal(response.statusCode, 401);
    const mjpeg = await app.inject({
      method: 'GET',
      url: '/api/v1/ai/cameras/123/stream.mjpeg',
      headers: { cookie },
    });
    assert.equal(mjpeg.statusCode, 401);
  });

  test('неверный Bearer даёт 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/ai/cameras/123/snapshot.jpg',
      headers: { authorization: 'Bearer wrong-token' },
    });
    assert.equal(response.statusCode, 401);
  });

  test('admin cookie открывает camera list (200)', async () => {
    const cookie = await login(app);
    const response = await app.inject({ method: 'GET', url: '/api/v1/cameras', headers: { cookie } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), []);
  });
});
