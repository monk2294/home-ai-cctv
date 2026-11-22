import type { ServerResponse } from 'node:http';
import type { CameraEvent } from './service.js';

interface SseClient {
  res: ServerResponse;
  cameraFilter: string | null;
  heartbeat: NodeJS.Timeout;
}

const HEARTBEAT_MS = 15_000;

/**
 * SSE-концентратор событий (спецификация 10, раздел 6.4).
 * Heartbeat не реже раза в 15 секунд; отключение клиента завершает generator.
 */
export class SseHub {
  private readonly clients = new Set<SseClient>();

  add(res: ServerResponse, cameraFilter: string | null): () => void {
    const client: SseClient = {
      res,
      cameraFilter,
      heartbeat: setInterval(() => {
        try {
          client.res.write(': heartbeat\n\n');
        } catch {
          this.remove(client);
        }
      }, HEARTBEAT_MS),
    };
    this.clients.add(client);
    return () => this.remove(client);
  }

  private remove(client: SseClient): void {
    if (this.clients.delete(client)) {
      clearInterval(client.heartbeat);
    }
  }

  broadcast(event: CameraEvent): void {
    const payload = `id: ${event.id}\nevent: camera-event\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      if (client.cameraFilter && client.cameraFilter !== event.camera_id) {
        continue;
      }
      try {
        if (!client.res.write(payload)) {
          this.remove(client);
        }
      } catch {
        this.remove(client);
      }
    }
  }

  clientCount(): number {
    return this.clients.size;
  }

  closeAll(): void {
    for (const client of [...this.clients]) {
      this.remove(client);
      try {
        client.res.end();
      } catch {
        // соединение уже закрыто
      }
    }
  }
}
