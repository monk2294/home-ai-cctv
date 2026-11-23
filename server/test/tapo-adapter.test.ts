import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import type { Onvif } from 'onvif';
import type { CameraAdapter, CameraConnection, ProbeResult } from '../src/cameras/adapter.js';
import { LibOnvifSession } from '../src/onvif/adapter.js';
import { TapoC520wsAdapter, TapoSession } from '../src/tapo/adapter.js';
import { probeTapoAuth } from '../src/tapo/auth.js';

const CONN: CameraConnection = {
  host: '192.0.2.10',
  port: 2020,
  username: 'camera-user',
  password: 'cloud#pass',
  timeoutMs: 1000,
  rtspUrlOverride: null,
};

const PROBE: ProbeResult = {
  device: { manufacturer: 'tp-link', model: 'Tapo C520WS', firmware: '1.3.5' },
  capabilities: {
    video: 'supported',
    audio: 'supported',
    audio_output: 'unknown',
    motion_events: 'unknown',
    ptz_continuous: 'supported',
    ptz_presets: 'supported',
  },
  profiles: [],
  diagnostics: [],
};

function onvifAdapter(result: ProbeResult = PROBE): CameraAdapter {
  return {
    id: 'onvif',
    displayName: 'ONVIF',
    probe: async () => result,
    open: async () => { throw new Error('not used'); },
  };
}

function onvifClient(calls?: Record<string, unknown>[]): Onvif {
  return {
    uri: { media: true, media2: null },
    setActiveMediaProfile: async () => undefined,
    media: { getStreamUri: async () => ({ uri: 'rtsp://192.0.2.10/stream1' }) },
    media2: { getStreamUri: async () => 'rtsp://192.0.2.10/stream1' },
    ptz: {
      continuousMove: async (request: Record<string, unknown>) => {
        calls?.push(request);
      },
      stop: async () => undefined,
    },
  } as unknown as Onvif;
}

test('Tapo adapter выбирается для C520WS и объявляет динамик', async () => {
  const adapter = new TapoC520wsAdapter(onvifAdapter(), async () => 'ok');
  const result = await adapter.probe(CONN);
  assert.equal(result.capabilities.audio_output, 'supported');
  assert.match(result.diagnostics.at(-1)?.message ?? '', /tapo:\/\//);
});

test('Tapo adapter показывает причину недоступного динамика', async () => {
  const adapter = new TapoC520wsAdapter(onvifAdapter(), async () => 'unauthorized');
  const result = await adapter.probe(CONN);
  assert.equal(result.capabilities.audio_output, 'unsupported');
  assert.equal(result.diagnostics.at(-1)?.status, 'error');
  assert.match(result.diagnostics.at(-1)?.message ?? '', /Third-Party Compatibility/);
});

test('Tapo adapter уступает камере другого типа', async () => {
  const other = { ...PROBE, device: { ...PROBE.device, model: 'OtherCam' } };
  const adapter = new TapoC520wsAdapter(onvifAdapter(other), async () => 'ok');
  await assert.rejects(adapter.probe(CONN), /Модель не C520WS/);
});

test('Tapo session добавляет tapo-источник и не передаёт PTZ Timeout', async () => {
  const calls: Record<string, unknown>[] = [];
  const session = new TapoSession(onvifClient(calls), CONN);
  const sources = await session.getMediaSources('profile_1');
  assert.equal(sources.length, 2);
  assert.match(sources[0] ?? '', /^rtsp:\/\/camera-user:cloud%23pass@192\.0\.2\.10\/stream1$/);
  assert.equal(sources[1], 'tapo://cloud%23pass@192.0.2.10');
  assert.equal(await session.getAudioCaptureUri('profile_1'), sources[0]);

  await session.ptzContinuousMove(0.5, 0, 0, 1200);
  assert.deepEqual(calls[0]?.velocity, { x: 0.5, y: 0, zoom: 0 });
  assert.equal('timeout' in (calls[0] ?? {}), false);
});

test('обычная ONVIF-сессия передаёт PTZ Timeout', async () => {
  const calls: Record<string, unknown>[] = [];
  const session = new LibOnvifSession(onvifClient(calls), CONN);
  await session.ptzContinuousMove(0.5, 0, 0, 1200);
  assert.equal(calls[0]?.timeout, 'PT2S');
});

test('probeTapoAuth повторяет MD5 после отказа SHA256', async () => {
  let authenticated = 0;
  const server = createServer((socket) => {
    let request = '';
    socket.on('data', (chunk) => {
      request += chunk.toString('latin1');
      if (!request.includes('\r\n\r\n')) return;
      if (!request.includes('Authorization:')) {
        socket.end(
          'HTTP/1.1 401 Unauthorized\r\n' +
          'WWW-Authenticate: Digest realm="Tapo",nonce="abc",qop="auth",opaque="x",encrypt_type="3"\r\n' +
          'Content-Length: 0\r\nConnection: close\r\n\r\n',
        );
        return;
      }
      authenticated += 1;
      const status = authenticated === 1 ? '401 Unauthorized' : '200 OK';
      socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const status = await probeTapoAuth('127.0.0.1', 'cloud#pass', 1000, address.port);
    assert.equal(status, 'ok');
    assert.equal(authenticated, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
