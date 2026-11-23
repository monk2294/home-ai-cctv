import { URLSearchParams } from 'node:url';
import { get as httpGet, type IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';

/**
 * Клиент HTTP API go2rtc (Media Gateway Client, спецификация 10, раздел 3).
 * Все вызовы только по внутренней Docker-сети; base_url содержит base_path /media.
 */

export interface MediaStreamInfo {
  sources: string[];
  consumers: number;
  producer: string | null;
}

export class MediaGatewayError extends Error {
  constructor(
    public readonly status: 'unavailable' | 'upstream' | 'timeout',
    message: string,
  ) {
    super(message);
    this.name = 'MediaGatewayError';
  }
}

const REQUEST_TIMEOUT_MS = 8000;
const FRAME_TIMEOUT_MS = 5000;

export class MediaGatewayClient {
  constructor(private readonly baseUrl: string) {}

  private url(path: string, params?: Record<string, string>): string {
    const qs = params ? `?${new URLSearchParams(params)}` : '';
    return `${this.baseUrl}/media/api${path}${qs}`;
  }

  private async request(path: string, init: RequestInit = {}, params?: Record<string, string>): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(this.url(path, params), {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new MediaGatewayError('timeout', 'Таймаут запроса к медиашлюзу');
      }
      throw new MediaGatewayError('unavailable', 'Медиашлюз недоступен');
    }
    return response;
  }

  /** Создаёт или обновляет поток. Идемпотентно. */
  async putStream(name: string, sources: string[]): Promise<void> {
    const params: Record<string, string> = { name };
    // go2rtc ожидает несколько src-параметров; URLSearchParams не дублирует ключи.
    const qs = new URLSearchParams({ name });
    for (const src of sources) {
      qs.append('src', src);
    }
    void params;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/media/api/streams?${qs}`, {
        method: 'PUT',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new MediaGatewayError('timeout', 'Таймаут запроса к медиашлюзу');
      }
      throw new MediaGatewayError('unavailable', 'Медиашлюз недоступен');
    }
    if (!response.ok) {
      throw new MediaGatewayError('upstream', `Медиашлюз отклонил создание потока: ${response.status}`);
    }
  }

  async deleteStream(name: string): Promise<void> {
    const response = await this.request('/streams', { method: 'DELETE' }, { src: name });
    if (!response.ok && response.status !== 404) {
      throw new MediaGatewayError('upstream', `Медиашлюз отклонил удаление потока: ${response.status}`);
    }
  }

  /**
   * Список потоков: имя -> источники (url producer-ов).
   * Ответ go2rtc: {"<name>": {"producers": [{"url": ...}], "consumers": [...]}}.
   */
  async listStreams(): Promise<Record<string, MediaStreamInfo>> {
    const response = await this.request('/streams');
    if (!response.ok) {
      throw new MediaGatewayError('upstream', `Медиашлюз вернул ${response.status} на список потоков`);
    }
    const body = (await response.json()) as Record<
      string,
      { producers?: { url?: string }[]; consumers?: unknown[] } | null
    >;
    const result: Record<string, MediaStreamInfo> = {};
    for (const [name, info] of Object.entries(body)) {
      if (!info) continue;
      result[name] = {
        sources: (info.producers ?? []).map((p) => p.url ?? '').filter((u) => u.length > 0),
        consumers: Array.isArray(info.consumers) ? info.consumers.length : 0,
        producer: (info.producers ?? []).length > 0 ? 'configured' : null,
      };
    }
    return result;
  }

  /**
   * Медиализ медиaпродюсеров потока (например "audio, recvonly, PCMA/8000").
   * null — поток не найден или go2rtc не вернул producers.
   */
  async getStreamMedias(streamName: string): Promise<string[] | null> {
    const response = await this.request('/streams', { method: 'GET' }, { src: streamName });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new MediaGatewayError('upstream', `Медиашлюз вернул ${response.status} на поток`);
    }
    const body = (await response.json()) as { producers?: { medias?: string[] }[] } | null;
    if (!body || !Array.isArray(body.producers)) {
      return null;
    }
    return body.producers.flatMap((p) => (Array.isArray(p.medias) ? p.medias : []));
  }

  /**
   * Stream-to-camera (go2rtc «Play»): отправляет аудиоисточник внутрь существующего
   * потока камеры (backchannel). src вида "ffmpeg:<url>#audio=pcma#input=file".
   * go2rtc отвечает текстом ошибки (например "can't find consumer"), если трек недоступен.
   */
  async postFileToStream(dstStreamName: string, src: string): Promise<void> {
    const response = await this.request('/streams', { method: 'POST' }, { dst: dstStreamName, src });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new MediaGatewayError('upstream', `Медиашлюз отклонил воспроизведение: ${response.status} ${detail}`);
    }
  }

  /** Останавливает файловое воспроизведение в потоке (POST с пустым src). */
  async stopFileStreamPlayback(dstStreamName: string): Promise<void> {
    const response = await this.request('/streams', { method: 'POST' }, { dst: dstStreamName, src: '' });
    if (!response.ok) {
      throw new MediaGatewayError('upstream', `Медиашлюз отклонил остановку воспроизведения: ${response.status}`);
    }
  }

  /** JPEG-кадр потока. width опционален (64–1920, проверяет вызывающий код). */
  async getFrame(streamName: string, width?: number): Promise<Buffer> {
    const params: Record<string, string> = { src: streamName };
    if (width !== undefined) {
      params.width = String(width);
    }
    let response: Response;
    try {
      response = await fetch(this.url('/frame.jpeg', params), {
        signal: AbortSignal.timeout(FRAME_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new MediaGatewayError('timeout', 'Таймаут получения кадра');
      }
      throw new MediaGatewayError('unavailable', 'Медиашлюз недоступен');
    }
    if (!response.ok) {
      if (response.status === 404) {
        throw new MediaGatewayError('unavailable', 'Поток не найден');
      }
      throw new MediaGatewayError('upstream', `Медиашлюз вернул ${response.status} на кадр`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * MJPEG-поток для ИИ: возвращает Node Readable без таймаута чтения
   * (долгоживущий поток). Таймаут применяется только до получения заголовков ответа.
   * Значения fps/width передаются в FFmpeg-источник потока, а не в query произвольно.
   */
  async openMjpegStream(streamName: string): Promise<Readable> {
    const target = new URL(this.url('/stream.mjpeg', { src: streamName }));
    return new Promise((resolve, reject) => {
      const request = httpGet(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname + target.search,
          timeout: REQUEST_TIMEOUT_MS, // только до ответа; после заголовков снимается
        },
        (response) => {
          response.socket.setTimeout(0);
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            response.resume();
            reject(new MediaGatewayError('upstream', `Медиашлюз вернул ${response.statusCode} на MJPEG`));
            return;
          }
          resolve(response);
        },
      );
      request.on('timeout', () => {
        request.destroy(new MediaGatewayError('timeout', 'Таймаут подключения к медиашлюзу'));
      });
      request.on('error', (error) => {
        if (error instanceof MediaGatewayError) {
          reject(error);
        } else {
          reject(new MediaGatewayError('unavailable', 'Медиашлюз недоступен'));
        }
      });
    });
  }

  base(): string {
    return this.baseUrl;
  }
}
