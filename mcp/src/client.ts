/**
 * Тонкий HTTP-клиент к AI API платформы (/api/v1/ai/*).
 * MCP не добавляет бизнес-логики: ошибки upstream передаются вызывающему инструменту.
 */

export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

interface ErrorBody {
  code?: string;
  message?: string;
  error?: { code?: string; message?: string };
}

async function errorFrom(response: Response): Promise<UpstreamError> {
  let body: ErrorBody = {};
  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    // Тело не JSON — оставляем текст статуса.
  }
  // Формат Error контракта: поля code и message в корне тела.
  const code = body.code ?? body.error?.code ?? 'UPSTREAM_ERROR';
  const message = body.message ?? body.error?.message ?? `Upstream вернул ${response.status}`;
  return new UpstreamError(response.status, code, message);
}

export class PlatformClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  private async expectOk(response: Response): Promise<Response> {
    if (!response.ok) {
      throw await errorFrom(response);
    }
    return response;
  }

  async listCameras(): Promise<unknown> {
    const response = await this.expectOk(
      await this.fetchImpl(`${this.baseUrl}/api/v1/ai/cameras`, { headers: this.headers() }),
    );
    return response.json();
  }

  async getCamera(cameraId: string): Promise<unknown> {
    const response = await this.expectOk(
      await this.fetchImpl(`${this.baseUrl}/api/v1/ai/cameras/${encodeURIComponent(cameraId)}`, {
        headers: this.headers(),
      }),
    );
    return response.json();
  }

  async snapshot(cameraId: string, width?: number): Promise<Buffer> {
    const query = width !== undefined ? `?width=${width}` : '';
    const response = await this.expectOk(
      await this.fetchImpl(
        `${this.baseUrl}/api/v1/ai/cameras/${encodeURIComponent(cameraId)}/snapshot.jpg${query}`,
        { headers: this.headers() },
      ),
    );
    return Buffer.from(await response.arrayBuffer());
  }

  async listen(cameraId: string, durationMs: number): Promise<Buffer> {
    const response = await this.expectOk(
      await this.fetchImpl(
        `${this.baseUrl}/api/v1/ai/cameras/${encodeURIComponent(cameraId)}/audio.wav?duration_ms=${durationMs}`,
        { headers: this.headers() },
      ),
    );
    return Buffer.from(await response.arrayBuffer());
  }

  /** Воспроизведение готового WAV: сырое тело audio/wav (контракт спецификации 50). */
  async playAudio(cameraId: string, wav: Buffer): Promise<unknown> {
    const response = await this.expectOk(
      await this.fetchImpl(`${this.baseUrl}/api/v1/ai/cameras/${encodeURIComponent(cameraId)}/audio/play`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'audio/wav' }),
        body: wav,
      }),
    );
    return response.json();
  }

  async stopAudio(cameraId: string, playbackId: string): Promise<void> {
    await this.expectOk(
      await this.fetchImpl(
        `${this.baseUrl}/api/v1/ai/cameras/${encodeURIComponent(cameraId)}/audio/play/${encodeURIComponent(playbackId)}`,
        { method: 'DELETE', headers: this.headers() },
      ),
    );
  }

  async ptzMove(
    cameraId: string,
    move: { pan: number; tilt: number; zoom: number; durationMs: number },
  ): Promise<void> {
    await this.expectOk(
      await this.fetchImpl(`${this.baseUrl}/api/v1/ai/cameras/${encodeURIComponent(cameraId)}/ptz/move`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          pan: move.pan,
          tilt: move.tilt,
          zoom: move.zoom,
          duration_ms: move.durationMs,
        }),
      }),
    );
  }

  async ptzStop(cameraId: string): Promise<void> {
    await this.expectOk(
      await this.fetchImpl(`${this.baseUrl}/api/v1/ai/cameras/${encodeURIComponent(cameraId)}/ptz/stop`, {
        method: 'POST',
        headers: this.headers(),
      }),
    );
  }

  async ptzPresets(cameraId: string): Promise<unknown> {
    const response = await this.expectOk(
      await this.fetchImpl(`${this.baseUrl}/api/v1/ai/cameras/${encodeURIComponent(cameraId)}/ptz/presets`, {
        headers: this.headers(),
      }),
    );
    return response.json();
  }

  async ptzGoto(cameraId: string, presetToken: string): Promise<void> {
    await this.expectOk(
      await this.fetchImpl(
        `${this.baseUrl}/api/v1/ai/cameras/${encodeURIComponent(cameraId)}/ptz/presets/${encodeURIComponent(presetToken)}/goto`,
        { method: 'POST', headers: this.headers() },
      ),
    );
  }
}
