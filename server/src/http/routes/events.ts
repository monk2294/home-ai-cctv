import type { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { CameraManager } from '../../cameras/manager.js';
import type { EventService } from '../../events/service.js';
import type { SseHub } from '../../events/sse.js';
import { requireAiToken } from '../../auth/guards.js';
import { ApiError } from '../errors.js';
import { MJPEG_DEFAULT_FPS, MJPEG_DEFAULT_WIDTH } from '../../ai/registry.js';

/** События и SSE (спецификация 10, раздел 6.4). */
export function registerEventRoutes(app: FastifyInstance, events: EventService, sse: SseHub, manager: CameraManager): void {
  app.get('/api/v1/cameras/:camera_id/events', async (request, reply) => {
    const { camera_id } = request.params as { camera_id: string };
    // История доступна и для disabled камеры (раздел 9).
    manager.getCamera(camera_id);
    const raw = request.query as { limit?: string };
    const limit = raw.limit !== undefined ? Number(raw.limit) : 100;
    const items = events.list(camera_id, Number.isInteger(limit) && limit >= 1 && limit <= 1000 ? limit : 100);
    return reply.status(200).send({ items });
  });

  app.get('/api/v1/events', async (request, reply) => {
    const query = request.query as { camera_id?: string };
    const httpReply = reply as unknown as { raw: import('node:http').ServerResponse };
    httpReply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    httpReply.raw.write(': connected\n\n');

    const remove = sse.add(httpReply.raw, query.camera_id ?? null);
    const cleanup = (): void => {
      remove();
      httpReply.raw.end();
    };
    await new Promise<void>((resolve) => {
      httpReply.raw.on('close', () => {
        cleanup();
        resolve();
      });
    });
  });
}

/** AI-эндпоинты (спецификация 10, раздел 9). Только Bearer-токен ИИ. */
export function registerAiRoutes(
  app: FastifyInstance,
  deps: {
    aiApiToken: string;
    manager: CameraManager;
    openMjpeg: (cameraId: string, fps: number, width: number) => Promise<Readable>;
  },
): void {
  const aiGuard = requireAiToken(deps.aiApiToken);

  app.get('/api/v1/ai/cameras/:camera_id/snapshot.jpg', { preHandler: aiGuard }, async (request, reply) => {
    const { camera_id } = request.params as { camera_id: string };
    const raw = request.query as { width?: string };
    const width = raw.width !== undefined ? parseWidthAi(raw.width) : undefined;
    const buffer = await deps.manager.snapshot(camera_id, width);
    void reply.header('Cache-Control', 'no-store');
    return reply.status(200).type('image/jpeg').send(buffer);
  });

  app.get('/api/v1/ai/cameras/:camera_id/stream.mjpeg', { preHandler: aiGuard }, async (request, reply) => {
    const { camera_id } = request.params as { camera_id: string };
    const raw = request.query as { fps?: string; width?: string };
    const fps = raw.fps !== undefined ? Number(raw.fps) : MJPEG_DEFAULT_FPS;
    const width = raw.width !== undefined ? Number(raw.width) : MJPEG_DEFAULT_WIDTH;
    const stream = await deps.openMjpeg(camera_id, fps, width);
    void reply.header('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
    void reply.header('Cache-Control', 'no-store');
    void reply.header('X-Accel-Buffering', 'no');
    return reply.status(200).send(stream);
  });
}

function parseWidthAi(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 64 || value > 1920) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'width должен быть целым от 64 до 1920');
  }
  return value;
}
