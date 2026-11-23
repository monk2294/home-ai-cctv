import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createMcpHttpServer } from '../src/http-server.js';
import { PlatformClient } from '../src/client.js';

/** Юнит-тесты MCP: HTTP-обёртка, auth, инструменты и маппинг ошибок (спецификация 60 §6). */

const TOKEN = 'test-token-mcp';

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

interface Harness {
  server: Server;
  base: string;
  handler: Handler;
  calls: { url: string; init?: RequestInit }[];
}

async function startServer(handler: Handler): Promise<Harness> {
  const calls: Harness['calls'] = [];
  const recording: Handler = (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  const server = createMcpHttpServer({
    aiApiToken: TOKEN,
    createClient: () => new PlatformClient('http://server:8000', TOKEN, recording as typeof fetch),
    logError: () => undefined,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}`, handler: recording, calls };
}

async function rpc(base: string, token: string | null, method: string, params?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: response.status, body: await response.json() };
}

async function callTool(base: string, token: string, name: string, args: unknown): Promise<any> {
  const { body } = await rpc(base, token, 'tools/call', { name, arguments: args });
  return body;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const CAMERA = {
  id: 'cam-1',
  name: 'Рабочее место',
  state: 'online',
  capabilities: {
    video: 'supported',
    audio: 'supported',
    audio_output: 'supported',
    motion_events: 'unknown',
    ptz_continuous: 'supported',
    ptz_presets: 'supported',
  },
  last_error: null,
};

describe('MCP HTTP-обёртка', () => {
  let h: Harness;

  before(async () => {
    h = await startServer(async (url, init) => {
      if (url.endsWith('/api/v1/ai/cameras')) {
        return jsonResponse(200, [CAMERA]);
      }
      if (url.includes('/snapshot.jpg')) {
        return new Response(Buffer.from('jpeg-bytes'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      if (url.includes('/audio.wav')) {
        return new Response(Buffer.from('RIFFwav'), { status: 200, headers: { 'content-type': 'audio/wav' } });
      }
      if (url.endsWith('/audio/play') && init?.method === 'POST') {
        const body = Buffer.from(init.body as ArrayBuffer);
        return jsonResponse(202, { playback_id: 'pb-1', bytes: body.length, started_at: '2026-11-23T00:00:00Z' });
      }
      if (url.includes('/audio/play/pb-1') && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/ptz/presets')) {
        return jsonResponse(200, [{ token: '1', name: 'Дверь' }]);
      }
      if (url.endsWith('/ptz/move') || url.endsWith('/ptz/stop') || url.endsWith('/goto')) {
        return new Response(null, { status: 204 });
      }
      if (url.includes('/ptz/presets/') && init?.method === 'POST') {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/api/v1/ai/cameras/cam-1')) {
        return jsonResponse(200, CAMERA);
      }
      if (url.endsWith('/api/v1/ai/cameras/broken')) {
        // Формат Error контракта: code и message в корне тела.
        return jsonResponse(422, { code: 'AUDIO_DURATION_LIMIT_EXCEEDED', message: 'Длительность звука превышает 30 секунд', request_id: 'req-test-1' });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'нет маршрута' } });
    });
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => h.server.close((error) => (error ? reject(error) : resolve())));
  });

  test('healthz доступен без токена', async () => {
    const response = await fetch(`${h.base}/healthz`);
    assert.equal(response.status, 200);
  });

  test('POST /mcp без токена и с неверным токеном отклоняется (401)', async () => {
    assert.equal((await rpc(h.base, null, 'tools/list')).status, 401);
    assert.equal((await rpc(h.base, 'wrong', 'tools/list')).status, 401);
  });

  test('не-POST на /mcp отвечает 405', async () => {
    const response = await fetch(`${h.base}/mcp`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
  });

  test('tools/list возвращает все инструменты', async () => {
    const { status, body } = await rpc(h.base, TOKEN, 'tools/list');
    assert.equal(status, 200);
    const names = body.result.tools.map((tool: { name: string }) => tool.name);
    assert.deepEqual(names, [
      'cameras_list',
      'camera_get',
      'camera_snapshot',
      'camera_listen',
      'camera_play_audio',
      'camera_stop_audio',
      'ptz_move',
      'ptz_stop',
      'ptz_presets',
      'ptz_goto',
    ]);
    const play = body.result.tools.find((tool: { name: string }) => tool.name === 'camera_play_audio');
    assert.match(play.description, /audio_output/);
  });

  test('cameras_list и camera_get проксируют AI API', async () => {
    const list = await callTool(h.base, TOKEN, 'cameras_list', {});
    assert.equal(list.result.structuredContent.cameras[0].id, 'cam-1');

    const one = await callTool(h.base, TOKEN, 'camera_get', { camera_id: 'cam-1' });
    assert.equal(one.result.structuredContent.camera.state, 'online');
  });

  test('camera_snapshot возвращает image-контент', async () => {
    const result = await callTool(h.base, TOKEN, 'camera_snapshot', { camera_id: 'cam-1', width: 640 });
    assert.equal(result.result.content[0].type, 'image');
    assert.equal(result.result.content[0].mimeType, 'image/jpeg');
    assert.equal(Buffer.from(result.result.content[0].data, 'base64').toString(), 'jpeg-bytes');
    const snapshotCall = h.calls.find((call) => call.url.includes('snapshot.jpg'));
    assert.match(snapshotCall?.url ?? '', /width=640/);
  });

  test('camera_listen возвращает WAV base64', async () => {
    const result = await callTool(h.base, TOKEN, 'camera_listen', { camera_id: 'cam-1', duration_ms: 3000 });
    assert.equal(result.result.content[0].resource.mimeType, 'audio/wav');
    assert.equal(Buffer.from(result.result.content[0].resource.blob, 'base64').toString(), 'RIFFwav');
    const call = h.calls.find((c) => c.url.includes('audio.wav'));
    assert.match(call?.url ?? '', /duration_ms=3000/);
  });

  test('camera_play_audio декодирует base64 и шлёт audio/wav', async () => {
    const wav = Buffer.from('RIFFfake-wav');
    const result = await callTool(h.base, TOKEN, 'camera_play_audio', {
      camera_id: 'cam-1',
      wav_base64: wav.toString('base64'),
    });
    assert.equal(result.result.structuredContent.playback.playback_id, 'pb-1');
    const call = h.calls.find((c) => c.url.endsWith('/audio/play'));
    assert.equal((call?.init?.headers as Record<string, string>)['content-type'], 'audio/wav');
    assert.equal(Buffer.from(call?.init?.body as ArrayBuffer).toString(), 'RIFFfake-wav');
  });

  test('camera_play_audio отклоняет плохой base64 и оверсайз', async () => {
    const bad = await callTool(h.base, TOKEN, 'camera_play_audio', { camera_id: 'cam-1', wav_base64: '!!!' });
    assert.equal(bad.result.isError, true);

    const big = await callTool(h.base, TOKEN, 'camera_play_audio', {
      camera_id: 'cam-1',
      wav_base64: Buffer.alloc(6 * 1024 * 1024).toString('base64'),
    });
    assert.equal(big.result.isError, true);
    assert.match(big.result.content[0].text, /лимит/);
  });

  test('camera_stop_audio шлёт DELETE', async () => {
    const result = await callTool(h.base, TOKEN, 'camera_stop_audio', { camera_id: 'cam-1', playback_id: 'pb-1' });
    assert.equal(result.result.structuredContent.stopped, 'pb-1');
    const call = h.calls.find((c) => c.url.includes('/audio/play/pb-1'));
    assert.equal(call?.init?.method, 'DELETE');
  });

  test('PTZ-инструменты проксируют move/stop/presets/goto', async () => {
    const move = await callTool(h.base, TOKEN, 'ptz_move', { camera_id: 'cam-1', pan: 0.5, tilt: -0.5, zoom: 0 });
    assert.equal(move.result.structuredContent.moved, 'cam-1');
    const moveCall = h.calls.find((c) => c.url.endsWith('/ptz/move'));
    assert.equal(moveCall?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(Buffer.from(moveCall?.init?.body as ArrayBuffer).toString()), {
      pan: 0.5,
      tilt: -0.5,
      zoom: 0,
      duration_ms: 1000,
    });

    const stop = await callTool(h.base, TOKEN, 'ptz_stop', { camera_id: 'cam-1' });
    assert.equal(stop.result.structuredContent.stopped, 'cam-1');

    const presets = await callTool(h.base, TOKEN, 'ptz_presets', { camera_id: 'cam-1' });
    assert.equal(presets.result.structuredContent.presets[0].token, '1');

    const goto = await callTool(h.base, TOKEN, 'ptz_goto', { camera_id: 'cam-1', preset_token: '1' });
    assert.equal(goto.result.structuredContent.goto, '1');
  });

  test('границы width и duration_ms совпадают с AI API', async () => {
    // Границы API разрешены.
    assert.equal((await callTool(h.base, TOKEN, 'camera_snapshot', { camera_id: 'cam-1', width: 64 })).result.isError, undefined);
    assert.equal((await callTool(h.base, TOKEN, 'camera_snapshot', { camera_id: 'cam-1', width: 1920 })).result.isError, undefined);
    assert.equal((await callTool(h.base, TOKEN, 'camera_listen', { camera_id: 'cam-1', duration_ms: 1000 })).result.isError, undefined);
    assert.equal((await callTool(h.base, TOKEN, 'camera_listen', { camera_id: 'cam-1', duration_ms: 15000 })).result.isError, undefined);

    // За границами — isError, upstream не дёргается.
    const callsBefore = h.calls.length;
    const wide = await callTool(h.base, TOKEN, 'camera_snapshot', { camera_id: 'cam-1', width: 3840 });
    assert.equal(wide.result.isError, true);
    const short = await callTool(h.base, TOKEN, 'camera_listen', { camera_id: 'cam-1', duration_ms: 500 });
    assert.equal(short.result.isError, true);
    assert.equal(h.calls.length, callsBefore);
  });

  test('ошибка upstream маппируется в isError с кодом сервера', async () => {
    const result = await callTool(h.base, TOKEN, 'camera_get', { camera_id: 'broken' });
    assert.equal(result.result.isError, true);
    assert.match(result.result.content[0].text, /AUDIO_DURATION_LIMIT_EXCEEDED/);
  });
});
