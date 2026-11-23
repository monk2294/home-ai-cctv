import type { components } from '../generated/api-v1';

export type Camera = components['schemas']['Camera'];
export type CameraCapabilities = components['schemas']['CameraCapabilities'];
export type CameraEvent = components['schemas']['CameraEvent'];
export type ProbeResponse = components['schemas']['ProbeResponse'];
export type ProbeRequest = components['schemas']['ProbeRequest'];
export type PlaybackInfo = components['schemas']['PlaybackInfo'];
export type AudioPlayback = components['schemas']['AudioPlayback'];
export type PtzPreset = components['schemas']['PtzPreset'];
export type MediaProfile = components['schemas']['MediaProfile'];
export type ErrorBody = components['schemas']['Error'];

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function parseError(response: Response): Promise<ApiRequestError> {
  let code = 'INTERNAL_ERROR';
  let message = `Ошибка ${response.status}`;
  let requestId = response.headers.get('x-request-id') ?? '';
  try {
    const body = (await response.json()) as Partial<ErrorBody>;
    code = body.code ?? code;
    message = body.message ?? message;
    requestId = body.request_id ?? requestId;
  } catch {
    // не JSON — оставляем значения по умолчанию
  }
  return new ApiRequestError(response.status, code, message, requestId);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export const api = {
  login: (password: string) =>
    request<{ username: string; expires_at: string }>('/api/v1/auth/session', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password }),
    }),
  logout: () => request<void>('/api/v1/auth/session', { method: 'DELETE' }),

  listCameras: () => request<Camera[]>('/api/v1/cameras'),
  getCamera: (id: string) => request<Camera>(`/api/v1/cameras/${id}`),
  probe: (body: ProbeRequest) =>
    request<ProbeResponse>('/api/v1/cameras/probe', { method: 'POST', body: JSON.stringify(body) }),
  probeSnapshotUrl: (body: ProbeRequest & { profile_token: string }, width?: number) => ({
    url: `/api/v1/cameras/probe/snapshot.jpg${width ? `?width=${width}` : ''}`,
    init: { method: 'POST', body: JSON.stringify(body) },
  }),
  createCamera: (body: Record<string, unknown>) =>
    request<Camera>('/api/v1/cameras', { method: 'POST', body: JSON.stringify(body) }),
  updateCamera: (id: string, body: Record<string, unknown>) =>
    request<Camera>(`/api/v1/cameras/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteCamera: (id: string) => request<void>(`/api/v1/cameras/${id}`, { method: 'DELETE' }),
  reconnect: (id: string) => request<Camera>(`/api/v1/cameras/${id}/reconnect`, { method: 'POST' }),
  playback: (id: string) => request<PlaybackInfo>(`/api/v1/cameras/${id}/playback`),
  cameraEvents: (id: string, limit = 50) =>
    request<{ items: CameraEvent[] }>(`/api/v1/cameras/${id}/events?limit=${limit}`),

  ptzMove: (id: string, pan: number, tilt: number, zoom: number, durationMs: number) =>
    request<void>(`/api/v1/cameras/${id}/ptz/move`, {
      method: 'POST',
      body: JSON.stringify({ pan, tilt, zoom, duration_ms: durationMs }),
    }),
  ptzStop: (id: string) => request<void>(`/api/v1/cameras/${id}/ptz/stop`, { method: 'POST' }),
  ptzPresets: (id: string) => request<PtzPreset[]>(`/api/v1/cameras/${id}/ptz/presets`),
  ptzGotoPreset: (id: string, token: string) =>
    request<void>(`/api/v1/cameras/${id}/ptz/presets/${encodeURIComponent(token)}/goto`, { method: 'POST' }),

  // Этап 2: файловое воспроизведение через динамик камеры.
  playCameraAudio: (id: string, body: Blob, contentType: string) =>
    request<AudioPlayback>(`/api/v1/cameras/${id}/audio/play`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
    }),
  stopCameraAudioPlayback: (id: string, playbackId: string) =>
    request<void>(`/api/v1/cameras/${id}/audio/play/${playbackId}`, { method: 'DELETE' }),
};

export function snapshotUrl(cameraId: string, width?: number): string {
  return `/api/v1/cameras/${cameraId}/snapshot.jpg${width ? `?width=${width}` : ''}`;
}

/** Снимок как Blob: fetch с cookie даёт доступ к коду ошибки (401/409) для polling. */
export async function snapshotBlob(cameraId: string, width?: number): Promise<Blob> {
  const response = await fetch(snapshotUrl(cameraId, width), {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  return response.blob();
}
