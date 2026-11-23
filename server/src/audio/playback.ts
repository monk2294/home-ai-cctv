import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../http/errors.js';
import type { CameraManager } from '../cameras/manager.js';
import type { MediaGatewayClient } from '../media/client.js';
import { probeDurationMs } from './probe.js';

/**
 * Файловое воспроизведение через динамик камеры (спецификация 50 §4).
 * Файл (WAV/MP3 до 5 МиБ, до 30 с) проверяется ffprobe, затем играется
 * через go2rtc Stream-to-camera, если у камеры есть backchannel-аудиотрек
 * (capability audio_output=supported).
 * Решение владельца (22.11.2026, T-20): Tapo C520WS не даёт backchannel по RTSP,
 * поэтому при audio_output!=supported команда принимается как noop — 202 без звука.
 */

export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
export const MAX_PLAYBACK_DURATION_MS = 30_000;
export const SUPPORTED_AUDIO_TYPES = new Set(['audio/wav', 'audio/mpeg']);

export interface AudioPlayback {
  playback_id: string;
  camera_id: string;
  duration_ms: number;
  started_at: string;
  estimated_end_at: string;
}

interface ActivePlayback {
  playback: AudioPlayback;
  timer: NodeJS.Timeout;
}

export interface PlaybackLogger {
  warn(message: string, ...args: unknown[]): void;
}

export class AudioPlaybackService {
  /** Одно активное воспроизведение на камеру (admin и AI вместе). */
  private readonly active = new Map<string, ActivePlayback>();
  /** Тело файла для внутренней выдачи go2rtc: playback_id -> buffer. */
  private readonly pendingFiles = new Map<string, Buffer>();

  constructor(
    private readonly manager: CameraManager,
    private readonly media: MediaGatewayClient,
    /** Внутренний base URL сервера, доступный контейнеру media (http://server:8000). */
    private readonly internalBaseUrl: string,
    private readonly log: PlaybackLogger,
  ) {}

  async play(cameraId: string, contentType: string, body: Buffer): Promise<AudioPlayback> {
    if (body.length > MAX_AUDIO_BYTES) {
      throw new ApiError(413, 'AUDIO_TOO_LARGE', 'Аудиофайл превышает 5 МиБ');
    }
    if (!SUPPORTED_AUDIO_TYPES.has(contentType)) {
      throw new ApiError(415, 'UNSUPPORTED_AUDIO_FORMAT', 'Поддерживаются audio/wav и audio/mpeg');
    }
    if (body.length === 0) {
      throw new ApiError(422, 'INVALID_AUDIO', 'Файл не содержит декодируемый звук');
    }
    const info = this.manager.audioInfoFor(cameraId);
    if (!info.enabled) {
      throw new ApiError(409, 'CAMERA_DISABLED', 'Камера отключена');
    }
    const durationMs = await probeFileDurationMs(body);
    if (durationMs === null) {
      throw new ApiError(422, 'INVALID_AUDIO', 'Файл не содержит декодируемый звук');
    }
    if (durationMs > MAX_PLAYBACK_DURATION_MS) {
      throw new ApiError(422, 'AUDIO_DURATION_LIMIT_EXCEEDED', 'Длительность звука превышает 30 секунд');
    }
    if (this.active.has(cameraId)) {
      throw new ApiError(409, 'AUDIO_OUTPUT_BUSY', 'На камере уже идёт воспроизведение');
    }

    const startedAt = new Date();
    const playback: AudioPlayback = {
      playback_id: randomUUID(),
      camera_id: cameraId,
      duration_ms: durationMs,
      started_at: startedAt.toISOString(),
      estimated_end_at: new Date(startedAt.getTime() + durationMs).toISOString(),
    };
    const entry: ActivePlayback = {
      playback,
      timer: setTimeout(() => {
        this.active.delete(cameraId);
        this.pendingFiles.delete(playback.playback_id);
      }, durationMs + 5_000),
    };
    entry.timer.unref();
    this.active.set(cameraId, entry);

    if (info.capabilities.audio_output === 'supported') {
      const streamName = this.manager.streamName(cameraId);
      this.pendingFiles.set(playback.playback_id, body);
      try {
        const src = `ffmpeg:${this.internalBaseUrl}/internal/audio/${playback.playback_id}#audio=pcma#input=file`;
        await this.media.postFileToStream(streamName, src);
      } catch (error) {
        this.active.delete(cameraId);
        this.pendingFiles.delete(playback.playback_id);
        clearTimeout(entry.timer);
        this.log.warn('go2rtc отклонил воспроизведение', error instanceof Error ? error.message : error);
        throw new ApiError(
          502,
          'MEDIA_UPSTREAM_ERROR',
          'Камера не приняла команду воспроизведения. Проверьте поддержку динамика и пароль камеры.',
        );
      }
    } else {
      // Нет backchannel-трека: команда принята, физический звук не идёт (см. шапку файла).
      this.log.warn(
        'audio_output не поддерживается камерой, воспроизведение выполнено как noop: camera_id=%s playback_id=%s',
        cameraId,
        playback.playback_id,
      );
    }
    return playback;
  }

  /** Останавливает воспроизведение. Завершённое или чужое — 404 AUDIO_PLAYBACK_NOT_FOUND. */
  async stop(cameraId: string, playbackId: string): Promise<void> {
    this.manager.audioInfoFor(cameraId);
    const entry = this.active.get(cameraId);
    if (!entry || entry.playback.playback_id !== playbackId) {
      throw new ApiError(404, 'AUDIO_PLAYBACK_NOT_FOUND', 'Воспроизведение не найдено или уже завершено');
    }
    clearTimeout(entry.timer);
    this.active.delete(cameraId);
    this.pendingFiles.delete(playbackId);
    await this.media.stopFileStreamPlayback(this.manager.streamName(cameraId)).catch(() => undefined);
  }

  /** Отдаёт тело файла внутренней выдаче для go2rtc. Один read на playback. */
  takeInternalFile(playbackId: string): Buffer | null {
    return this.pendingFiles.get(playbackId) ?? null;
  }

  shutdown(): void {
    for (const entry of this.active.values()) {
      clearTimeout(entry.timer);
    }
    this.active.clear();
    this.pendingFiles.clear();
  }
}

/**
 * Длительность через ffprobe на обычном файле: ffprobe 5.1 на pipe не отдаёт
 * format.duration (нужен seek до конца), поэтому пишем временный файл 0600
 * и удаляем его сразу после проверки.
 */
async function probeFileDurationMs(body: Buffer): Promise<number | null> {
  const dir = await mkdtemp(join(tmpdir(), 'home-audio-'));
  const file = join(dir, 'audio.bin');
  try {
    await writeFile(file, body, { mode: 0o600 });
    return await probeDurationMs(file);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
