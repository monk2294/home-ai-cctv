import { connect, type MqttClient } from 'mqtt';
import type { Config } from '../config.js';
import type { CameraEvent } from './service.js';

export const CAMERA_EVENT_TOPIC = 'home-ai-cctv/events';

interface CameraEventLogger {
  warn: (message: string, ...args: unknown[]) => void;
}

/** Публикация новых camera events в MQTT без блокировки ONVIF-обработчика. */
export class MqttCameraEventPublisher {
  constructor(
    private readonly client: MqttClient,
    private readonly logger: CameraEventLogger,
  ) {
    // Ошибки reconnect обрабатываются здесь: без listener mqtt.js падает по unhandled 'error'.
    client.on('error', (error: Error) => {
      logger.warn(`MQTT-публикатор событий: ${error.message}`);
    });
  }

  static connect(config: NonNullable<Config['mqtt']>, logger: CameraEventLogger): MqttCameraEventPublisher {
    const client = connect(config.url, {
      ...(config.username !== undefined && config.password !== undefined
        ? { username: config.username, password: config.password }
        : {}),
      reconnectPeriod: 5000,
      connectTimeout: 5000,
    });
    return new MqttCameraEventPublisher(client, logger);
  }

  publish(event: CameraEvent): void {
    try {
      this.client.publish(CAMERA_EVENT_TOPIC, JSON.stringify(event), { qos: 1, retain: false }, (error) => {
        if (error) {
          this.logger.warn(`Не удалось опубликовать событие ${event.id} камеры ${event.camera_id}: ${error.message}`);
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Не удалось поставить событие ${event.id} в MQTT: ${message}`);
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      };
      const timer = setTimeout(done, 2000);
      timer.unref();
      this.client.end(false, done);
    });
  }
}
