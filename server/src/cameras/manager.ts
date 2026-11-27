import { eq } from 'drizzle-orm';
import { DEFAULT_MAX_CAMERAS } from '../config.js';
import type { DbHandle } from '../db/client.js';
import { decryptSecret, encryptSecret } from '../db/crypto.js';
import { cameras, mediaCleanup } from '../db/schema.js';
import type { MediaGatewayClient } from '../media/client.js';
import {
  CameraAdapterDetectionError,
  safeCameraMessage,
  type CameraCapabilities,
  type CameraConnection,
  type CameraSession,
  type ProbeResult,
} from './adapter.js';
import type { CameraAdapterRegistry } from './adapter-registry.js';
import { CameraRepository, probeStreamName, streamNameFor, type CameraRow } from './repository.js';
import type { CameraEvent, EventService } from '../events/service.js';
import type { SseHub } from '../events/sse.js';
import type { PtzService } from '../ptz/service.js';
import { ApiError } from '../http/errors.js';

export interface ProbeRequestInput {
  host: string;
  onvifPort: number;
  username: string;
  password: string;
  rtspUrlOverride?: string | null;
}

export interface CameraCreateInput extends ProbeRequestInput {
  name: string;
  profileToken: string;
  enabled?: boolean;
}

export interface CameraUpdateInput {
  name?: string;
  enabled?: boolean;
  host?: string;
  onvifPort?: number;
  username?: string;
  /** Пустая строка — оставить прежний пароль. */
  password?: string;
  rtspUrlOverride?: string;
  clearRtspOverride?: boolean;
  profileToken?: string;
}

export interface PublicCamera {
  id: string;
  name: string;
  host: string;
  onvif_port: number;
  username: string;
  enabled: boolean;
  profile_token: string;
  has_rtsp_override: boolean;
  state: CameraRow['state'];
  capabilities: CameraCapabilities;
  last_error: { code: string; message: string; occurred_at: string } | null;
  last_seen_at: string | null;
  last_event_at: string | null;
  created_at: string;
  updated_at: string;
}

const ONVIF_TIMEOUT_MS = 10_000;
const PROBE_TTL_MS = 30_000;
const SNAPSHOT_CACHE_MS = 250;

/** Проверка RTSP override: только rtsp://, без userinfo (раздел 5.1). */
export function validateRtspOverride(url: string): void {
  if (url.length > 2048) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'RTSP URL длиннее 2048 символов');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError(400, 'VALIDATION_ERROR', 'RTSP URL некорректен');
  }
  if (parsed.protocol !== 'rtsp:') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'RTSP override должен использовать схему rtsp://');
  }
  if (parsed.username || parsed.password) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Userinfo в RTSP URL запрещён: используйте отдельные username и password');
  }
}

interface CameraRuntime {
  session: CameraSession | null;
  unsubscribeEvents: (() => void) | null;
  probeTimers: Set<NodeJS.Timeout>;
  /** Источник с учётными данными для захвата входящего звука. */
  audioCaptureUri: string | null;
}

/**
 * Camera Manager: probe, CRUD, состояние, ONVIF-подключения, Reconciliation.
 * Ошибка одной камеры не блокирует остальные (NFR-11).
 */
export class CameraManager {
  private readonly repo: CameraRepository;
  private readonly runtimes = new Map<string, CameraRuntime>();
  private readonly reconcileGeneration = new Map<string, number>();
  private readonly reconcileQueue = new Map<string, Promise<void>>();
  private offlineReconcileRunning = false;
  private readonly snapInflight = new Map<string, Promise<Buffer>>();
  private readonly snapCache = new Map<string, { jpeg: Buffer; atMs: number }>();

  constructor(
    private readonly handle: DbHandle,
    private readonly adapters: CameraAdapterRegistry,
    private readonly media: MediaGatewayClient,
    private readonly events: EventService,
    private readonly sse: SseHub,
    private readonly ptz: PtzService,
    private readonly cameraKey: Buffer,
    private readonly maxCameras = DEFAULT_MAX_CAMERAS,
    private readonly onStoredEvent: (event: CameraEvent) => void = () => undefined,
  ) {
    this.repo = new CameraRepository(handle.db);
  }

