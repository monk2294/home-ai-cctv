import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAiToken } from '../../auth/guards.js';
import { ApiError } from '../errors.js';
import { AudioPlaybackService, MAX_AUDIO_BYTES } from '../../audio/playback.js';
import { AudioCaptureService, CAPTURE_DEFAULT_MS } from '../../audio/capture.js';

/**
 * Аудиомаршруты этапа 2 (спецификация 50, контракт 1.1.0).
 * admin: /api/v1/cameras/{id}/audio/play; AI: /api/v1/ai/cameras/{id}/audio/*;
 * внутренняя выдача файла контейнеру media: /internal/audio/{playback_id}.
 */

export interface AudioRouteDeps {
  capture: AudioCaptureService;
  playback: AudioPlaybackService;
}

function audioBodyOf(request: FastifyRequest): Buffer {
  const body = request.body;
  if (!Buffer.isBuffer(body)) {
    throw new ApiError(415, 'UNSUPPORTED_AUDIO_FORMAT', 'Ожидается тело audio/wav или audio/mpeg');
  }
  return body;
}

function contentTypeOf(request: FastifyRequest): string {
  const raw = request.headers['content-type'];
  return (Array.isArray(raw) ? raw[0] : raw ?? '').split(';')[0].trim().toLowerCase();
}

function registerPlayRoute(app: FastifyInstance, path: string, deps: AudioRouteDeps): void {
  // bodyLimit с запасом над 5 МиБ: запросы чуть больше лимита Caddy (5MB) не должны получать
  // ранний 413 от сервера — сервер destroys соединение, а Caddy превращает broken pipe в 502.
  // Точную границу 5 МиБ держит Caddy (request_body), а семантический 413 AUDIO_TOO_LARGE — playback.play.
  app.post(path, { bodyLimit: MAX_AUDIO_BYTES + 128 * 1024 }, async (request, reply) => {
    const { camera_id } = request.params as { camera_id: string };
    const playback = await deps.playback.play(camera_id, contentTypeOf(request), audioBodyOf(request));
    return reply.status(202).send(playback);
  });
}

function registerStopRoute(app: FastifyInstance, path: string, deps: AudioRouteDeps): void {
  app.delete(path, async (request, reply) => {
    const { camera_id, playback_id } = request.params as { camera_id: string; playback_id: string };
    await deps.playback.stop(camera_id, playback_id);
    return reply.status(204).send();
  });
}

/** Административные аудиомаршруты (регистраются внутри admin-scope). */
export function registerAdminAudioRoutes(app: FastifyInstance, deps: AudioRouteDeps): void {
  registerPlayRoute(app, '/api/v1/cameras/:camera_id/audio/play', deps);
  registerStopRoute(app, '/api/v1/cameras/:camera_id/audio/play/:playback_id', deps);
}

/** AI-аудиомаршруты: WAV-захват, файловое воспроизведение. Только Bearer. */
export function registerAiAudioRoutes(
  app: FastifyInstance,
  deps: AudioRouteDeps & { aiApiToken: string },
): void {
  const aiGuard = requireAiToken(deps.aiApiToken);

  app.get('/api/v1/ai/cameras/:camera_id/audio.wav', { preHandler: aiGuard }, async (request, reply) => {
    const { camera_id } = request.params as { camera_id: string };
    const raw = request.query as { duration_ms?: string };
    const durationMs = raw.duration_ms !== undefined ? Number(raw.duration_ms) : CAPTURE_DEFAULT_MS;
    const wav = await deps.capture.capture(camera_id, durationMs);
    void reply.header('Cache-Control', 'no-store');
    return reply.status(200).type('audio/wav').send(wav);
  });

  registerPlayRoute(app, '/api/v1/ai/cameras/:camera_id/audio/play', deps);
  registerStopRoute(app, '/api/v1/ai/cameras/:camera_id/audio/play/:playback_id', deps);
}

/**
 * Внутренняя выдача аудиофайла для go2rtc (Stream-to-camera).
 * Наружу не публикуется: Caddy не роутит /internal (спецификация 30, раздел 3).
 */
export function registerInternalAudioRoutes(app: FastifyInstance, playback: AudioPlaybackService): void {
  app.get('/internal/audio/:playback_id', async (request, reply) => {
    const { playback_id } = request.params as { playback_id: string };
    const body = playback.takeInternalFile(playback_id);
    if (!body) {
      throw new ApiError(404, 'NOT_FOUND', 'Файл воспроизведения не найден');
    }
    void reply.header('Cache-Control', 'no-store');
    return reply.status(200).type('application/octet-stream').send(body);
  });
}
