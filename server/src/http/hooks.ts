import type { FastifyError, FastifyInstance } from 'fastify';
import { AuthError } from '../auth/service.js';
import { ApiError, errorBody } from './errors.js';
import { REQUEST_ID_HEADER, resolveRequestId } from './request-id.js';

/**
 * X-Request-ID на каждом ответе. Совпадает с request_id в теле ошибки.
 * Caddy передаёт существующий заголовок и не заменяет назначенный сервером ID.
 */
export function registerRequestId(app: FastifyInstance): void {
  app.decorateRequest('requestId', '');
  app.decorateRequest('clientIp', '');
  app.addHook('onRequest', async (request, reply) => {
    request.requestId = resolveRequestId(request.headers[REQUEST_ID_HEADER]);
    request.clientIp = request.ip;
    void reply.header('X-Request-ID', request.requestId);
  });
}

/** Маппинг ошибок в единую обёртку Error. Ajv-ошибки — 422 (спецификация 10, раздел 12). */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const requestId = request.requestId || resolveRequestId(undefined);

    if (error instanceof AuthError) {
      return reply.status(error.statusCode).send(errorBody(error, requestId));
    }
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send(errorBody(error, requestId));
    }
    if (error.statusCode === 400 && error.code === 'FST_ERR_VALIDATION') {
      return reply
        .status(422)
        .send(
          errorBody(
            new ApiError(422, 'VALIDATION_ERROR', 'Параметры запроса не прошли валидацию.', {
              issues: error.validation ?? [],
            }),
            requestId,
          ),
        );
    }
    if (typeof error.statusCode === 'number' && error.statusCode === 413) {
      return reply
        .status(400)
        .send(errorBody(new ApiError(400, 'VALIDATION_ERROR', 'Тело запроса превышает лимит размера.'), requestId));
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply
        .status(error.statusCode)
        .send(errorBody(new ApiError(error.statusCode, 'VALIDATION_ERROR', 'Некорректный запрос.'), requestId));
    }
    request.log.error({ err: error, request_id: requestId }, 'Необработанная ошибка');
    return reply
      .status(500)
      .send(errorBody(new ApiError(500, 'INTERNAL_ERROR', 'Внутренняя ошибка сервера.'), requestId));
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .status(404)
      .send(errorBody(new ApiError(404, 'NOT_FOUND', 'Ресурс не найден.'), request.requestId));
  });
}
