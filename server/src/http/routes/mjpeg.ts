import { Readable, Transform } from 'node:stream';
import type { CameraManager } from '../../cameras/manager.js';
import type { MediaGatewayClient } from '../../media/client.js';
import { ApiError } from '../errors.js';
import {
  AiStreamRegistry,
  validateMjpegParams,
  MJPEG_DEFAULT_FPS,
  MJPEG_DEFAULT_WIDTH,
} from '../../ai/registry.js';

const FRAME_BOUNDARY = '--frame\r\n';

/**
 * Троттлинг MJPEG-кадров: выпускает не более fps кадров в секунду.
 * go2rtc/ffmpeg отдаёт кадры пачками; вместо пропуска лишних из пачки
 * храним последний полный кадр и выпускаем его с фиксированной частотой.
 */
export class FpsThrottle extends Transform {
  private buffer = Buffer.alloc(0);
  private latestFrame: Buffer | null = null;
  private lastEmitted: Buffer | null = null;
  private lastEmitAt = 0;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly fps: number) {
    super();
    this.timer = setInterval(() => this.tick(), Math.max(20, Math.floor(1000 / fps / 2)));
  }

  private get minIntervalMs(): number {
    return 1000 / this.fps;
  }

  override _transform(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.consume(false);
    callback();
  }

  override _flush(callback: () => void): void {
    this.consume(true);
    this.emitLatest(true);
    clearInterval(this.timer);
    callback();
  }

  override _destroy(_error: Error | null, callback: (error?: Error | null) => void): void {
    clearInterval(this.timer);
    callback(null);
  }

  /** Таймер: выпускает последний кадр, если прошёл minInterval. */
  private tick(): void {
    this.emitLatest(false);
  }

  private emitLatest(force: boolean): void {
    if (!this.latestFrame) {
      return;
    }
    const now = Date.now();
    if (!force && this.lastEmitAt !== 0 && now - this.lastEmitAt < this.minIntervalMs) {
      return;
    }
    if (this.latestFrame === this.lastEmitted && !force) {
      return;
    }
    this.lastEmitAt = now;
    this.lastEmitted = this.latestFrame;
    this.push(this.latestFrame);
  }

  /** Парсит полные кадры из буфера, сохраняя последний как кандидат на emit. */
  private consume(flush: boolean): void {
    for (;;) {
      const frameStart = this.buffer.indexOf(FRAME_BOUNDARY);
      if (frameStart === -1) {
        if (flush && this.buffer.length > 0) {
          this.push(this.buffer);
          this.buffer = Buffer.alloc(0);
        }
        return;
      }
      const headerEnd = this.buffer.indexOf('\r\n\r\n', frameStart);
      if (headerEnd === -1) {
        return;
      }
      const header = this.buffer.subarray(frameStart, headerEnd + 4).toString('latin1');
      const lengthMatch = /Content-Length: (\d+)/.exec(header);
      if (!lengthMatch) {
        this.buffer = this.buffer.subarray(frameStart + FRAME_BOUNDARY.length);
        continue;
      }
      const bodyLength = Number(lengthMatch[1]);
      const frameEnd = headerEnd + 4 + bodyLength + 2; // + "\r\n" после JPEG
      if (this.buffer.length < frameEnd) {
        return; // ждём остаток кадра
      }
      this.latestFrame = this.buffer.subarray(frameStart, frameEnd);
      this.buffer = this.buffer.subarray(frameEnd);
      // Первый кадр выпускаем сразу для минимальной задержки.
      if (this.lastEmitAt === 0) {
        this.emitLatest(true);
      }
    }
  }
}

/**
 * Открывает MJPEG-поток для ИИ: регистрирует consumer (1 на камеру),
 * создаёт FFmpeg-транскодер в go2rtc и проксирует с серверным ограничением FPS.
 * Disconnect клиента закрывает поток и освобождает consumer.
 */
export function createMjpegHandler(manager: CameraManager, media: MediaGatewayClient, registry: AiStreamRegistry) {
  return async function openMjpeg(cameraId: string, fpsRaw: number, widthRaw: number): Promise<Readable> {
    const fps = Number.isInteger(fpsRaw) && fpsRaw >= 1 ? fpsRaw : MJPEG_DEFAULT_FPS;
    const width = Number.isInteger(widthRaw) && widthRaw >= 64 ? widthRaw : MJPEG_DEFAULT_WIDTH;
    validateMjpegParams(fps, width);

    const camera = manager.getCamera(cameraId);
    if (!camera.enabled) {
      throw new ApiError(409, 'CAMERA_DISABLED', 'Камера отключена');
    }
    const streamName = manager.streamName(cameraId);
    const mjpegStream = await registry.acquire(cameraId, streamName, fps, width);

    let upstream: Readable;
    try {
      upstream = await media.openMjpegStream(mjpegStream);
    } catch {
      await registry.release(cameraId, streamName).catch(() => undefined);
      throw new ApiError(503, 'CAMERA_MEDIA_UNAVAILABLE', 'MJPEG-поток камеры недоступен');
    }

    const throttled = new FpsThrottle(fps);
    const cleanup = (): void => {
      upstream.destroy();
      void registry.release(cameraId, streamName).catch(() => undefined);
    };
    upstream.on('error', () => throttled.destroy());
    upstream.on('end', () => throttled.end());
    throttled.on('close', cleanup);
    upstream.pipe(throttled);
    return throttled;
  };
}
