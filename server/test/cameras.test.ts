import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createDb, type DbHandle } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { CameraManager, validateRtspOverride } from '../src/cameras/manager.js';
import { ApiError } from '../src/http/errors.js';
import type { MediaGatewayClient } from '../src/media/client.js';
import { EventService } from '../src/events/service.js';
import { SseHub } from '../src/events/sse.js';
import { PtzService } from '../src/ptz/service.js';
import type { CameraAdapter, CameraConnection, CameraSession, ProbeResult } from '../src/cameras/adapter.js';
import { CameraAdapterRegistry } from '../src/cameras/adapter-registry.js';

class FakeMedia implements Partial<MediaGatewayClient> {
  streams = new Map<string, string[]>();
  failNext = false;
  deleteDelayMs = 0;
  streamMediasDelayMs = 0;
  streamMedias = ['video, recvonly, H264', 'audio, recvonly, PCMA/8000'];

  async putStream(name: string, sources: string[]): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw Object.assign(new Error('media down'), { status: 'unavailable' });
    }
    this.streams.set(name, sources);
  }

  async deleteStream(name: string): Promise<void> {
    if (this.deleteDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.deleteDelayMs));
    }
    this.streams.delete(name);
  }

  async listStreams(): Promise<Record<string, { sources: string[]; consumers: number; producer: string | null }>> {
    const out: Record<string, { sources: string[]; consumers: number; producer: string | null }> = {};
    for (const [name, sources] of this.streams) {
      out[name] = { sources, consumers: 0, producer: sources.length > 0 ? 'connected' : null };
    }
    return out;
  }

  async getFrame(): Promise<Buffer> {
    return Buffer.from('jpeg');
  }

  async getStreamMedias(): Promise<string[]> {
    if (this.streamMediasDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.streamMediasDelayMs));
    }
    return this.streamMedias;
  }
}

class FakeOnvifAdapter implements CameraAdapter {
  readonly id = 'fake';
  readonly displayName = 'Fake ONVIF';
  opened = 0;
  failConnect = false;
  sourceDelayMs = 0;
  sourceError: Error | null = null;
  audioOutput: ProbeResult['capabilities']['audio_output'] = 'unsupported';

  async probe(): Promise<ProbeResult> {
    if (this.failConnect) {
      throw new Error('connect failed');
    }
    return {
      device: { manufacturer: 'Test', model: 'Cam', firmware: '1.0' },
      capabilities: {
        video: 'supported',
        audio: 'unsupported',
        audio_output: this.audioOutput,
        motion_events: 'unknown',
        ptz_continuous: 'supported',
        ptz_presets: 'supported',
      },
      profiles: [{ token: 'p1', name: 'Main', width: 1920, height: 1080, videoCodec: 'H264', audioCodecs: [] }],
      diagnostics: [],
    };
  }

  async open(conn: CameraConnection): Promise<CameraSession> {
    if (this.failConnect) {
      throw new Error('connect failed');
    }
    this.opened += 1;
    const source = `rtsp://${encodeURIComponent(conn.username)}:${encodeURIComponent(conn.password)}@${conn.host}/stream1`;
    return {
      getMediaSources: async () => {
        if (this.sourceDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.sourceDelayMs));
        }
        if (this.sourceError) {
          throw this.sourceError;
        }
        return [source];
      },
      getAudioCaptureUri: async () => source,
      ptzContinuousMove: async () => undefined,
      ptzStop: async () => undefined,
      getPtzPresets: async () => [{ token: 'preset1', name: 'Дом' }],
      gotoPreset: async () => undefined,
      onEvent: () => () => undefined,
      close: async () => undefined,
    };
  }
}

const KEY = Buffer.alloc(32, 1);

interface Ctx {
  handle: DbHandle;
  manager: CameraManager;
  onvif: FakeOnvifAdapter;
  media: FakeMedia;
  close: () => void;
}

function buildCtx(): Ctx {
  const handle = createDb(':memory:');
  runMigrations(handle.db);
  const onvif = new FakeOnvifAdapter();
  const media = new FakeMedia();
  const manager = new CameraManager(
    handle,
    new CameraAdapterRegistry([onvif]),
    media as unknown as MediaGatewayClient,
    new EventService(handle.db),
    new SseHub(),
    new PtzService(),
    KEY,
  );
  return { handle, manager, onvif, media, close: () => handle.close() };
}

const CONN = { host: '192.0.2.10', onvifPort: 80, username: 'admin', password: 'cam-secret-123', profileToken: 'p1' };