  // ---------- public model ----------

  toPublic(row: CameraRow): PublicCamera {
    let capabilities: CameraCapabilities = {
      video: 'unknown',
      audio: 'unknown',
      audio_output: 'unknown',
      motion_events: 'unknown',
      ptz_continuous: 'unknown',
      ptz_presets: 'unknown',
    };
    try {
      capabilities = { ...capabilities, ...(JSON.parse(row.capabilities) as Partial<CameraCapabilities>) };
    } catch {
      // оставляем unknown
    }
    let lastError: PublicCamera['last_error'] = null;
    if (row.lastError) {
      try {
        lastError = JSON.parse(row.lastError) as PublicCamera['last_error'];
      } catch {
        lastError = null;
      }
    }
    return {
      id: row.id,
      name: row.name,
      host: row.host,
      onvif_port: row.onvifPort,
      username: row.username,
      enabled: row.enabled,
      profile_token: row.profileToken,
      has_rtsp_override: row.rtspOverrideEnc !== null,
      state: row.state,
      capabilities,
      last_error: lastError,
      last_seen_at: row.lastSeenAt,
      last_event_at: row.lastEventAt,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }

  listCameras(): PublicCamera[] {
    return this.repo.list().map((row) => this.toPublic(row));
  }

  getCamera(id: string): PublicCamera {
    const row = this.requireCamera(id);
    return this.toPublic(row);
  }

  private requireCamera(id: string): CameraRow {
    const row = this.repo.get(id);
    if (!row) {
      throw new ApiError(404, 'CAMERA_NOT_FOUND', 'Камера не найдена');
    }
    return row;
  }

  // ---------- probe ----------

  private connection(input: ProbeRequestInput): CameraConnection {
    return {
      host: input.host,
      port: input.onvifPort,
      username: input.username,
      password: input.password,
      timeoutMs: ONVIF_TIMEOUT_MS,
      rtspUrlOverride: input.rtspUrlOverride ?? null,
    };
  }

  async probe(input: ProbeRequestInput): Promise<ProbeResult> {
    if (input.rtspUrlOverride != null) {
      validateRtspOverride(input.rtspUrlOverride);
    }
    try {
      return (await this.adapters.select(this.connection(input))).result;
    } catch (error) {
      throw adapterError(error);
    }
  }

  /** Тестовый снимок до сохранения: временный probe_-поток, удаление в finally. */
  async probeSnapshot(input: ProbeRequestInput & { profileToken: string }, width?: number): Promise<Buffer> {
    if (input.rtspUrlOverride != null) {
      validateRtspOverride(input.rtspUrlOverride);
    }
    const name = probeStreamName();
    const { session } = await this.adapters
      .open(this.connection(input))
      .catch((error: unknown) => { throw adapterError(error); });
    try {
      const sources = await session
        .getMediaSources(input.profileToken)
        .catch((error: unknown) => { throw adapterError(error); });
      try {
        await this.media
          .putStream(name, sources)
          .catch((error: unknown) => { throw mediaError(error); });
        return await this.media
          .getFrame(name, width)
          .catch((error: unknown) => { throw mediaError(error); });
      } finally {
        await this.media.deleteStream(name).catch(() => {
          this.enqueueCleanup(name);
        });
      }
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  /** Очистка оставшихся probe_-потоков (фон, раз в минуту — TTL 30 с). */
  startProbeJanitor(): void {
    const timer = setInterval(() => {
      void this.janitorTick().catch(() => undefined);
    }, PROBE_TTL_MS);
    timer.unref();
  }

  private async janitorTick(): Promise<void> {
    const streams = await this.media.listStreams();
    for (const name of Object.keys(streams)) {
      if (name.startsWith('probe_')) {
        await this.media.deleteStream(name).catch(() => undefined);
      }
    }
  }

  // ---------- CRUD ----------

  async create(input: CameraCreateInput): Promise<PublicCamera> {
    if (input.rtspUrlOverride != null) {
      validateRtspOverride(input.rtspUrlOverride);
    }
    if (this.repo.count() >= this.maxCameras) {
      throw new ApiError(409, 'CAMERA_LIMIT_REACHED', `Лимит камер: ${this.maxCameras}`);
    }
    const name = input.name.trim();
    if (this.repo.isNameTaken(name)) {
      throw new ApiError(409, 'DUPLICATE_CAMERA_NAME', `Имя «${name}» уже занято`);
    }
    const enabled = input.enabled ?? true;

    let rtspOverrideEnc: string | null = null;
    if (input.rtspUrlOverride) {
      rtspOverrideEnc = encryptSecret(input.rtspUrlOverride, this.cameraKey);
    }

    let capabilities: CameraCapabilities = {
      video: 'unknown',
      audio: 'unknown',
      audio_output: 'unknown',
      motion_events: 'unknown',
      ptz_continuous: 'unknown',
      ptz_presets: 'unknown',
    };
    let lastError: string | null = null;

    // Для enabled=true автоматически выбираем адаптер и проверяем источники.
    if (enabled) {
      try {
        const conn = this.connection(input);
        const selected = await this.adapters.select(conn);
        capabilities = selected.result.capabilities;
        const session = await selected.adapter.open(conn);
        try {
          await session.getMediaSources(input.profileToken);
        } finally {
          await session.close().catch(() => undefined);
        }
      } catch (error) {
        lastError = JSON.stringify({
          code: error instanceof CameraAdapterDetectionError ? 'CAMERA_ADAPTER_NOT_DETECTED' : 'CAMERA_UNAVAILABLE',
          message: adapterErrorMessage(error),
          occurred_at: new Date().toISOString(),
        });
      }
    }

    const row = this.repo.create({
      name,
      host: input.host,
      onvifPort: input.onvifPort,
      enabled,
      username: input.username,
      passwordEnc: encryptSecret(input.password, this.cameraKey),
      rtspOverrideEnc,
      profileToken: input.profileToken,
      capabilities,
      state: enabled ? (lastError ? 'degraded' : 'connecting') : 'disabled',
      ...(lastError !== null ? { lastError } : {}),
    });

    if (enabled) {
      await this.reconcileCamera(row.id);
    }
    return this.getCamera(row.id);
  }

  async update(id: string, input: CameraUpdateInput): Promise<PublicCamera> {
    const row = this.requireCamera(id);
    if (input.rtspUrlOverride !== undefined && input.clearRtspOverride) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'rtsp_url_override несовместим с clear_rtsp_override=true');
    }
    if (input.rtspUrlOverride !== undefined) {
      validateRtspOverride(input.rtspUrlOverride);
    }
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (this.repo.isNameTaken(name, id)) {
        throw new ApiError(409, 'DUPLICATE_CAMERA_NAME', `Имя «${name}» уже занято`);
      }
    }

    const disabling = row.enabled && input.enabled === false;
    const enabling = !row.enabled && input.enabled === true;
    const connectionChanged =
      input.host !== undefined || input.onvifPort !== undefined || input.username !== undefined ||
      (input.password !== undefined && input.password.length > 0) ||
      input.profileToken !== undefined ||
      input.rtspUrlOverride !== undefined || input.clearRtspOverride === true;

    if (disabling) {
      this.stopRuntime(id);
      this.ptz.stopBestEffort(id, () => this.runtimeSession(id));
      await this.removeStreamOrEnqueue(id);
    }

    const passwordEnc = input.password && input.password.length > 0
      ? encryptSecret(input.password, this.cameraKey)
      : undefined;
    const rtspOverrideEnc = input.clearRtspOverride
      ? null
      : input.rtspUrlOverride !== undefined
        ? encryptSecret(input.rtspUrlOverride, this.cameraKey)
        : undefined;

    const updated = this.repo.update(id, {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.host !== undefined ? { host: input.host } : {}),
      ...(input.onvifPort !== undefined ? { onvifPort: input.onvifPort } : {}),
      ...(input.username !== undefined ? { username: input.username } : {}),
      ...(passwordEnc !== undefined ? { passwordEnc } : {}),
      ...(rtspOverrideEnc !== undefined ? { rtspOverrideEnc } : {}),
      ...(input.profileToken !== undefined ? { profileToken: input.profileToken } : {}),
      ...(disabling ? { state: 'disabled' as const, lastError: null } : {}),
      ...(enabling || (!disabling && row.enabled && connectionChanged) ? { state: 'connecting' as const } : {}),
    });
    if (!updated) {
      throw new ApiError(404, 'CAMERA_NOT_FOUND', 'Камера не найдена');
    }

