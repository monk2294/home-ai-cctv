import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildStageTestApp, cameraCreateInput, login, TEST_AI_TOKEN } from './helpers.js';

const yamlPath = fileURLToPath(new URL('../../docs/specs/contracts/api-v1.openapi.yaml', import.meta.url));
const genTypesPath = fileURLToPath(new URL('../src/generated/api-v1.d.ts', import.meta.url));

test('контракт v1.1.0 содержит маршруты этапа 2', () => {
  const yaml = readFileSync(yamlPath, 'utf8');
  assert.match(yaml, /^  version: 1\.1\.0$/m);
  for (const route of [
    '  /api/v1/ai/cameras:',
    '  /api/v1/ai/cameras/{camera_id}/audio.wav:',
    '  /api/v1/ai/cameras/{camera_id}/audio/play:',
    '  /api/v1/ai/cameras/{camera_id}/ptz/move:',
    '  /api/v1/cameras/{camera_id}/audio/play:',
  ]) {
    assert.ok(yaml.includes(route), `в контракте нет ${route.trim()}`);
  }
});

test('сгенерированные типы содержат новые схемы', () => {
  const types = readFileSync(genTypesPath, 'utf8');
  for (const name of ['AudioPlayback', 'AiCamera', 'CameraCapabilities']) {
    assert.ok(types.includes(`${name}: {`), `нет схемы ${name}`);
  }
  assert.ok(types.includes('CapabilityState: "supported"'), 'нет схемы CapabilityState');
  assert.ok(types.includes('audio_output: components["schemas"]["CapabilityState"]'), 'CameraCapabilities без audio_output');
});

test('сервер реализует все маршруты контракта этапа 2', async () => {
  const ctx = await buildStageTestApp();
  try {
    const camera = await ctx.manager.create(cameraCreateInput('Контракт-камера'));
    const cookie = await login(ctx.app);
    const ai = { authorization: `Bearer ${TEST_AI_TOKEN}` };

    const probes: Array<{ method: 'GET' | 'POST' | 'DELETE'; url: string; expect: number[] }> = [
      { method: 'GET', url: '/api/v1/ai/cameras', expect: [200] },
      { method: 'GET', url: `/api/v1/ai/cameras/${camera.id}`, expect: [200] },
      { method: 'GET', url: `/api/v1/ai/cameras/${camera.id}/audio.wav`, expect: [200, 502] },
      { method: 'POST', url: `/api/v1/ai/cameras/${camera.id}/audio/play`, expect: [415, 422] },
      { method: 'DELETE', url: `/api/v1/ai/cameras/${camera.id}/audio/play/00000000-0000-4000-8000-000000000001`, expect: [404] },
      { method: 'POST', url: `/api/v1/ai/cameras/${camera.id}/ptz/move`, expect: [400, 422] },
      { method: 'POST', url: `/api/v1/ai/cameras/${camera.id}/ptz/stop`, expect: [204] },
      { method: 'GET', url: `/api/v1/ai/cameras/${camera.id}/ptz/presets`, expect: [200] },
      { method: 'POST', url: `/api/v1/cameras/${camera.id}/audio/play`, expect: [415, 422] },
    ];
    for (const probe of probes) {
      const headers: Record<string, string> = probe.url.startsWith('/api/v1/ai/') ? { authorization: ai.authorization! } : { cookie };
      const res = await ctx.app.inject({ method: probe.method, url: probe.url, headers });
      assert.ok(
        probe.expect.includes(res.statusCode),
        `${probe.method} ${probe.url}: ${res.statusCode}, ожидалось ${probe.expect.join('/')}`,
      );
      assert.ok(res.headers['x-request-id'], `нет X-Request-ID на ${probe.method} ${probe.url}`);
    }
  } finally {
    await ctx.close();
  }
});
