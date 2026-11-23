import { spawn, type ChildProcess } from 'node:child_process';
import { ApiError } from '../http/errors.js';
import type { CameraManager } from '../cameras/manager.js';
import { buildWavBuffer } from './wav.js';

/**
 * Захват звука с микрофона камеры для ИИ-агента (спецификация 50 §5).
 * FFmpeg читает RTSP-источник камеры, сервер собирает конечный WAV
 * PCM s16le mono 16000 Hz. Фрагмент не сохраняется на диск.
 */

export const CAPTURE_SAMPLE_RATE = 16_000;
export const CAPTURE_MIN_MS = 1_000;
export const CAPTURE_MAX_MS = 15_000;
export const CAPTURE_DEFAULT_MS = 5_000;
const MAX_CONCURRENT_CAPTURES = 2;
const MAX_PCM_BYTES = Math.ceil((CAPTURE_MAX_MS / 1000) * CAPTURE_SAMPLE_RATE * 2) + 4096;

export class AudioCaptureService {
  private readonly active = new Map<string, Promise<Buffer>>();
  private readonly processes = new Set<ChildProcess>();

  constructor(private readonly manager: CameraManager) {}

  /** Один capture на камеру: повторный запрос ждёт текущий. Лимит сервера — 2 capture. */
  async capture(cameraId: string, durationMs: number): Promise<Buffer> {
    if (!Number.isInteger(durationMs) || durationMs < CAPTURE_MIN_MS || durationMs > CAPTURE_MAX_MS) {
      throw new ApiError(400, 'VALIDATION_ERROR', `duration_ms должен быть целым от ${CAPTURE_MIN_MS} до ${CAPTURE_MAX_MS}`);
    }
    const info = this.manager.audioInfoFor(cameraId);
    if (!info.enabled) {
      throw new ApiError(409, 'CAMERA_DISABLED', 'Камера отключена');
    }
    if (info.capabilities.audio === 'unsupported') {
      throw new ApiError(409, 'CAPABILITY_UNSUPPORTED', 'Камера не поддерживает звук');
    }
    if (!info.audioCaptureUri) {
      throw new ApiError(409, 'CAMERA_UNAVAILABLE', 'Камера недоступна');
    }
    const existing = this.active.get(cameraId);
    if (existing) {
      return existing;
    }
    if (this.active.size >= MAX_CONCURRENT_CAPTURES) {
      throw new ApiError(409, 'AI_AUDIO_LIMIT_REACHED', 'Достигнут лимит одновременных захватов звука');
    }
    const pending = this.runCapture(info.audioCaptureUri, durationMs).finally(() => {
      this.active.delete(cameraId);
    });
    this.active.set(cameraId, pending);
    return pending;
  }

  private runCapture(rtspUri: string, durationMs: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      // Аргументы передаются массивом, оболочка не используется (NFR безопасности).
      const child = spawn(
        'ffmpeg',
        [
          '-hide_banner',
          '-nostdin',
          '-loglevel', 'error',
          '-rtsp_transport', 'tcp',
          '-i', rtspUri,
          '-vn', '-sn',
          '-ac', '1',
          '-ar', String(CAPTURE_SAMPLE_RATE),
          '-c:a', 'pcm_s16le',
          '-f', 's16le',
          '-t', String(durationMs / 1000),
          'pipe:1',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      this.processes.add(child);
      const chunks: Buffer[] = [];
      let size = 0;
      let aborted: ApiError | null = null;
      const timer = setTimeout(() => {
        aborted = new ApiError(504, 'MEDIA_TIMEOUT', 'Захват звука превысил ожидаемое время');
        child.kill('SIGKILL');
      }, durationMs + 10_000);
      timer.unref();

      child.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size > MAX_PCM_BYTES) {
          aborted = new ApiError(502, 'MEDIA_UPSTREAM_ERROR', 'Фрагмент звука превышает допустимый размер');
          child.kill('SIGKILL');
        }
      });
      // stderr подавляется: сообщения ffmpeg могут содержать RTSP userinfo.
      child.stderr.resume();
      child.on('error', () => {
        clearTimeout(timer);
        this.processes.delete(child);
        reject(new ApiError(502, 'MEDIA_UPSTREAM_ERROR', 'Не удалось запустить захват звука'));
      });
      child.on('close', () => {
        clearTimeout(timer);
        this.processes.delete(child);
        if (aborted) {
          reject(aborted);
          return;
        }
        const pcm = Buffer.concat(chunks);
        if (pcm.length === 0) {
          reject(new ApiError(502, 'MEDIA_UPSTREAM_ERROR', 'Камера не передала звук'));
          return;
        }
        resolve(buildWavBuffer(pcm, CAPTURE_SAMPLE_RATE, 1));
      });
    });
  }

  shutdown(): void {
    for (const child of this.processes) {
      child.kill('SIGKILL');
    }
    this.processes.clear();
    this.active.clear();
  }
}