    if (enabling) {
      await this.reconcileCamera(id);
    } else if (!disabling && row.enabled && connectionChanged) {
      this.stopRuntime(id);
      await this.reconcileCamera(id);
    }
    return this.getCamera(id);
  }

  async delete(id: string): Promise<void> {
    const row = this.requireCamera(id);
    void row;
    this.stopRuntime(id);
    this.ptz.stopBestEffort(id, () => this.runtimeSession(id));
    await this.removeStreamOrEnqueue(id);
    this.repo.delete(id);
  }

  /** Ручной reconnect (раздел 5.5): только для enabled, заменяет прежнюю попытку. */
  async reconnect(id: string): Promise<PublicCamera> {
    const row = this.requireCamera(id);
    if (!row.enabled) {
      throw new ApiError(409, 'CAMERA_DISABLED', 'Камера отключена');
    }
    this.stopRuntime(id);
    this.ptz.stopBestEffort(id, () => this.runtimeSession(id));
    await this.reconcileCamera(id);
    return this.getCamera(id);
  }

  // ---------- media ----------

  streamName(id: string): string {
    return streamNameFor(id);
  }

  /** JPEG для администратора и ИИ: общий путь к go2rtc.
   * Одинаковые одновременные запросы объединяются в один вызов go2rtc;
   * готовый кадр переиспользуется не дольше 250 мс (спецификация 50, снапшоты 1 с).
   * Дисковый кэш запрещён. */
  async snapshot(id: string, width?: number): Promise<Buffer> {
    const row = this.requireCamera(id);
    if (!row.enabled) {
      throw new ApiError(409, 'CAMERA_DISABLED', 'Камера отключена');
    }
    const key = `${id}:${width ?? 0}`;
    const cached = this.snapCache.get(key);
    if (cached && Date.now() - cached.atMs < SNAPSHOT_CACHE_MS) {
      return cached.jpeg;
    }
    const inflight = this.snapInflight.get(key);
    if (inflight) {
      return inflight;
    }
    const pending = this.media
      .getFrame(this.streamName(id), width)
      .then((jpeg) => {
        this.snapCache.set(key, { jpeg, atMs: Date.now() });
        return jpeg;
      })
      .catch((error: unknown) => {
        throw mediaError(error);
      })
      .finally(() => {
        this.snapInflight.delete(key);
      });
    this.snapInflight.set(key, pending);
    return pending;
  }

  /** Информация для звуковых сервисов: состояние, возможности, RTSP-источник из памяти. */
  audioInfoFor(id: string): { enabled: boolean; capabilities: CameraCapabilities; audioCaptureUri: string | null } {
    const row = this.requireCamera(id);
    return {
      enabled: row.enabled,
      capabilities: this.toPublic(row).capabilities,
      audioCaptureUri: this.runtimes.get(id)?.audioCaptureUri ?? null,
    };
  }

  /** Playback descriptors (раздел 9.4): same-origin relative URLs. */
  async playback(id: string): Promise<{ camera_id: string; preferred: 'webrtc' | 'hls'; webrtc: { signaling_url: string } | null; hls: { playlist_url: string } | null }> {
    const row = this.requireCamera(id);
    if (!row.enabled) {
      throw new ApiError(409, 'CAMERA_DISABLED', 'Камера отключена');
    }
    let streams: Record<string, unknown>;
    try {
      streams = await this.media.listStreams();
    } catch (error) {
      throw mediaError(error);
    }
    if (!(this.streamName(id) in streams)) {
      throw new ApiError(503, 'CAMERA_MEDIA_UNAVAILABLE', 'Медиапоток камеры не создан');
    }
    const name = this.streamName(id);
    return {
      camera_id: id,
      preferred: 'webrtc',
      webrtc: { signaling_url: `/media/api/ws?src=${name}` },
      hls: { playlist_url: `/media/api/stream.m3u8?src=${name}&mp4` },
    };
  }

  // ---------- PTZ ----------

  runtimeSession(id: string): CameraSession | null {
    return this.runtimes.get(id)?.session ?? null;
  }

  async ptzMove(id: string, input: { pan: number; tilt: number; zoom: number; durationMs: number }): Promise<void> {
    const row = this.requireCamera(id);
    const capabilities = this.toPublic(row).capabilities;
    if (!row.enabled) {
      throw new ApiError(409, 'CAMERA_DISABLED', 'Камера отключена');
    }
    if (capabilities.ptz_continuous !== 'supported') {
      throw new ApiError(409, 'CAPABILITY_UNSUPPORTED', 'Камера не поддерживает Continuous Move');
    }
    const result = await this.ptz
      .move(id, input, () => this.runtimeSession(id))
      .catch((error: unknown) => {
        throw upstreamError(error);
      });
    if (result === 'unavailable') {
      throw new ApiError(409, 'CAMERA_UNAVAILABLE', 'Камера недоступна');
    }
  }

  async ptzStop(id: string): Promise<void> {
    const row = this.requireCamera(id);
    if (!row.enabled) {
      throw new ApiError(409, 'CAMERA_DISABLED', 'Камера отключена');
    }
    const result = await this.ptz
      .stop(id, () => this.runtimeSession(id))
      .catch((error: unknown) => {
        throw upstreamError(error);
      });
    if (result === 'unavailable') {
      throw new ApiError(409, 'CAMERA_UNAVAILABLE', 'Камера недоступна');
    }
  }

  async ptzPresets(id: string): Promise<{ token: string; name: string }[]> {
    const row = this.requireCamera(id);
    if (!row.enabled) {
      throw new ApiError(409, 'CAMERA_DISABLED', 'Камера отключена');
    }
    const capabilities = this.toPublic(row).capabilities;
    if (capabilities.ptz_presets !== 'supported') {
      throw new ApiError(409, 'CAPABILITY_UNSUPPORTED', 'Камера не поддерживает пресеты PTZ');
    }
    const session = this.runtimeSession(id);
    if (!session) {
      throw new ApiError(409, 'CAMERA_UNAVAILABLE', 'Камера недоступна');
    }
    try {
      return await session.getPtzPresets(row.profileToken);
    } catch (error) {
      throw upstreamError(error);
    }
  }

  async ptzGotoPreset(id: string, presetToken: string): Promise<void> {
    const row = this.requireCamera(id);
    if (!row.enabled) {
      throw new ApiError(409, 'CAMERA_DISABLED', 'Камера отключена');
    }
    const capabilities = this.toPublic(row).capabilities;
    if (capabilities.ptz_presets !== 'supported') {
      throw new ApiError(409, 'CAPABILITY_UNSUPPORTED', 'Камера не поддерживает пресеты PTZ');
    }
    const session = this.runtimeSession(id);
    if (!session) {
      throw new ApiError(409, 'CAMERA_UNAVAILABLE', 'Камера недоступна');
    }
    try {
      // Спецификация 10 §7.3: принадлежность token проверяется по списку пресетов профиля.
      const presets = await session.getPtzPresets(row.profileToken);
      if (!presets.some((preset) => preset.token === presetToken)) {
        throw new ApiError(404, 'PRESET_NOT_FOUND', 'Пресет не найден на камере');
      }
      await session.gotoPreset(row.profileToken, presetToken);
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw upstreamError(error);
    }
  }

  // ---------- Reconciliation (раздел 10) ----------

  /** Повторяет подключение только offline-камер; online-подключения не пересоздаются. */
  async reconcileOffline(): Promise<void> {
    if (this.offlineReconcileRunning) {
      return;
    }
    this.offlineReconcileRunning = true;
    try {
      const offline = this.repo
        .listEnabled()
        .filter((camera) => camera.state === 'offline' && !this.reconcileQueue.has(camera.id));
      await Promise.all(offline.map((camera) => this.reconcileCamera(camera.id)));
    } finally {
      this.offlineReconcileRunning = false;
    }
  }

  /** Идемпотентное восстановление состояния после запуска. */
  async reconcileAll(): Promise<void> {
    const enabled = this.repo.listEnabled();
    const enabledNames = new Set(enabled.map((c) => this.streamName(c.id)));

    try {
      const streams = await this.media.listStreams();
      // Удаляем осиротевшие cam_-потоки, probe_-потоки и потоки отключённых камер.
      for (const name of Object.keys(streams)) {
        if (name.startsWith('probe_')) {
          await this.media.deleteStream(name).catch(() => undefined);
        } else if (name.startsWith('cam_') && !enabledNames.has(name)) {
          await this.media.deleteStream(name).catch(() => this.enqueueCleanup(name));
        }
      }
    } catch {
      // Медиашлюз недоступен — reconcile повторится по таймеру.
    }

    for (const camera of enabled) {
      await this.reconcileCamera(camera.id);
    }

    await this.processCleanupQueue().catch(() => undefined);
  }

  /** Сериализует попытки одной камеры: старая и новая не владеют потоком одновременно. */
  private async reconcileCamera(id: string): Promise<void> {
    const previous = this.reconcileQueue.get(id) ?? Promise.resolve();
    const current = previous.then(
      () => this.runReconcile(id),
      () => this.runReconcile(id),
    );
    this.reconcileQueue.set(id, current);
    try {
      await current;
    } finally {
      if (this.reconcileQueue.get(id) === current) {
        this.reconcileQueue.delete(id);
      }
    }
  }

  /** Запускает попытку Reconciliation и записывает ошибку только для неё. */
  private async runReconcile(id: string): Promise<void> {
    const row = this.repo.get(id);
    if (!row || !row.enabled) {
      return;
    }
    const generation = this.beginReconcile(id);
    this.repo.update(id, { state: 'connecting' });
    try {
      await this.reconcileCameraAttempt(id, generation);
    } catch (error) {
      if (this.reconcileIsCurrent(id, generation)) {
        this.setState(id, 'offline', error);
      }
    }
  }

  /** Reconciliation одной камеры: автоматический адаптер, поток go2rtc и подписки. */
  private async reconcileCameraAttempt(id: string, generation: number): Promise<void> {
    const row = this.repo.get(id);
    if (!row || !row.enabled) {
      return;
    }

    const password = decryptSecret(row.passwordEnc, this.cameraKey);
    const rtspOverride = row.rtspOverrideEnc ? decryptSecret(row.rtspOverrideEnc, this.cameraKey) : null;
    const conn: CameraConnection = {
      host: row.host,
      port: row.onvifPort,
      username: row.username,
      password,
      timeoutMs: ONVIF_TIMEOUT_MS,
      rtspUrlOverride: rtspOverride,
    };
    const { session, selected } = await this.adapters.open(conn);
    if (!this.reconcileIsCurrent(id, generation)) {
      await session.close().catch(() => undefined);
      return;
    }
    let sources: string[];
    let audioCaptureUri: string | null;
    try {
      sources = await session.getMediaSources(row.profileToken);
      audioCaptureUri = await session.getAudioCaptureUri(row.profileToken);
      if (!this.reconcileIsCurrent(id, generation)) {
        await session.close().catch(() => undefined);
        return;
      }
      await this.media.putStream(this.streamName(id), sources);
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
    if (!this.reconcileIsCurrent(id, generation)) {
      await session.close().catch(() => undefined);
      await this.removeStreamOrEnqueue(id);
      return;
    }

    const current = this.repo.get(id);
    if (current) {
      const known = this.toPublic(current).capabilities;
      const probed = selected.result.capabilities;
      this.repo.update(id, {
        capabilities: {
          video: probed.video === 'unknown' ? known.video : probed.video,
          audio: probed.audio === 'unknown' ? known.audio : probed.audio,
          // Специализированный адаптер знает динамик; общий ONVIF — неизвестно,
          // затем SDP уточняет состояние заново, без устаревшего supported.
          audio_output: probed.audio_output,
          motion_events: probed.motion_events === 'unknown' ? known.motion_events : probed.motion_events,
          ptz_continuous: probed.ptz_continuous === 'unknown' ? known.ptz_continuous : probed.ptz_continuous,
          ptz_presets: probed.ptz_presets === 'unknown' ? known.ptz_presets : probed.ptz_presets,
        },
      });
    }
    await this.refineAudioOutput(id, generation).catch(() => undefined);
    if (!this.reconcileIsCurrent(id, generation)) {
      await session.close().catch(() => undefined);
      await this.removeStreamOrEnqueue(id);
      return;
    }

    // Источники с учётными данными остаются только в памяти и go2rtc.
    const runtime = this.ensureRuntime(id);
    runtime.session = session;
    runtime.audioCaptureUri = audioCaptureUri;
    runtime.unsubscribeEvents = session.onEvent((raw) => {
      const stored = this.events.handleRawEvent(id, raw);
      if (stored.inserted && stored.event) {
        this.handle.db
          .update(cameras)
          .set({ lastEventAt: stored.event.received_at })
          .where(eq(cameras.id, id))
          .run();
        // Первое подтверждённое событие движения уточняет capability (раздел 6.1).
        // События других типов (people, tamper) motion не подтверждают.
        if (stored.event.type === 'motion') {
          const current = this.repo.get(id);
          if (current) {
            const capabilities = this.toPublic(current).capabilities;
            if (capabilities.motion_events === 'unknown') {
              this.repo.update(id, { capabilities: { ...capabilities, motion_events: 'supported' } });
            }
          }
        }
        this.sse.broadcast(stored.event);
        this.onStoredEvent(stored.event);
      }
    });
    const state: CameraRow['state'] = rtspOverride ? 'degraded' : 'online';
    this.repo.update(id, { state, lastSeenAt: new Date().toISOString(), lastError: null });
  }

  private beginReconcile(id: string): number {
    const generation = (this.reconcileGeneration.get(id) ?? 0) + 1;
    this.reconcileGeneration.set(id, generation);
    return generation;
  }

  private reconcileIsCurrent(id: string, generation: number): boolean {
    const row = this.repo.get(id);
    return row?.enabled === true && this.reconcileGeneration.get(id) === generation;
  }

  private ensureRuntime(id: string): CameraRuntime {
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      runtime = { session: null, unsubscribeEvents: null, probeTimers: new Set(), audioCaptureUri: null };
      this.runtimes.set(id, runtime);
    }
    return runtime;
  }

  /**
   * Уточнение audio_output по медиасписанию продюсера go2rtc:
   * "audio, sendonly"/"sendrecv" — backchannel есть, только recvonly — динамика нет.
   */
  private async refineAudioOutput(id: string, generation: number): Promise<void> {
    const before = this.repo.get(id);
    if (!before) {
      return;
    }
    if (this.toPublic(before).capabilities.audio_output === 'supported') {
      return;
    }
    const medias = await this.media.getStreamMedias(this.streamName(id));
    if (!medias || !this.reconcileIsCurrent(id, generation)) {
      return;
    }
    const audioTracks = medias.filter((media) => media.startsWith('audio'));
    if (audioTracks.length === 0) {
      return;
    }
    // Перечитываем capabilities после await: новая попытка могла уже обновить их.
    const current = this.repo.get(id);
    if (!current) {
      return;
    }
    const capabilities = this.toPublic(current).capabilities;
    if (capabilities.audio_output === 'supported') {
      return;
    }
    const state: CameraCapabilities['audio_output'] =
      audioTracks.some((media) => media.includes('sendonly') || media.includes('sendrecv')) ? 'supported' : 'unsupported';
    if (capabilities.audio_output !== state) {
      this.repo.update(id, { capabilities: { ...capabilities, audio_output: state } });
    }
  }

  private stopRuntime(id: string): void {
    this.beginReconcile(id);
    const runtime = this.runtimes.get(id);
    if (runtime) {
      this.runtimes.delete(id);
      runtime.unsubscribeEvents?.();
      for (const timer of runtime.probeTimers) {
        clearTimeout(timer);
      }
      void runtime.session?.close().catch(() => undefined);
    }
    for (const key of [...this.snapCache.keys()]) {
      if (key.startsWith(`${id}:`)) {
        this.snapCache.delete(key);
      }
    }
  }

  private setState(id: string, state: CameraRow['state'], error: unknown): void {
    const current = this.repo.get(id);
    if (!current || (!current.enabled && state !== 'disabled')) {
      return;
    }
    this.repo.update(id, {
      state,
      lastError: JSON.stringify({
        code: error instanceof CameraAdapterDetectionError ? 'CAMERA_ADAPTER_NOT_DETECTED' : 'CAMERA_UNAVAILABLE',
        message: adapterErrorMessage(error),
        occurred_at: new Date().toISOString(),
      }),
    });
  }

  private async removeStreamOrEnqueue(id: string): Promise<void> {
    await this.media.deleteStream(this.streamName(id)).catch(() => {
      this.enqueueCleanup(this.streamName(id));
    });
  }

  private enqueueCleanup(streamName: string): void {
    try {
      this.handle.db.insert(mediaCleanup).values({ streamName, createdAt: new Date().toISOString() }).run();
    } catch {
      // запись уже есть или БД недоступна
    }
  }

  private async processCleanupQueue(): Promise<void> {
    const rows = this.handle.db.select().from(mediaCleanup).all();
    for (const row of rows) {
      try {
        await this.media.deleteStream(row.streamName);
        this.handle.db.delete(mediaCleanup).where(eq(mediaCleanup.id, row.id)).run();
      } catch {
        break; // медиашлюз недоступен — повторим позже
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.runtimes.keys()]) {
      this.ptz.stopBestEffort(id, () => this.runtimeSession(id));
      this.stopRuntime(id);
    }
    this.sse.closeAll();
  }

  repository(): CameraRepository {
    return this.repo;
  }

  decryptPassword(row: CameraRow): string {
    return decryptSecret(row.passwordEnc, this.cameraKey);
  }
}

