import {
  CameraAdapterDetectionError,
  safeCameraMessage,
  type AdapterAttemptFailure,
  type CameraAdapter,
  type CameraConnection,
  type CameraSession,
  type SelectedCameraAdapter,
} from './adapter.js';

/**
 * Автоматический выбор адаптера перебором.
 * Порядок задаёт composition root: специализированные адаптеры идут раньше общих.
 */
export class CameraAdapterRegistry {
  constructor(private readonly adapters: readonly CameraAdapter[]) {}

  async select(conn: CameraConnection): Promise<SelectedCameraAdapter> {
    const attempts: AdapterAttemptFailure[] = [];
    for (const adapter of this.adapters) {
      try {
        return { adapter, result: await adapter.probe(conn) };
      } catch (error) {
        attempts.push({ adapter: adapter.displayName, reason: safeCameraMessage(error) });
      }
    }
    throw new CameraAdapterDetectionError(attempts);
  }

  /** Перебор завершён: открываем сессию тем же адаптером, который успешно проверил камеру. */
  async open(conn: CameraConnection): Promise<{ session: CameraSession; selected: SelectedCameraAdapter }> {
    const selected = await this.select(conn);
    const session = await selected.adapter.open(conn);
    return { session, selected };
  }
}
