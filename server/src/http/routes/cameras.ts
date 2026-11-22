import type { FastifyInstance } from 'fastify';
import type { CameraManager } from '../../cameras/manager.js';
import type { PublicCamera } from '../../cameras/manager.js';
import { ApiError } from '../errors.js';
import { parseWidth } from '../params.js';

const probeSchema = {
  body: {
    type: 'object',
    required: ['host', 'username', 'password'],
    additionalProperties: false,
    properties: {
      host: { type: 'string', minLength: 1, maxLength: 253 },
      onvif_port: { type: 'integer', minimum: 1, maximum: 65535, default: 80 },
      username: { type: 'string', maxLength: 256 },
      password: { type: 'string', maxLength: 1024 },
      rtsp_url_override: { type: 'string', format: 'uri', maxLength: 2048, pattern: '^rtsp://', nullable: true },
    },
  },
} as const;

const probeSnapshotSchema = {
  body: {
    type: 'object',
    required: ['host', 'username', 'password', 'profile_token'],
    additionalProperties: false,
    properties: {
      host: { type: 'string', minLength: 1, maxLength: 253 },
      onvif_port: { type: 'integer', minimum: 1, maximum: 65535, default: 80 },
      username: { type: 'string', maxLength: 256 },
      password: { type: 'string', maxLength: 1024 },
      rtsp_url_override: { type: 'string', format: 'uri', maxLength: 2048, pattern: '^rtsp://', nullable: true },
      profile_token: { type: 'string', minLength: 1 },
    },
  },
} as const;

const createSchema = {
  body: {
    type: 'object',
    required: ['host', 'username', 'password', 'name', 'profile_token'],
    additionalProperties: false,
    properties: {
      host: { type: 'string', minLength: 1, maxLength: 253 },
      onvif_port: { type: 'integer', minimum: 1, maximum: 65535, default: 80 },
      username: { type: 'string', maxLength: 256 },
      password: { type: 'string', maxLength: 1024 },
      rtsp_url_override: { type: 'string', format: 'uri', maxLength: 2048, pattern: '^rtsp://', nullable: true },
      name: { type: 'string', minLength: 1, maxLength: 100 },
      profile_token: { type: 'string', minLength: 1 },
      enabled: { type: 'boolean', default: true },
    },
  },
} as const;

const updateSchema = {
  body: {
    type: 'object',
    minProperties: 1,
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 },
      enabled: { type: 'boolean' },
      host: { type: 'string', minLength: 1, maxLength: 253 },
      onvif_port: { type: 'integer', minimum: 1, maximum: 65535 },
      username: { type: 'string', maxLength: 256 },
      password: { type: 'string', maxLength: 1024 },
      rtsp_url_override: { type: 'string', format: 'uri', maxLength: 2048, pattern: '^rtsp://' },
      clear_rtsp_override: { type: 'boolean', default: false },
      profile_token: { type: 'string', minLength: 1 },
    },
  },
} as const;

export function registerCameraRoutes(app: FastifyInstance, manager: CameraManager): void {
  app.post('/api/v1/cameras/probe', { schema: probeSchema }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const result = await manager.probe({
      host: body.host as string,
      onvifPort: (body.onvif_port as number | undefined) ?? 80,
      username: (body.username as string | undefined) ?? '',
      password: body.password as string,
      rtspUrlOverride: (body.rtsp_url_override as string | null | undefined) ?? null,
    });
    return reply.status(200).send(result);
  });

  app.post('/api/v1/cameras/probe/snapshot.jpg', { schema: probeSnapshotSchema }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const raw = request.query as { width?: string };
    const width = raw.width !== undefined ? parseWidth(raw.width, 64, 1920) : undefined;
    const buffer = await manager.probeSnapshot(
      {
        host: body.host as string,
        onvifPort: (body.onvif_port as number | undefined) ?? 80,
        username: (body.username as string | undefined) ?? '',
        password: body.password as string,
        rtspUrlOverride: (body.rtsp_url_override as string | null | undefined) ?? null,
        profileToken: (body.profile_token as string | undefined) ?? '',
      },
      width,
    );
    void reply.header('Cache-Control', 'no-store');
    return reply.status(200).type('image/jpeg').send(buffer);
  });

  app.get('/api/v1/cameras', async (_request, reply) => {
    const cameras: PublicCamera[] = manager.listCameras();
    return reply.status(200).send(cameras);
  });

  app.post('/api/v1/cameras', { schema: createSchema }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const camera = await manager.create({
      host: body.host as string,
      onvifPort: (body.onvif_port as number | undefined) ?? 80,
      username: (body.username as string | undefined) ?? '',
      password: body.password as string,
      rtspUrlOverride: (body.rtsp_url_override as string | null | undefined) ?? null,
      name: body.name as string,
      profileToken: body.profile_token as string,
      enabled: (body.enabled as boolean | undefined) ?? true,
    });
    return reply.status(201).send(camera);
  });

  app.get('/api/v1/cameras/:camera_id', async (request, reply) => {
    const { camera_id } = request.params as { camera_id: string };
    return reply.status(200).send(manager.getCamera(camera_id));
  });

  app.patch('/api/v1/cameras/:camera_id', { schema: updateSchema }, async (request, reply) => {
    const { camera_id } = request.params as { camera_id: string };
    const body = request.body as Record<string, unknown>;
    const camera = await manager.update(camera_id, {
      ...(body.name !== undefined ? { name: body.name as string } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {}),
      ...(body.host !== undefined ? { host: body.host as string } : {}),
      ...(body.onvif_port !== undefined ? { onvifPort: body.onvif_port as number } : {}),
      ...(body.username !== undefined ? { username: body.username as string } : {}),
      ...(body.password !== undefined ? { password: body.password as string } : {}),
      ...(body.rtsp_url_override !== undefined ? { rtspUrlOverride: body.rtsp_url_override as string } : {}),
      ...(body.clear_rtsp_override !== undefined ? { clearRtspOverride: body.clear_rtsp_override as boolean } : {}),
      ...(body.profile_token !== undefined ? { profileToken: body.profile_token as string } : {}),
    });
    return reply.status(200).send(camera);
  });

  app.delete('/api/v1/cameras/:camera_id', async (request, reply) => {
    const { camera_id } = request.params as { camera_id: string };
    await manager.delete(camera_id);
    return reply.status(204).send();
  });

  app.post('/api/v1/cameras/:camera_id/reconnect', async (request, reply) => {
    const { camera_id } = request.params as { camera_id: string };
    const camera = await manager.reconnect(camera_id);
    return reply.status(200).send(camera);
  });

  app.get('/api/v1/cameras/:camera_id/snapshot.jpg', async (request, reply) => {
    const { camera_id } = request.params as { camera_id: string };
    const raw = request.query as { width?: string };
    const width = raw.width !== undefined ? parseWidth(raw.width, 64, 1920) : undefined;
    const buffer = await manager.snapshot(camera_id, width);
    void reply.header('Cache-Control', 'no-store');
    return reply.status(200).type('image/jpeg').send(buffer);
  });

  app.get('/api/v1/cameras/:camera_id/playback', async (request, reply) => {
    const { camera_id } = request.params as { camera_id: string };
    const info = await manager.playback(camera_id);
    return reply.status(200).send(info);
  });
}

export function cameraIdFrom(request: { params: unknown }): string {
  const { camera_id } = request.params as { camera_id?: string };
  if (!camera_id) {
    throw new ApiError(404, 'CAMERA_NOT_FOUND', 'Камера не найдена');
  }
  return camera_id;
}