function adapterErrorMessage(error: unknown): string {
  if (error instanceof CameraAdapterDetectionError) {
    return error.message;
  }
  if (error instanceof Error && error.name.toLowerCase().includes('timeout')) {
    return 'Камера не ответила за отведённое время. Проверьте сеть и адрес камеры.';
  }
  return 'Не удалось подключиться к камере. Проверьте адрес, порт, логин и пароль.';
}

function adapterError(error: unknown): ApiError {
  if (error instanceof CameraAdapterDetectionError) {
    return new ApiError(422, 'CAMERA_ADAPTER_NOT_DETECTED', error.message, { attempts: error.attempts });
  }
  if (error instanceof Error && error.name.toLowerCase().includes('timeout')) {
    return new ApiError(504, 'MEDIA_TIMEOUT', 'Камера не ответила за отведённое время. Проверьте сеть и адрес камеры.');
  }
  return new ApiError(
    502,
    'CAMERA_UNAVAILABLE',
    'Не удалось подключиться к камере. Проверьте адрес, порт, логин и пароль.',
  );
}

function upstreamError(error: unknown): ApiError {
  if (error instanceof CameraAdapterDetectionError) {
    return adapterError(error);
  }
  const isTimeout = error instanceof Error && error.name.toLowerCase().includes('timeout');
  return isTimeout
    ? new ApiError(504, 'MEDIA_TIMEOUT', 'Камера не ответила за отведённое время')
    : new ApiError(502, 'CAMERA_UNAVAILABLE', adapterErrorMessage(error));
}

function mediaError(error: unknown): ApiError {
  const e = error as { status?: string; message?: string };
  if (e?.status === 'timeout') {
    return new ApiError(504, 'MEDIA_TIMEOUT', 'Таймаут медиашлюза');
  }
  if (e?.status === 'unavailable') {
    return new ApiError(503, 'CAMERA_MEDIA_UNAVAILABLE', 'Медиапоток камеры недоступен');
  }
  return new ApiError(502, 'MEDIA_UPSTREAM_ERROR', safeCameraMessage(error));
}