describe('CameraManager', () => {
  const ctxs: Ctx[] = [];
  function ctx(): Ctx {
    const c = buildCtx();
    ctxs.push(c);
    return c;
  }
  after(() => {
    for (const c of ctxs) c.close();
  });

  test('create сохраняет камеру, шифрует пароль, создаёт поток', async () => {
    const { manager, media } = ctx();
    const camera = await manager.create({ name: '  Подъезд  ', ...CONN, enabled: true });
    assert.equal(camera.name, 'Подъезд');
    assert.equal(camera.state, 'online');
    assert.equal(camera.has_rtsp_override, false);
    assert.equal(camera.capabilities.video, 'supported');
    const streamName = media.streams.keys().next().value as string;
    assert.match(streamName, /^cam_[0-9a-f]{32}$/);
    const row = manager.repository().get(camera.id);
    assert.ok(row);
    assert.notEqual(row.passwordEnc, 'cam-secret-123');
    assert.ok(!row.passwordEnc.includes('cam-secret'));
    const sources = media.streams.get(streamName) as string[];
    assert.ok(sources[0]?.startsWith('rtsp://admin:cam-secret-123@192.0.2.10/'));
    assert.equal(streamName, manager.streamName(camera.id));
  });

  test('disabled create не выполняет сетевые шаги', async () => {
    const { manager, onvif } = ctx();
    const camera = await manager.create({ name: 'Отключённая', ...CONN, enabled: false });
    assert.equal(camera.state, 'disabled');
    assert.equal(onvif.opened, 0);
  });

  test('имя уникально без учёта регистра', async () => {
    const { manager } = ctx();
    await manager.create({ name: 'Уникальная', ...CONN });
    await assert.rejects(
      () => manager.create({ name: 'уникальная', host: '192.0.2.13', onvifPort: 80, username: 'u', password: 'p', profileToken: 'p1' }),
      (e: unknown) => (e as { code?: string }).code === 'DUPLICATE_CAMERA_NAME',
    );
    // Проверка имени другой камерой не мешает обновлению своего.
    const cam = manager.listCameras()[0]!;
    const updated = await manager.update(cam.id, { name: 'УНИКАЛЬНАЯ' });
    assert.equal(updated.name, 'УНИКАЛЬНАЯ');
  });

  test('лимит 4 камеры, отключённые входят в лимит', async () => {
    const { manager } = ctx();
    for (let i = 1; i <= 4; i += 1) {
      await manager.create({ name: `c${i}`, host: `192.0.2.2${i}`, onvifPort: 80, username: 'u', password: 'p', profileToken: 'p1', enabled: false });
    }
    await assert.rejects(
      () => manager.create({ name: 'c5', host: '192.0.2.30', onvifPort: 80, username: 'u', password: 'p', profileToken: 'p1', enabled: false }),
      (e: unknown) => (e as { code?: string }).code === 'CAMERA_LIMIT_REACHED',
    );
  });

  test('лимит камер принимает конфигурацию', async () => {
    const handle = createDb(':memory:');
    runMigrations(handle.db);
    const onvif = new FakeOnvifAdapter();
    const manager = new CameraManager(
      handle,
      new CameraAdapterRegistry([onvif]),
      new FakeMedia() as unknown as MediaGatewayClient,
      new EventService(handle.db),
      new SseHub(),
      new PtzService(),
      KEY,
      1,
    );
    await manager.create({ name: 'only', ...CONN, enabled: false });
    await assert.rejects(
      () => manager.create({ name: 'extra', ...CONN, enabled: false }),
      (e: unknown) => (e as { code?: string }).code === 'CAMERA_LIMIT_REACHED',
    );
    handle.close();
  });

  test('reconnect для disabled даёт 409', async () => {
    const { manager } = ctx();
    const camera = await manager.create({ name: 'off', ...CONN, enabled: false });
    await assert.rejects(
      () => manager.reconnect(camera.id),
      (e: unknown) => (e as { code?: string }).code === 'CAMERA_DISABLED',
    );
  });

  test('update: пустой пароль сохраняет прежний, enable запускает reconcile', async () => {
    const { manager } = ctx();
    const camera = await manager.create({ name: 'off2', ...CONN, enabled: false });
    const passwordEncBefore = manager.repository().get(camera.id)!.passwordEnc;
    const updated = await manager.update(camera.id, { password: '', enabled: true });
    assert.equal(updated.enabled, true);
    assert.equal(updated.state, 'online');
    assert.equal(manager.repository().get(camera.id)!.passwordEnc, passwordEncBefore);
  });

  test('update: одновременный override и clear_rtsp_override даёт 400', async () => {
    const { manager } = ctx();
    const camera = await manager.create({ name: 'up', ...CONN, enabled: false });
    await assert.rejects(
      () => manager.update(camera.id, { rtspUrlOverride: 'rtsp://192.0.2.20/stream', clearRtspOverride: true }),
      (e: unknown) => (e as { statusCode?: number }).statusCode === 400,
    );
  });

  test('update: clear_rtsp_override удаляет override', async () => {
    const { manager } = ctx();
    const camera = await manager.create({ name: 'ovr', ...CONN, enabled: false, rtspUrlOverride: 'rtsp://192.0.2.21/live' });
    assert.equal(camera.has_rtsp_override, true);
    const updated = await manager.update(camera.id, { clearRtspOverride: true });
    assert.equal(updated.has_rtsp_override, false);
  });

  test('delete удаляет поток и запись', async () => {
    const { manager, media } = ctx();
    const camera = await manager.create({ name: 'temp-del', ...CONN });
    const streamName = manager.streamName(camera.id);
    assert.ok(media.streams.has(streamName));
    await manager.delete(camera.id);
    assert.ok(!media.streams.has(streamName));
    assert.equal(manager.repository().get(camera.id), null);
  });

  test('PTZ: disabled → CAMERA_DISABLED, online сессия → ok', async () => {
    const { manager } = ctx();
    const disabled = await manager.create({ name: 'ptz-off', ...CONN, enabled: false });
    await assert.rejects(
      () => manager.ptzMove(disabled.id, { pan: 1, tilt: 0, zoom: 0, durationMs: 1000 }),
      (e: unknown) => (e as { code?: string }).code === 'CAMERA_DISABLED',
    );
    const online = await manager.create({ name: 'ptz-on', ...CONN });
    await manager.ptzMove(online.id, { pan: 0.5, tilt: 0, zoom: 0, durationMs: 100 });
    await manager.ptzStop(online.id);
    const presets = await manager.ptzPresets(online.id);
    assert.deepEqual(presets, [{ token: 'preset1', name: 'Дом' }]);
  });

  test('probe возвращает понятную ошибку, если ни один адаптер не подошёл', async () => {
    const handle = createDb(':memory:');
    runMigrations(handle.db);
    const failing: CameraAdapter = {
      id: 'failing',
      displayName: 'Тестовый протокол',
      probe: async () => { throw new Error('connect failed'); },
      open: async () => { throw new Error('not used'); },
    };
    const manager = new CameraManager(
      handle,
      new CameraAdapterRegistry([failing]),
      new FakeMedia() as unknown as MediaGatewayClient,
      new EventService(handle.db),
      new SseHub(),
      new PtzService(),
      KEY,
    );
    await assert.rejects(
      manager.probe(CONN),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'CAMERA_ADAPTER_NOT_DETECTED');
        assert.match(error.message, /Проверьте IP-адрес, порт, логин и пароль/);
        return true;
      },
    );
    handle.close();
  });

  test('probe возвращает профили и возможности без RTSP-URL', async () => {
    const { manager } = ctx();
    const result = await manager.probe({ host: '192.0.2.10', onvifPort: 80, username: 'u', password: 'p' });
    assert.equal(result.profiles[0]?.token, 'p1');
    assert.equal(result.capabilities.ptz_continuous, 'supported');
    assert.ok(!JSON.stringify(result).includes('rtsp://'));
  });

  test('snapshot для disabled даёт 409 CAMERA_DISABLED', async () => {
    const { manager } = ctx();
    const disabled = await manager.create({ name: 'snap-off', ...CONN, enabled: false });
    await assert.rejects(
      () => manager.snapshot(disabled.id),
      (e: unknown) => (e as { code?: string }).code === 'CAMERA_DISABLED',
    );
  });

  test('probeSnapshot создаёт и удаляет временный поток', async () => {
    const { manager, media } = ctx();
    const buffer = await manager.probeSnapshot({ ...CONN, profileToken: 'p1' }, 320);
    assert.deepEqual(buffer, Buffer.from('jpeg'));
    assert.equal([...media.streams.keys()].filter((n) => n.startsWith('probe_')).length, 0);
  });

  test('reconcileAll удаляет осиротевшие cam_-потоки', async () => {
    const { manager, media } = ctx();
    media.streams.set('cam_deadbeefdeadbeefdeadbeefdeadbeef', ['rtsp://x']);
    media.streams.set('probe_leftover', ['rtsp://y']);
    await manager.reconcileAll();
    assert.equal(media.streams.has('cam_deadbeefdeadbeefdeadbeefdeadbeef'), false);
    assert.equal(media.streams.has('probe_leftover'), false);
  });

  test('reconnect сбрасывает устаревший audio_output=supported по новому SDP', async () => {
    const { manager, onvif, media } = ctx();
    onvif.audioOutput = 'supported';
    const camera = await manager.create({ name: 'Backchannel', ...CONN });
    assert.equal(camera.capabilities.audio_output, 'supported');

    onvif.audioOutput = 'unknown';
    media.streamMedias = ['video, recvonly, H264', 'audio, recvonly, PCMA/8000'];
    await manager.reconnect(camera.id);
    assert.equal(manager.getCamera(camera.id).capabilities.audio_output, 'unsupported');
  });

  test('disable во время reconcile оставляет камеру disabled', async () => {
    const { manager, onvif } = ctx();
    const camera = await manager.create({ name: 'Race', ...CONN, enabled: false });
    onvif.sourceDelayMs = 50;

    const enabling = manager.update(camera.id, { enabled: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const disabling = manager.update(camera.id, { enabled: false });
    await Promise.all([enabling, disabling]);

    const result = manager.getCamera(camera.id);
    assert.equal(result.enabled, false);
    assert.equal(result.state, 'disabled');
  });

  test('поздняя SDP-проверка не перезаписывает новую попытку и её поток', async () => {
    const { manager, media } = ctx();
    const camera = await manager.create({ name: 'Concurrent SDP', ...CONN });
    media.deleteDelayMs = 80;
    media.streamMediasDelayMs = 80;
    media.streamMedias = ['video, recvonly, H264', 'audio, recvonly, PCMA/8000'];

    const first = manager.reconnect(camera.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    media.streamMediasDelayMs = 0;
    media.streamMedias = ['video, recvonly, H264', 'audio, sendonly, PCMA/8000'];
    const second = manager.reconnect(camera.id);
    await Promise.all([first, second]);

    assert.equal(manager.getCamera(camera.id).capabilities.audio_output, 'supported');
    assert.ok(media.streams.has(manager.streamName(camera.id)), 'поток новой попытки должен существовать');
  });

  test('probeSnapshot отклоняет userinfo в RTSP override', async () => {
    const { manager } = ctx();
    await assert.rejects(
      manager.probeSnapshot({
        ...CONN,
        profileToken: 'p1',
        rtspUrlOverride: 'rtsp://user:pass@192.0.2.10/live',
      }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'VALIDATION_ERROR');
        return true;
      },
    );
  });

  test('probeSnapshot отдаёт upstream-ошибку адаптера вместо 500', async () => {
    const { manager, onvif } = ctx();
    onvif.sourceError = new Error('profile missing');
    await assert.rejects(
      manager.probeSnapshot({ ...CONN, profileToken: 'p1' }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'CAMERA_UNAVAILABLE');
        assert.match(error.message, /Не удалось подключиться к камере/);
        return true;
      },
    );
  });

  test('gotoPreset проверяет token по списку пресетов профиля (T-06)', async () => {
    const { manager } = ctx();
    const camera = await manager.create({ name: 'Пресеты', ...CONN, enabled: true });
    await manager.ptzGotoPreset(camera.id, 'preset1');
    await assert.rejects(
      () => manager.ptzGotoPreset(camera.id, 'missing-token'),
      (err: unknown) => err instanceof ApiError && err.statusCode === 404 && err.code === 'PRESET_NOT_FOUND',
    );
  });
});

describe('validateRtspOverride', () => {
  test('принимает rtsp:// без userinfo', () => {
    assert.doesNotThrow(() => validateRtspOverride('rtsp://192.0.2.10:554/stream1'));
  });

  test('отклоняет userinfo, другие схемы и длину > 2048', () => {
    assert.throws(() => validateRtspOverride('rtsp://admin:pass@192.0.2.10/stream'), /Userinfo/);
    assert.throws(() => validateRtspOverride('http://192.0.2.10/stream'), /rtsp:\/\//);
    assert.throws(() => validateRtspOverride(`rtsp://h/${'a'.repeat(2040)}`), /2048/);
    assert.throws(() => validateRtspOverride('not-a-url'), /некорректен/);
  });
});
