import type { SessionInfo } from './auth/service.js';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
    adminSession?: SessionInfo;
    clientIp: string;
  }
}
