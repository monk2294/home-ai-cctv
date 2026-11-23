import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { DEFAULT_HTTP_RATE_LIMIT_PER_MINUTE } from './config.js';
import type { DbHandle } from './db/client.js';
import type { AuthService } from './auth/service.js';
import { requireAdmin } from './auth/guards.js';
import { ApiError } from './http/errors.js';
import { registerErrorHandler, registerRequestId } from './http/hooks.js';
import { registerAuthRoutes } from './http/routes/auth.js';
import { registerHealthRoutes } from './http/routes/health.js';
import { registerCameraRoutes } from './http/routes/cameras.js';
import { registerPtzRoutes } from './http/routes/ptz.js';
import { registerAiRoutes, registerEventRoutes } from './http/routes/events.js';
import { registerAdminAudioRoutes, registerAiAudioRoutes, registerInternalAudioRoutes } from './http/routes/audio.js';
import { registerAiDiscoveryRoutes, registerAiPtzRoutes } from './http/routes/ai.js';
import type { CameraManager } from './cameras/manager.js';
import type { PtzService } from './ptz/service.js';
import type { EventService } from './events/service.js';
import type { SseHub } from './events/sse.js';
import type { AudioCaptureService } from './audio/capture.js';
import type { AudioPlaybackService } from './audio/playback.js';
import type { Readable } from 'node:stream';

export interface MediaGatewayChecker {
  checkAvailability: () => Promise<'ok' | 'unavailable'>;
}

export interface AppDeps {
  db: DbHandle;
  auth: AuthService;
  aiApiToken: string;
  sessionCookieSecure: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  loggerEnabled?: boolean;
  rateLimitPerMinute?: number;
  migrationsDone: () => boolean;
  media: MediaGatewayChecker;
  cameras?: {
    manager: CameraManager;
    ptz: PtzService;
    events: EventService;
    sse: SseHub;
    openMjpeg: (cameraId: string, fps: number, width: number) => Promise<Readable>;
    audio: {
      capture: AudioCaptureService;
      playback: AudioPlaybackService;
    };
  };
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: 64 * 1024,
    trustProxy: true,
    logger: deps.loggerEnabled === false ? false : { level: deps.logLevel },
  });

  registerRequestId(app);
  registerErrorHandler(app);
  await app.register(rateLimit, {
    max: deps.rateLimitPerMinute ?? DEFAULT_HTTP_RATE_LIMIT_PER_MINUTE,
    timeWindow: 60_000,
    errorResponseBuilder: (request) => ({
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Слишком много запросов. Повторите позже.',
      request_id: request.requestId,
    }),
  });

  // Аудиофайлы парсятся как Buffer; точный формат проверяет аудиомаршрут (415).
  for (const audioType of [
    'audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/aac', 'audio/flac', 'application/octet-stream',
  ]) {
    app.addContentTypeParser(audioType, { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  }

  // CORS не включается. Мутирующие cookie-запросы проверяют Origin (раздел 8.3).
  app.addHook('onRequest', async (request) => {
    if (!MUTATING_METHODS.has(request.method)) {
      return;
    }
    const origin = request.headers.origin;
    if (!origin) {
      return;
    }
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new ApiError(403, 'FORBIDDEN', 'Некорректный заголовок Origin.');
    }
    if (originHost !== request.headers.host) {
      throw new ApiError(403, 'FORBIDDEN', 'Origin запроса не совпадает с хостом.');
    }
  });

  registerAuthRoutes(app, { auth: deps.auth, sessionCookieSecure: deps.sessionCookieSecure });
  registerHealthRoutes(app, {
    db: deps.db,
    migrationsDone: deps.migrationsDone,
    checkMedia: deps.media.checkAvailability,
  });

  if (deps.cameras) {
    const cameras = deps.cameras;
    const adminGuard = requireAdmin(deps.auth);
    // Все camera/PTZ/event маршруты требуют admin session.
    // Guard на onRequest: выполняется раньше валидации body, аноним всегда получает 401 (T-13).
    app.register(async (scoped) => {
      scoped.addHook('onRequest', adminGuard);
      registerCameraRoutes(scoped, cameras.manager);
      registerPtzRoutes(scoped, cameras.manager, cameras.ptz);
      registerEventRoutes(scoped, cameras.events, cameras.sse, cameras.manager);
      registerAdminAudioRoutes(scoped, cameras.audio);
    });
    // AI-маршруты отдельно: только Bearer-токен.
    registerAiRoutes(app, {
      aiApiToken: deps.aiApiToken,
      manager: cameras.manager,
      openMjpeg: cameras.openMjpeg,
    });
    registerAiDiscoveryRoutes(app, { aiApiToken: deps.aiApiToken, manager: cameras.manager });
    registerAiPtzRoutes(app, { aiApiToken: deps.aiApiToken, manager: cameras.manager });
    registerAiAudioRoutes(app, {
      aiApiToken: deps.aiApiToken,
      capture: cameras.audio.capture,
      playback: cameras.audio.playback,
    });
    // Выдача аудиофайла контейнеру media; наружу Caddy этот путь не пропускает.
    registerInternalAudioRoutes(app, cameras.audio.playback);
  }

  return app;
}
