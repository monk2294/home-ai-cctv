import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth/service.js';
import { createDb, type DbHandle } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { CameraManager } from '../src/cameras/manager.js';
import { EventService } from '../src/events/service.js';
import { SseHub } from '../src/events/sse.js';
import { PtzService } from '../src/ptz/service.js';
import { AudioCaptureService } from '../src/audio/capture.js';
import { AudioPlaybackService } from '../src/audio/playback.js';
import { MediaGatewayError } from '../src/media/client.js';
import type { CameraAdapter, CameraSession, ProbeResult } from '../src/cameras/adapter.js';
import { CameraAdapterRegistry } from '../src/cameras/adapter-registry.js';

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

// ---------- stage-2 fakes: камера с фейковым ONVIF и go2rtc ----------

export const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

export class FakeMedia {
  readonly streams = new Set<string>();
  readonly backchannelStreams = new Set<string>();
  readonly playbackCalls: { dst: string; src: string }[] = [];
  readonly stopCalls: string[] = [];
  frameCalls = 0;

  async putStream(name: string): Promise<void> {
    this.streams.add(name);
  }
  async deleteStream(name: string): Promise<void> {
    this.streams.delete(name);
  }
  async listStreams(): Promise<Record<string, { sources: string[]; consumers: number; producer: string | null }>> {
    const out: Record<string, { sources: string[]; consumers: number; producer: string | null }> = {};
    for (const name of this.streams) {
      out[name] = { sources: [], consumers: 0, producer: 'configured' };
    }
    return out;
  }
  async getFrame(name: string): Promise<Buffer> {
    this.frameCalls += 1;
    if (!this.streams.has(name)) {
      throw new MediaGatewayError('unavailable', 'Поток не найден');
    }
    return FAKE_JPEG;
  }
  async getStreamMedias(name: string): Promise<string[] | null> {
    if (!this.streams.has(name)) {
      return null;
    }
    if (this.backchannelStreams.has(name)) {
      return ['video, recvonly, H264', 'audio, recvonly, PCMA/8000', 'audio, sendonly, PCMA/8000'];
    }
    return ['video, recvonly, H264', 'audio, recvonly, PCMA/8000'];
  }
  async postFileToStream(dst: string, src: string): Promise<void> {
    if (!this.backchannelStreams.has(dst)) {
      throw new MediaGatewayError('upstream', "can't find consumer");
    }
    this.playbackCalls.push({ dst, src });
  }
  async stopFileStreamPlayback(dst: string): Promise<void> {
    this.stopCalls.push(dst);
  }
}

export class FakeOnvif implements CameraAdapter {
  readonly id = 'fake';
  readonly displayName = 'Fake';
  readonly ptzMoves: number[][] = [];
  readonly gotoCalls: string[] = [];

  async probe(): Promise<ProbeResult> {
    return {
      device: { manufacturer: 'Test', model: 'Cam', firmware: '1.0' },
      capabilities: {
        video: 'supported',
        audio: 'supported',
        audio_output: 'unknown',
        motion_events: 'unknown',
        ptz_continuous: 'supported',
        ptz_presets: 'supported',
      },
      profiles: [{ token: 'profile_1', name: 'Main', width: 1280, height: 720, videoCodec: 'H264', audioCodecs: ['AAC'] }],
      diagnostics: [],
    };
  }

  async open(): Promise<CameraSession> {
    const self = this;
    return {
      async getMediaSources(): Promise<string[]> {
        return ['rtsp://127.0.0.1:554/stream1'];
      },
      async getAudioCaptureUri(): Promise<string> {
        return 'rtsp://127.0.0.1:554/stream1';
      },
      async ptzContinuousMove(pan: number, tilt: number, zoom: number): Promise<void> {
        self.ptzMoves.push([pan, tilt, zoom]);
      },
      async ptzStop(): Promise<void> {},
      async getPtzPresets(): Promise<{ token: string; name: string }[]> {
        return [{ token: '7', name: 'Home' }];
      },
      async gotoPreset(_profile: string, token: string): Promise<void> {
        self.gotoCalls.push(token);
      },
      onEvent(): () => void {
        return () => undefined;
      },
      async close(): Promise<void> {},
    };
  }
}

export interface StageTestContext {
  app: FastifyInstance;
  auth: AuthService;
  handle: DbHandle;
  manager: CameraManager;
  media: FakeMedia;
  onvif: FakeOnvif;
  close: () => Promise<void>;
}

/** Приложение с реальным CameraManager поверх фейковых ONVIF и go2rtc. */
export async function buildStageTestApp(): Promise<StageTestContext> {
  const handle = createDb(':memory:');
  runMigrations(handle.db);
  const auth = new AuthService(handle.db, TEST_ADMIN_PASSWORD);
  await auth.bootstrapAdmin();

  const media = new FakeMedia();
  const onvif = new FakeOnvif();
  const events = new EventService(handle.db);
  const sse = new SseHub();
  const ptz = new PtzService();
  const manager = new CameraManager(
    handle,
    new CameraAdapterRegistry([onvif]),
    media as never,
    events,
    sse,
    ptz,
    Buffer.alloc(32, 7),
  );
  const capture = new AudioCaptureService(manager);
  const playback = new AudioPlaybackService(manager, media as never, 'http://server:8000', { warn: () => undefined });

  const app = await buildApp({
    db: handle,
    auth,
    aiApiToken: TEST_AI_TOKEN,
    sessionCookieSecure: false,
    logLevel: 'error',
    loggerEnabled: false,
    migrationsDone: () => true,
    media: { checkAvailability: async () => 'ok' },
    cameras: {
      manager,
      ptz,
      events,
      sse,
      openMjpeg: async () => {
        throw new Error('not used');
      },
      audio: { capture, playback },
    },
  });

  return {
    app,
    auth,
    handle,
    manager,
    media,
    onvif,
    close: async () => {
      capture.shutdown();
      playback.shutdown();
      await app.close();
      handle.close();
    },
  };
}

export function cameraCreateInput(name: string) {
  return { name, host: '127.0.0.1', onvifPort: 2020, username: 'user', password: 'pass', profileToken: 'profile_1' };
}
