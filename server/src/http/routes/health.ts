import type { FastifyInstance } from 'fastify';
import type { DbHandle } from '../../db/client.js';

interface HealthRouteDeps {
  db: DbHandle;
  migrationsDone: () => boolean;
  checkMedia: () => Promise<'ok' | 'unavailable'>;
}

/**
 * Liveness и readiness (спецификация 10, раздел 13).
 * Readiness не раскрывает внутренние URL и проверяет SQLite, миграции и media.
 */
export function registerHealthRoutes(app: FastifyInstance, deps: HealthRouteDeps): void {
  app.get('/api/v1/health/live', async (_request, reply) =>
    reply.status(200).send({ status: 'ok', components: { process: 'ok' } }),
  );

  app.get('/api/v1/health/ready', async (_request, reply) => {
    const components: Record<string, 'ok' | 'degraded' | 'unavailable'> = {};

    try {
      deps.db.sqlite.prepare('SELECT 1').get();
      components.database = 'ok';
    } catch {
      components.database = 'unavailable';
    }

    components.migrations = deps.migrationsDone() ? 'ok' : 'unavailable';
    components.media = await deps.checkMedia();

    const coreReady = components.database === 'ok' && components.migrations === 'ok';
    if (!coreReady) {
      return reply.status(503).send({ status: 'not_ready', components });
    }
    const status = components.media === 'ok' ? 'ready' : 'degraded';
    return reply.status(200).send({ status, components });
  });
}
