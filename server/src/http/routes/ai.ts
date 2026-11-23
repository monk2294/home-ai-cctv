import type { FastifyInstance } from 'fastify';
import type { CameraManager, PublicCamera } from '../../cameras/manager.js';
import { PtzService } from '../../ptz/service.js';
import { requireAiToken } from '../../auth/guards.js';
import { ApiError } from '../errors.js';

/**
 * AI discovery и PTZ для ИИ-агента (спецификация 50 §6, контракт 1.1.0).
 * PTZ переиспользует тот же PtzService и проверки CameraManager, что и admin API.
 */

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

/** Публичная модель без host, учётных данных, RTSP, profile token и stream names. */
function toAiCamera(camera: PublicCamera) {
  return {
    id: camera.id,
    name: camera.name,
    state: camera.state,
    capabilities: camera.capabilities,
    last_error: camera.last_error,
  };
}

export function registerAiDiscoveryRoutes(
  app: FastifyInstance,
  deps: { aiApiToken: string; manager: CameraManager },
): void {
  const aiGuard = requireAiToken(deps.aiApiToken);

  app.get('/api/v1/ai/cameras', { preHandler: aiGuard }, async (_request, reply) => {
    return reply.status(200).send(deps.manager.listCameras().map(toAiCamera));
  });

  app.get('/api/v1/ai/cameras/:camera_id', { preHandler: aiGuard }, async (request, reply) => {
    const { camera_id } = request.params as { camera_id: string };
    return reply.status(200).send(toAiCamera(deps.manager.getCamera(camera_id)));
  });
}

export function registerAiPtzRoutes(
  app: FastifyInstance,
  deps: { aiApiToken: string; manager: CameraManager },
): void {
  const aiGuard = requireAiToken(deps.aiApiToken);

  app.post('/api/v1/ai/cameras/:camera_id/ptz/move', { preHandler: aiGuard, schema: moveSchema }, async (request, reply) => {
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
    await deps.manager.ptzMove(camera_id, {
      pan: body.pan,
      tilt: body.tilt,
      zoom: body.zoom,
      durationMs: body.duration_ms ?? 1000,
    });
    return reply.status(204).send();
  });

  app.post('/api/v1/ai/cameras/:camera_id/ptz/stop', { preHandler: aiGuard }, async (request, reply) => {
    const { camera_id } = request.params as { camera_id: string };
    await deps.manager.ptzStop(camera_id);
    return reply.status(204).send();
  });

  app.get('/api/v1/ai/cameras/:camera_id/ptz/presets', { preHandler: aiGuard }, async (request, reply) => {
    const { camera_id } = request.params as { camera_id: string };
    return reply.status(200).send(await deps.manager.ptzPresets(camera_id));
  });

  app.post(
    '/api/v1/ai/cameras/:camera_id/ptz/presets/:preset_token/goto',
    { preHandler: aiGuard },
    async (request, reply) => {
      const { camera_id, preset_token } = request.params as { camera_id: string; preset_token: string };
      await deps.manager.ptzGotoPreset(camera_id, preset_token);
      return reply.status(204).send();
    },
  );
}
