import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  buildStageTestApp,
  cameraCreateInput,
  FAKE_JPEG,
  login,
  TEST_AI_TOKEN,
  type StageTestContext,
} from './helpers.js';

// --- фейковые ffmpeg/ffprobe: скрипты в tmp, PATH подменяется для spawn ---
const fakeBin = mkdtempSync(join(tmpdir(), 'stage2-bin-'));
writeFileSync(
  join(fakeBin, 'ffmpeg'),
  [
    '#!/bin/sh',
    'if [ -n "$FAKE_FFMPEG_FAIL" ]; then echo "fake ffmpeg fail" >&2; exit 1; fi',
    'if [ -n "$FAKE_FFMPEG_SLEEP" ]; then sleep "$FAKE_FFMPEG_SLEEP"; fi',
    'head -c "${FAKE_FFMPEG_BYTES:-32000}" /dev/zero',
  ].join('\n'),
);
writeFileSync(
  join(fakeBin, 'ffprobe'),
  [
    '#!/bin/sh',
    'if [ -n "$FAKE_FFPROBE_FAIL" ]; then echo "fake ffprobe fail" >&2; exit 1; fi',
    '# аргумент — путь к временному файлу; фейк его не читает, только печатает длительность',
    'printf \'{"format":{"duration":"%s"}}\' "${FAKE_FFPROBE_DURATION:-2.5}"',
  ].join('\n'),
);
chmodSync(join(fakeBin, 'ffmpeg'), 0o755);
chmodSync(join(fakeBin, 'ffprobe'), 0o755);
process.env.PATH = `${fakeBin}:${process.env.PATH ?? ''}`;

const aiHeaders = { authorization: `Bearer ${TEST_AI_TOKEN}` };

