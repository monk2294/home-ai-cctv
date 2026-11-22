import type { MediaGatewayChecker } from '../app.js';

const MEDIA_CHECK_TIMEOUT_MS = 1500;

/** Лёгкая проверка доступности go2rtc для readiness. Не раскрывает URL наружу. */
export function createMediaChecker(mediaApiBaseUrl: string): MediaGatewayChecker {
  return {
    checkAvailability: async () => {
      try {
        const response = await fetch(`${mediaApiBaseUrl}/media/api`, {
          signal: AbortSignal.timeout(MEDIA_CHECK_TIMEOUT_MS),
        });
        return response.ok ? 'ok' : 'unavailable';
      } catch {
        return 'unavailable';
      }
    },
  };
}
