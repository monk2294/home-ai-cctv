import type { CameraSession } from '../cameras/adapter.js';

type PtzCameraSession = Pick<CameraSession, 'ptzContinuousMove' | 'ptzStop'>;

export interface PtzMoveInput {
  pan: number;
  tilt: number;
  zoom: number;
  durationMs: number;
}

export const PTZ_MIN_DURATION_MS = 100;
export const PTZ_MAX_DURATION_MS = 5000;
export const PTZ_DEFAULT_DURATION_MS = 1000;

interface ActiveMove {
  generation: number;
  timer: NodeJS.Timeout;
}

/**
 * PTZ Service (спецификация 10, раздел 7).
 * Таймер старой команды не останавливает новую: поколение увеличивается на каждую Move.
 */
export class PtzService {
  private readonly active = new Map<string, ActiveMove>();
  private generation = 0;

  /** Валидация скоростей и срока (T-05, раздел 4.1). */
  static validate(input: PtzMoveInput): string | null {
    for (const [name, value] of Object.entries({ pan: input.pan, tilt: input.tilt, zoom: input.zoom })) {
      if (typeof value !== 'number' || Number.isNaN(value) || value < -1 || value > 1) {
        return `Скорость ${name} должна быть числом от -1 до 1`;
      }
    }
    if (input.pan === 0 && input.tilt === 0 && input.zoom === 0) {
      return 'Хотя бы одна скорость должна отличаться от нуля';
    }
    if (!Number.isInteger(input.durationMs) || input.durationMs < PTZ_MIN_DURATION_MS || input.durationMs > PTZ_MAX_DURATION_MS) {
      return `duration_ms должен быть целым от ${PTZ_MIN_DURATION_MS} до ${PTZ_MAX_DURATION_MS}`;
    }
    return null;
  }

  /**
   * Отправляет Continuous Move и планирует Stop на тот же срок.
   * sessionProvider возвращает активную сессию или null (камера недоступна).
   */
  async move(cameraId: string, input: PtzMoveInput, sessionProvider: () => PtzCameraSession | null): Promise<'ok' | 'unavailable'> {
    const session = sessionProvider();
    if (!session) {
      return 'unavailable';
    }
    const generation = ++this.generation;
    await session.ptzContinuousMove(input.pan, input.tilt, input.zoom, input.durationMs);

    const previous = this.active.get(cameraId);
    if (previous) {
      clearTimeout(previous.timer);
    }
    // codeql[js/resource-exhaustion]: PtzService.validate ограничивает durationMs диапазоном 100–5000 мс.
    const timer = setTimeout(() => {
      const current = this.active.get(cameraId);
      if (current?.generation === generation) {
        this.active.delete(cameraId);
        void session.ptzStop().catch(() => undefined);
      }
    }, input.durationMs);
    timer.unref();
    this.active.set(cameraId, { generation, timer });
    return 'ok';
  }

  /** Ручной Stop: отменяет таймер и ждёт ответа камеры. */
  async stop(cameraId: string, sessionProvider: () => PtzCameraSession | null): Promise<'ok' | 'unavailable'> {
    const session = sessionProvider();
    if (!session) {
      return 'unavailable';
    }
    const previous = this.active.get(cameraId);
    if (previous) {
      clearTimeout(previous.timer);
      this.active.delete(cameraId);
    }
    await session.ptzStop();
    return 'ok';
  }

  /** Best-effort Stop при shutdown/disable/delete (раздел 7.2). */
  stopBestEffort(cameraId: string, sessionProvider: () => PtzCameraSession | null): void {
    const previous = this.active.get(cameraId);
    if (previous) {
      clearTimeout(previous.timer);
      this.active.delete(cameraId);
    }
    const session = sessionProvider();
    if (session) {
      void session.ptzStop().catch(() => undefined);
    }
  }

  /** Stop для всех активных камер при завершении работы сервера. */
  async shutdown(sessionProvider: (cameraId: string) => PtzCameraSession | null): Promise<void> {
    const ids = [...this.active.keys()];
    for (const id of ids) {
      const previous = this.active.get(id);
      if (previous) {
        clearTimeout(previous.timer);
        this.active.delete(id);
      }
      const session = sessionProvider(id);
      if (session) {
        await session.ptzStop().catch(() => undefined);
      }
    }
  }

  hasActiveMove(cameraId: string): boolean {
    return this.active.has(cameraId);
  }
}
