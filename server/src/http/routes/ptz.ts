import type { FastifyInstance } from 'fastify';
import type { CameraManager } from '../../cameras/manager.js';
import { PtzService } from '../../ptz/service.js';
import { ApiError } from '../errors.js';

const moveSchema = {
  body: {
    type: 'object',
    required: ['pan', 'tilt', 'zoom'],
    additionalProperties: false,
    properties: {
      pan: { type: 'number', minimum: -1, maximum: 1 },
      tilt: { type: 'number', minimum: -1, maximum: 1 },
      zoom: { type: 'number', minimum: -1, maximum: 1 },
      duration_ms: { type: 'integer', minimum: 100, maximum: 5000, default: 1000 },
    },
  },
} as const;

/** PTZ-маршруты (спецификация 10, раздел 7). Все требуют admin session. */
export function registerPtzRoutes(app: FastifyInstance, manager: CameraManager, ptz: PtzService): void {
  app.post('/api/v1/cameras/:camera_id/ptz/move', { schema: moveSchema }, async (request, reply) => {
    const { camera_id } = request.params as { camera_id: string };
    const body = request.body as { pan: number; tilt: number; zoom: number; duration_ms?: number };
    const validationError = PtzService.validate({
      pan: body.pan,
      tilt: body.tilt,
      zoom: body.zoom,
      durationMs: body.duration_ms ?? 1000,
    });
    if (validationError) {
      throw new ApiError(400, 'VALIDATION_ERROR', validationError);
    }
    await manager.ptzMove(camera_id, {
      pan: body.pan,
      tilt: body.tilt,
      zoom: body.zoom,
      durationMs: body.duration_ms ?? 1000,
    });
    return reply.status(204).send();
  });

  app.post('/api/v1/cameras/:camera_id/ptz/stop', async (request, reply) => {
    const { camera_id } = request.params as { camera_id: string };
    await manager.ptzStop(camera_id);
    return reply.status(204).send();
  });

  app.get('/api/v1/cameras/:camera_id/ptz/presets', async (request, reply) => {
    const { camera_id } = request.params as { camera_id: string };
    const presets = await manager.ptzPresets(camera_id);
    return reply.status(200).send(presets);
  });

  app.post('/api/v1/cameras/:camera_id/ptz/presets/:preset_token/goto', async (request, reply) => {
    const { camera_id, preset_token } = request.params as { camera_id: string; preset_token: string };
    await manager.ptzGotoPreset(camera_id, preset_token);
    return reply.status(204).send();
  });
}
