import type { MediaGatewayClient } from '../media/client.js';
import { ApiError } from '../http/errors.js';

export const MJPEG_DEFAULT_FPS = 2;
export const MJPEG_MAX_FPS = 15;
export const MJPEG_DEFAULT_WIDTH = 640;
export const MJPEG_MAX_WIDTH = 1280;
export const MJPEG_MIN_WIDTH = 64;

/**
 * MJPEG для ИИ (спецификация 10, раздел 9.3).
 * Один активный consumer на камеру; второй получает 409 до создания транскодера.
 * Транскодер — отдельный go2rtc-поток cam_<id>_mjpeg с FFmpeg-источником;
 * параметры FPS/ширины сервер передаёт в конфигурацию FFmpeg, не в query строку.
 */
export class AiStreamRegistry {
  private readonly consumers = new Map<string, AbortController>();

  constructor(private readonly media: MediaGatewayClient) {}

  /** Регистрирует consumer. Возвращает имя MJPEG-потока. */
  async acquire(cameraId: string, streamName: string, fps: number, width: number): Promise<string> {
    if (this.consumers.has(cameraId)) {
      throw new ApiError(409, 'AI_STREAM_LIMIT_REACHED', 'MJPEG consumer для этой камеры уже активен');
    }
    const mjpegStream = `${streamName}_mjpeg`;
    // FFmpeg-источник: транскодирование в MJPEG с заданной шириной.
    // FPS ограничивает сервер при проксировании: go2rtc запрещает пробелы
    // в источниках (Validate), поэтому raw=-r N нельзя задать через API.
    const rtspSource = await this.resolveRtspSource(streamName);
    const source = `ffmpeg:${rtspSource}#video=mjpeg#width=${width}`;
    await this.media.putStream(mjpegStream, [source]);
    this.consumers.set(cameraId, new AbortController());
    return mjpegStream;
  }

  /** Текущий AbortController consumer-а (null, если нет). */
  controller(cameraId: string): AbortController | null {
    return this.consumers.get(cameraId) ?? null;
  }

  /** Освобождает consumer и удаляет транскодер-поток. */
  async release(cameraId: string, streamName: string): Promise<void> {
    const controller = this.consumers.get(cameraId);
    this.consumers.delete(cameraId);
    controller?.abort();
    await this.media.deleteStream(`${streamName}_mjpeg`).catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.consumers.keys()]) {
      this.consumers.get(id)?.abort();
      this.consumers.delete(id);
    }
  }

  /** Получает RTSP-источник основного потока (go2rtc перечитывает сам; мы берём из списка). */
  private async resolveRtspSource(streamName: string): Promise<string> {
    const streams = await this.media.listStreams();
    const info = streams[streamName];
    const source = info?.sources[0];
    if (!source) {
      throw new ApiError(503, 'CAMERA_MEDIA_UNAVAILABLE', 'Источник камеры недоступен');
    }
    return source;
  }
}

export function validateMjpegParams(fps: number, width: number): void {
  if (!Number.isInteger(fps) || fps < 1 || fps > MJPEG_MAX_FPS) {
    throw new ApiError(400, 'VALIDATION_ERROR', `fps должен быть целым от 1 до ${MJPEG_MAX_FPS}`);
  }
  if (!Number.isInteger(width) || width < MJPEG_MIN_WIDTH || width > MJPEG_MAX_WIDTH) {
    throw new ApiError(400, 'VALIDATION_ERROR', `width должен быть целым от ${MJPEG_MIN_WIDTH} до ${MJPEG_MAX_WIDTH}`);
  }
}
