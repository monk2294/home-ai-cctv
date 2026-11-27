import { Buffer } from 'node:buffer';
import { loadConfig, validateCameraEncryptionKey } from './config.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { AuthService } from './auth/service.js';
import { buildApp } from './app.js';
import { createMediaChecker } from './media/checker.js';
import { MediaGatewayClient } from './media/client.js';
import { LibOnvifAdapter } from './onvif/adapter.js';
import { TapoC520wsAdapter } from './tapo/adapter.js';
import { CameraAdapterRegistry } from './cameras/adapter-registry.js';
import { CameraManager } from './cameras/manager.js';
import { EventService } from './events/service.js';
import { SseHub } from './events/sse.js';
import { MqttCameraEventPublisher } from './events/mqtt.js';
import { PtzService } from './ptz/service.js';
import { AiStreamRegistry } from './ai/registry.js';
import { createMjpegHandler } from './http/routes/mjpeg.js';
import { AudioCaptureService } from './audio/capture.js';
import { AudioPlaybackService } from './audio/playback.js';

async function main(): Promise<void> {
  let openedHandle: ReturnType<typeof createDb> | null = null;
  try {
    const config = loadConfig();
    validateCameraEncryptionKey(config.cameraEncryptionKeyB64);

    const handle = createDb(config.databasePath);
    openedHandle = handle;
    let migrationsDone = false;
    runMigrations(handle.db);
    migrationsDone = true;

    const auth = new AuthService(handle.db, config.adminBootstrapPassword);
    await auth.bootstrapAdmin();

    const mediaChecker = createMediaChecker(config.mediaApiBaseUrl);
    const mediaClient = new MediaGatewayClient(config.mediaApiBaseUrl);
    const cameraKey = Buffer.from(config.cameraEncryptionKeyB64, 'base64');

    const events = new EventService(handle.db, config.eventRetentionPerCamera);
    const sse = new SseHub();
    const ptz = new PtzService();
    const registry = new AiStreamRegistry(mediaClient);

    const onvif = new LibOnvifAdapter();
    const adapters = new CameraAdapterRegistry([new TapoC520wsAdapter(onvif), onvif]);
    const mqttPublisher = config.mqtt
      ? MqttCameraEventPublisher.connect(config.mqtt, {
          warn: (message: string, ...args: unknown[]) => console.warn(message, ...args),
        })
      : null;
    const manager = new CameraManager(
      handle,
      adapters,
      mediaClient,
      events,
      sse,
      ptz,
      cameraKey,
      config.maxCameras,
      (event) => mqttPublisher?.publish(event),
    );
    const openMjpeg = createMjpegHandler(manager, mediaClient, registry);
    const audioCapture = new AudioCaptureService(manager);
    const audioPlayback = new AudioPlaybackService(manager, mediaClient, config.audioInternalBaseUrl, {
      warn: (message, ...args) => console.warn(message, ...args),
    });

    const app = await buildApp({
      db: handle,
      auth,
      aiApiToken: config.aiApiToken,
      sessionCookieSecure: config.sessionCookieSecure,
      logLevel: config.logLevel,
      rateLimitPerMinute: config.httpRateLimitPerMinute,
      migrationsDone: () => migrationsDone,
      media: mediaChecker,
      cameras: { manager, ptz, events, sse, openMjpeg, audio: { capture: audioCapture, playback: audioPlayback } },
    });

    // Периодическая очистка истёкших сессий.
    const purgeTimer = setInterval(() => auth.purgeExpiredSessions(), 60 * 60 * 1000);
    purgeTimer.unref();

    // Reconciliation после запуска (спецификация 10, раздел 10).
    app.log.info('Запуск Reconciliation');
    await manager.reconcileAll().catch((error: unknown) => {
      app.log.warn({ err: error }, 'Reconciliation завершился с ошибками');
    });
    manager.startProbeJanitor();
    const reconcileTimer = setInterval(() => {
      void manager.reconcileOffline().catch((error: unknown) => {
        app.log.warn({ err: error }, 'Повторный Reconciliation завершился с ошибкой');
      });
    }, 15_000);
    reconcileTimer.unref();

    const shutdown = async (signal: string) => {
      app.log.info({ signal }, 'Остановка сервера');
      clearInterval(purgeTimer);
      clearInterval(reconcileTimer);
      await ptz.shutdown((cameraId) => manager.runtimeSession(cameraId));
      await registry.shutdown();
      audioCapture.shutdown();
      audioPlayback.shutdown();
      await manager.shutdown();
      await mqttPublisher?.close();
      await app.close();
      handle.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    await app.listen({ host: config.host, port: config.port });
    app.log.info({ host: config.host, port: config.port }, 'Сервер запущен');
  } catch (error) {
    console.error('Не удалось запустить сервер:', error instanceof Error ? error.message : error);
    openedHandle?.close();
    process.exit(1);
  }
}

void main();