describe('Этап 2: AI discovery, PTZ, звук (T-23..T-25)', () => {
  let ctx: StageTestContext;
  let cameraId = '';
  let backchannelId = '';
  let adminCookie = '';

  before(async () => {
    ctx = await buildStageTestApp();
    const camA = await ctx.manager.create(cameraCreateInput('Камера A'));
    cameraId = camA.id;
    const camB = await ctx.manager.create(cameraCreateInput('Камера B'));
    backchannelId = camB.id;
    ctx.media.backchannelStreams.add(ctx.manager.streamName(camB.id));
    await ctx.manager.reconnect(camB.id);
    assert.equal(ctx.manager.getCamera(backchannelId).capabilities.audio_output, 'supported');
    assert.equal(ctx.manager.getCamera(cameraId).capabilities.audio_output, 'unsupported');
    adminCookie = await login(ctx.app);
  });

  after(async () => {
    await ctx.close();
  });

  describe('AI discovery (T-25)', () => {
    test('аноним и неверный токен — 401', async () => {
      const anon = await ctx.app.inject({ method: 'GET', url: '/api/v1/ai/cameras' });
      assert.equal(anon.statusCode, 401);
      const wrong = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/ai/cameras',
        headers: { authorization: 'Bearer wrong-token' },
      });
      assert.equal(wrong.statusCode, 401);
    });

    test('список без host, учётных данных и RTSP', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/ai/cameras', headers: aiHeaders });
      assert.equal(res.statusCode, 200);
      const items = res.json() as Record<string, unknown>[];
      assert.equal(items.length, 2);
      const item = items[0]!;
      assert.equal(typeof item.id, 'string');
      assert.equal(item.name, 'Камера A');
      assert.equal(item.state, 'online');
      for (const forbidden of ['host', 'username', 'password', 'profile_token', 'has_rtsp_override', 'onvif_port']) {
        assert.ok(!(forbidden in item), `поле ${forbidden} не должно попадать в AI-модель`);
      }
      const caps = item.capabilities as Record<string, string>;
      assert.equal(caps.audio_output, 'unsupported');
    });

    test('одна камера и 404 для неизвестного id', async () => {
      const ok = await ctx.app.inject({ method: 'GET', url: `/api/v1/ai/cameras/${backchannelId}`, headers: aiHeaders });
      assert.equal(ok.statusCode, 200);
      assert.equal((ok.json() as { capabilities: { audio_output: string } }).capabilities.audio_output, 'supported');
      const missing = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/ai/cameras/00000000-0000-4000-8000-000000000001',
        headers: aiHeaders,
      });
      assert.equal(missing.statusCode, 404);
      assert.equal((missing.json() as { code: string }).code, 'CAMERA_NOT_FOUND');
    });
  });

  describe('AI PTZ (T-24)', () => {
    test('move/stop/presets/goto через Bearer', async () => {
      const move = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/ai/cameras/${cameraId}/ptz/move`,
        headers: aiHeaders,
        payload: { pan: 0.5, tilt: 0, zoom: 0, duration_ms: 300 },
      });
      assert.equal(move.statusCode, 204);
      assert.deepEqual(ctx.onvif.ptzMoves.at(-1), [0.5, 0, 0]);
      await ctx.app.inject({ method: 'POST', url: `/api/v1/ai/cameras/${cameraId}/ptz/stop`, headers: aiHeaders });
      const presets = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/ai/cameras/${cameraId}/ptz/presets`,
        headers: aiHeaders,
      });
      assert.equal(presets.statusCode, 200);
      assert.deepEqual(presets.json(), [{ token: '7', name: 'Home' }]);
      const goto = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/ai/cameras/${cameraId}/ptz/presets/7/goto`,
        headers: aiHeaders,
      });
      assert.equal(goto.statusCode, 204);
      assert.deepEqual(ctx.onvif.gotoCalls, ['7']);
    });

    test('некорректная скорость — 422, неизвестная камера — 404', async () => {
      const bad = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/ai/cameras/${cameraId}/ptz/move`,
        headers: aiHeaders,
        payload: { pan: 2, tilt: 0, zoom: 0 },
      });
      assert.equal(bad.statusCode, 422);
      const missing = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/ai/cameras/00000000-0000-4000-8000-000000000001/ptz/move',
        headers: aiHeaders,
        payload: { pan: 0.5, tilt: 0, zoom: 0 },
      });
      assert.equal(missing.statusCode, 404);
    });

    test('AI PTZ без Bearer — 401, даже с admin cookie', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/ai/cameras/${cameraId}/ptz/move`,
        headers: { cookie: adminCookie },
        payload: { pan: 0.5, tilt: 0, zoom: 0 },
      });
      assert.equal(res.statusCode, 401);
    });
  });

  describe('AI WAV (T-23)', () => {
    test('WAV 16 кГц mono с корректным заголовком', async () => {
      process.env.FAKE_FFMPEG_BYTES = '3200';
      process.env.FAKE_FFMPEG_FAIL = '';
      process.env.FAKE_FFMPEG_SLEEP = '';
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/ai/cameras/${cameraId}/audio.wav?duration_ms=2000`,
        headers: aiHeaders,
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['content-type'], 'audio/wav');
      assert.equal(res.headers['cache-control'], 'no-store');
      const body = res.rawPayload;
      assert.equal(body.subarray(0, 4).toString(), 'RIFF');
      assert.equal(body.subarray(8, 12).toString(), 'WAVE');
      assert.equal(body.readUInt32LE(24), 16000);
      assert.equal(body.readUInt16LE(22), 1);
      assert.equal(body.length, 44 + 3200);
      assert.equal(body.readUInt32LE(40), 3200);
    });

    test('неизвестная камера — 404, отключённая — 409 CAMERA_DISABLED', async () => {
      const missing = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/ai/cameras/00000000-0000-4000-8000-000000000001/audio.wav',
        headers: aiHeaders,
      });
      assert.equal(missing.statusCode, 404);

      await ctx.manager.update(cameraId, { enabled: false });
      const disabled = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/ai/cameras/${cameraId}/audio.wav`,
        headers: aiHeaders,
      });
      assert.equal(disabled.statusCode, 409);
      assert.equal((disabled.json() as { code: string }).code, 'CAMERA_DISABLED');
      await ctx.manager.update(cameraId, { enabled: true });
    });

    test('duration_ms вне диапазона — 400', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/ai/cameras/${cameraId}/audio.wav?duration_ms=999`,
        headers: aiHeaders,
      });
      assert.equal(res.statusCode, 400);
      assert.equal((res.json() as { code: string }).code, 'VALIDATION_ERROR');
    });

    test('повторный запрос той же камеры ждёт текущий capture', async () => {
      process.env.FAKE_FFMPEG_BYTES = '800';
      process.env.FAKE_FFMPEG_SLEEP = '0.4';
      const first = ctx.app.inject({
        method: 'GET',
        url: `/api/v1/ai/cameras/${cameraId}/audio.wav?duration_ms=1000`,
        headers: aiHeaders,
      });
      const second = ctx.app.inject({
        method: 'GET',
        url: `/api/v1/ai/cameras/${cameraId}/audio.wav?duration_ms=15000`,
        headers: aiHeaders,
      });
      const [a, b] = await Promise.all([first, second]);
      assert.equal(a.statusCode, 200);
      assert.equal(b.statusCode, 200);
      assert.equal(a.rawPayload.length, b.rawPayload.length);
      process.env.FAKE_FFMPEG_SLEEP = '';
    });

    test('лимит двух capture на сервер — 409 AI_AUDIO_LIMIT_REACHED', async () => {
      const camC = await ctx.manager.create(cameraCreateInput('Камера C'));
      process.env.FAKE_FFMPEG_SLEEP = '1';
      try {
        const p1 = ctx.app.inject({
          method: 'GET',
          url: `/api/v1/ai/cameras/${cameraId}/audio.wav?duration_ms=1000`,
          headers: aiHeaders,
        });
        const p2 = ctx.app.inject({
          method: 'GET',
          url: `/api/v1/ai/cameras/${backchannelId}/audio.wav?duration_ms=1000`,
          headers: aiHeaders,
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        const p3 = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/ai/cameras/${camC.id}/audio.wav?duration_ms=1000`,
          headers: aiHeaders,
        });
        assert.equal(p3.statusCode, 409);
        assert.equal((p3.json() as { code: string }).code, 'AI_AUDIO_LIMIT_REACHED');
        await Promise.all([p1, p2]);
      } finally {
        process.env.FAKE_FFMPEG_SLEEP = '';
        await ctx.manager.delete(camC.id);
      }
    });

    test('источник без звука — 502, частичный WAV не отдаётся', async () => {
      process.env.FAKE_FFMPEG_FAIL = '1';
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/ai/cameras/${cameraId}/audio.wav?duration_ms=1000`,
        headers: aiHeaders,
      });
      process.env.FAKE_FFMPEG_FAIL = '';
      assert.equal(res.statusCode, 502);
    });
  });

  describe('Файловое воспроизведение (T-21, T-22)', () => {
    const wavBytes = Buffer.alloc(44 + 1000, 3);

    test('admin play — 202 с полными полями AudioPlayback', async () => {
      process.env.FAKE_FFPROBE_DURATION = '2.5';
      process.env.FAKE_FFPROBE_FAIL = '';
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/cameras/${cameraId}/audio/play`,
        headers: { cookie: adminCookie, 'content-type': 'audio/wav' },
        payload: wavBytes,
      });
      assert.equal(res.statusCode, 202);
      assert.ok(res.headers['x-request-id']);
      const body = res.json() as {
        playback_id: string;
        camera_id: string;
        duration_ms: number;
        started_at: string;
        estimated_end_at: string;
      };
      assert.equal(body.camera_id, cameraId);
      assert.equal(body.duration_ms, 2500);
      assert.match(body.playback_id, /^[0-9a-f-]{36}$/);
      const started = Date.parse(body.started_at);
      assert.equal(Date.parse(body.estimated_end_at) - started, 2500);
      // camera без backchannel: noop без обращения к go2rtc (решение владельца, T-20)
      assert.equal(ctx.media.playbackCalls.length, 0);

      const stop = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/cameras/${cameraId}/audio/play/${body.playback_id}`,
        headers: { cookie: adminCookie },
      });
      assert.equal(stop.statusCode, 204);
      const again = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/cameras/${cameraId}/audio/play/${body.playback_id}`,
        headers: { cookie: adminCookie },
      });
      assert.equal(again.statusCode, 404);
      assert.equal((again.json() as { code: string }).code, 'AUDIO_PLAYBACK_NOT_FOUND');
    });

    test('второй play на камере — 409 AUDIO_OUTPUT_BUSY', async () => {
      const first = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/cameras/${cameraId}/audio/play`,
        headers: { cookie: adminCookie, 'content-type': 'audio/wav' },
        payload: wavBytes,
      });
      assert.equal(first.statusCode, 202);
      const second = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/cameras/${cameraId}/audio/play`,
        headers: { cookie: adminCookie, 'content-type': 'audio/wav' },
        payload: wavBytes,
      });
      assert.equal(second.statusCode, 409);
      assert.equal((second.json() as { code: string }).code, 'AUDIO_OUTPUT_BUSY');
      const id = (first.json() as { playback_id: string }).playback_id;
      await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/cameras/${cameraId}/audio/play/${id}`,
        headers: { cookie: adminCookie },
      });
    });

    test('неверный content-type — 415, тело >5 МиБ — 413', async () => {
      const badType = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/cameras/${cameraId}/audio/play`,
        headers: { cookie: adminCookie, 'content-type': 'text/plain' },
        payload: 'not-audio',
      });
      assert.equal(badType.statusCode, 415);
      assert.equal((badType.json() as { code: string }).code, 'UNSUPPORTED_AUDIO_FORMAT');

      const tooBig = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/cameras/${cameraId}/audio/play`,
        headers: { cookie: adminCookie, 'content-type': 'audio/wav' },
        payload: Buffer.alloc(5 * 1024 * 1024 + 1, 9),
      });
      assert.equal(tooBig.statusCode, 413);
      assert.equal((tooBig.json() as { code: string }).code, 'AUDIO_TOO_LARGE');
      assert.ok(tooBig.headers['x-request-id']);
    });

    test('ffprobe: битый файл — 422 INVALID_AUDIO, >30 с — 422 AUDIO_DURATION_LIMIT_EXCEEDED', async () => {
      process.env.FAKE_FFPROBE_FAIL = '1';
      const broken = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/ai/cameras/${cameraId}/audio/play`,
        headers: { ...aiHeaders, 'content-type': 'audio/wav' },
        payload: wavBytes,
      });
      process.env.FAKE_FFPROBE_FAIL = '';
      process.env.FAKE_FFPROBE_DURATION = '31';
      const long = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/ai/cameras/${cameraId}/audio/play`,
        headers: { ...aiHeaders, 'content-type': 'audio/wav' },
        payload: wavBytes,
      });
      process.env.FAKE_FFPROBE_DURATION = '2.5';
      assert.equal(broken.statusCode, 422);
      assert.equal((broken.json() as { code: string }).code, 'INVALID_AUDIO');
      assert.equal(long.statusCode, 422);
      assert.equal((long.json() as { code: string }).code, 'AUDIO_DURATION_LIMIT_EXCEEDED');
    });

    test('камера с backchannel: go2rtc получает внутреннюю ссылку, файл отдаётся по /internal', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/ai/cameras/${backchannelId}/audio/play`,
        headers: { ...aiHeaders, 'content-type': 'audio/mpeg' },
        payload: wavBytes,
      });
      assert.equal(res.statusCode, 202);
      const call = ctx.media.playbackCalls.at(-1);
      assert.ok(call);
      assert.equal(call!.dst, ctx.manager.streamName(backchannelId));
      assert.match(call!.src, /^ffmpeg:http:\/\/server:8000\/internal\/audio\/[0-9a-f-]{36}#audio=pcma#input=file$/);
      const internalId = call!.src.slice('ffmpeg:http://server:8000/internal/audio/'.length).split('#')[0]!;
      const internal = await ctx.app.inject({ method: 'GET', url: `/internal/audio/${internalId}` });
      assert.equal(internal.statusCode, 200);
      assert.equal(internal.rawPayload.length, wavBytes.length);
      const id = (res.json() as { playback_id: string }).playback_id;
      await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/ai/cameras/${backchannelId}/audio/play/${id}`,
        headers: aiHeaders,
      });
      assert.ok(ctx.media.stopCalls.includes(ctx.manager.streamName(backchannelId)));
    });

    test('admin и AI делят один лимит воспроизведения на камеру', async () => {
      const ai = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/ai/cameras/${cameraId}/audio/play`,
        headers: { ...aiHeaders, 'content-type': 'audio/wav' },
        payload: wavBytes,
      });
      assert.equal(ai.statusCode, 202);
      const admin = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/cameras/${cameraId}/audio/play`,
        headers: { cookie: adminCookie, 'content-type': 'audio/wav' },
        payload: wavBytes,
      });
      assert.equal(admin.statusCode, 409);
      const id = (ai.json() as { playback_id: string }).playback_id;
      await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/ai/cameras/${cameraId}/audio/play/${id}`,
        headers: aiHeaders,
      });
    });
  });
});

describe('Этап 2: дедупликация снапшотов (T-19, сервер)', () => {
  let ctx: StageTestContext;
  let cameraId = '';

  before(async () => {
    ctx = await buildStageTestApp();
    const cam = await ctx.manager.create(cameraCreateInput('Снапшот-камера'));
    cameraId = cam.id;
  });

  after(async () => {
    await ctx.close();
  });

  test('одинаковые одновременные запросы дают один вызов go2rtc', async () => {
    ctx.media.frameCalls = 0;
    const results = await Promise.all(Array.from({ length: 6 }, () => ctx.manager.snapshot(cameraId, 640)));
    assert.equal(ctx.media.frameCalls, 1);
    for (const jpeg of results) {
      assert.deepEqual(jpeg, FAKE_JPEG);
    }
  });

  test('кэш кадра живёт не дольше 250 мс', async () => {
    ctx.media.frameCalls = 0;
    await ctx.manager.snapshot(cameraId, 320);
    await ctx.manager.snapshot(cameraId, 320);
    assert.equal(ctx.media.frameCalls, 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await ctx.manager.snapshot(cameraId, 320);
    assert.equal(ctx.media.frameCalls, 2);
  });

  test('разная width — отдельные запросы, отключённая камера — 409', async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    ctx.media.frameCalls = 0;
    await Promise.all([ctx.manager.snapshot(cameraId, 320), ctx.manager.snapshot(cameraId, 640)]);
    assert.equal(ctx.media.frameCalls, 2);
    await ctx.manager.update(cameraId, { enabled: false });
    await assert.rejects(() => ctx.manager.snapshot(cameraId), (error: Error) => error.message === 'Камера отключена');
  });
});
