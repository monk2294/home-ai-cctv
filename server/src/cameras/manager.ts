import { eq } from 'drizzle-orm';
import type { DbHandle } from '../db/client.js';
import { decryptSecret, encryptSecret } from '../db/crypto.js';
import { cameras, mediaCleanup } from '../db/schema.js';
import type { MediaGatewayClient } from '../media/client.js';
import { safeMessage } from '../onvif/adapter.js';
import type { CameraCapabilities, OnvifAdapter, OnvifSession, ProbeResult } from '../onvif/types.js';
import { CameraRepository, MAX_CAMERAS, probeStreamName, streamNameFor, type CameraRow } from './repository.js';
import type { EventService } from '../events/service.js';
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

/** RTSP-URL с учётными данными внутри — только для внутреннего источника go2rtc, не для логов. */
function buildRtspSource(uri: string, username: string, password: string): string {
  const parsed = new URL(uri);
  parsed.username = encodeURIComponent(username);
  parsed.password = encodeURIComponent(password);
  return parsed.toString();
}

interface CameraRuntime {
  session: OnvifSession | null;
  unsubscribeEvents: (() => void) | null;
  probeTimers: Set<NodeJS.Timeout>;
}

/**
 * Camera Manager: probe, CRUD, состояние, ONVIF-подключения, Reconciliation.
 * Ошибка одной камеры не блокирует остальные (NFR-11).
 */
export class CameraManager {
  private readonly repo: CameraRepository;
  private readonly runtimes = new Map<string, CameraRuntime>();

  constructor(
    private readonly handle: DbHandle,
    private readonly onvif: OnvifAdapter,
    private readonly media: MediaGatewayClient,
    private readonly events: EventService,
    private readonly sse: SseHub,
    private readonly ptz: PtzService,
    private readonly cameraKey: Buffer,
  ) {
    this.repo = new CameraRepository(handle.db);
  }

  // ---------- public model ----------

  toPublic(row: CameraRow): PublicCamera {
    let capabilities: CameraCapabilities = {
      video: 'unknown',
      audio: 'unknown',
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

  async probe(input: ProbeRequestInput): Promise<ProbeResult> {
    if (input.rtspUrlOverride != null) {
      validateRtspOverride(input.rtspUrlOverride);
    }
    try {
      return await this.onvif.probe({
        host: input.host,
        onvifPort: input.onvifPort,
        username: input.username,
        password: input.password,
        timeoutMs: ONVIF_TIMEOUT_MS,
      });
    } catch (error) {
      throw upstreamError(error);
    }
  }

  /** Тестовый снимок до сохранения: временный probe_-поток, удаление в finally. */
  async probeSnapshot(input: ProbeRequestInput & { profileToken: string }, width?: number): Promise<Buffer> {
    const rtspUri = await this.resolveRtspUri(input, input.profileToken);
    const name = probeStreamName();
    try {
      await this.media.putStream(name, [rtspUri]);
      return await this.media.getFrame(name, width);
    } finally {
      await this.media.deleteStream(name).catch(() => {
        this.enqueueCleanup(name);
      });
    }
  }

  private async resolveRtspUri(input: ProbeRequestInput, profileToken: string): Promise<string> {
    if (input.rtspUrlOverride) {
      validateRtspOverride(input.rtspUrlOverride);
      return buildRtspSource(input.rtspUrlOverride, input.username, input.password);
    }
    try {
      const session = await this.onvif.open({
        host: input.host,
        onvifPort: input.onvifPort,
        username: input.username,
        password: input.password,
        timeoutMs: ONVIF_TIMEOUT_MS,
      });
      try {
        const uri = await session.getStreamUri(profileToken);
        return buildRtspSource(uri, input.username, input.password);
      } finally {
        await session.close().catch(() => undefined);
      }
    } catch (error) {
      throw upstreamError(error);
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
    if (this.repo.count() >= MAX_CAMERAS) {
      throw new ApiError(409, 'CAMERA_LIMIT_REACHED', `Лимит камер: ${MAX_CAMERAS}`);
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
      motion_events: 'unknown',
      ptz_continuous: 'unknown',
      ptz_presets: 'unknown',
    };
    let lastError: string | null = null;

    // Для enabled=true повторно получаем RTSP URI и возможности.
    if (enabled) {
      try {
        const session = await this.onvif.open({
          host: input.host,
          onvifPort: input.onvifPort,
          username: input.username,
          password: input.password,
          timeoutMs: ONVIF_TIMEOUT_MS,
        });
        try {
          // GetStreamUri — сетевой шаг 3.
          const probe = await this.onvif.probe({
            host: input.host,
            onvifPort: input.onvifPort,
            username: input.username,
            password: input.password,
            timeoutMs: ONVIF_TIMEOUT_MS,
          });
          capabilities = probe.capabilities;
          await session.getStreamUri(input.profileToken);
        } finally {
          await session.close().catch(() => undefined);
        }
      } catch (error) {
        lastError = JSON.stringify({ code: 'ONVIF_UPSTREAM_ERROR', message: safeMessage(error), occurred_at: new Date().toISOString() });
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
      await this.reconcileCamera(row.id).catch((error: unknown) => {
        this.setState(row.id, 'offline', error);
      });
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
      this.removeStreamOrEnqueue(id);
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
      await this.reconcileCamera(id).catch((error: unknown) => {
        this.setState(id, 'offline', error);
      });
    } else if (!disabling && row.enabled && connectionChanged) {
      this.stopRuntime(id);
      await this.reconcileCamera(id).catch((error: unknown) => {
        this.setState(id, 'offline', error);
      });
    }
    return this.getCamera(id);
  }

  async delete(id: string): Promise<void> {
    const row = this.requireCamera(id);
    void row;
    this.stopRuntime(id);
    this.ptz.stopBestEffort(id, () => this.runtimeSession(id));
    this.removeStreamOrEnqueue(id);
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
    await this.reconcileCamera(id).catch((error: unknown) => {
      this.setState(id, 'offline', error);
    });
    return this.getCamera(id);
  }

  // ---------- media ----------

  streamName(id: string): string {
    return streamNameFor(id);
  }

  /** JPEG для администратора и ИИ: общий путь к go2rtc. */
  async snapshot(id: string, width?: number): Promise<Buffer> {
    const row = this.requireCamera(id);
    if (!row.enabled) {
      throw new ApiError(409, 'CAMERA_DISABLED', 'Камера отключена');
    }
    try {
      return await this.media.getFrame(this.streamName(id), width);
    } catch (error) {
      throw mediaError(error);
    }
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

  runtimeSession(id: string): OnvifSession | null {
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
      await this.reconcileCamera(camera.id).catch((error: unknown) => {
        this.setState(camera.id, 'offline', error);
      });
    }

    await this.processCleanupQueue().catch(() => undefined);
  }

  /** Reconciliation одной камеры: поток go2rtc + ONVIF-сессия + подписки. */
  private async reconcileCamera(id: string): Promise<void> {
    const row = this.repo.get(id);
    if (!row || !row.enabled) {
      return;
    }
    this.repo.update(id, { state: 'connecting' });

    const password = decryptSecret(row.passwordEnc, this.cameraKey);
    const rtspOverride = row.rtspOverrideEnc ? decryptSecret(row.rtspOverrideEnc, this.cameraKey) : null;
    const conn = { host: row.host, onvifPort: row.onvifPort, username: row.username, password, timeoutMs: ONVIF_TIMEOUT_MS };

    // 1. Поток go2rtc (опционально RTSP override без ONVIF).
    let rtspUri: string;
    let session: OnvifSession | null = null;
    if (rtspOverride) {
      rtspUri = buildRtspSource(rtspOverride, row.username, password);
    } else {
      session = await this.onvif.open(conn);
      try {
        rtspUri = buildRtspSource(await session.getStreamUri(row.profileToken), row.username, password);
      } catch (error) {
        await session.close().catch(() => undefined);
        throw error;
      }
    }

    try {
      await this.media.putStream(this.streamName(id), [rtspUri]);
    } catch (error) {
      if (session) {
        await session.close().catch(() => undefined);
      }
      // Камера сохранена, состояние degraded/connecting — backoff повторит (раздел 5.2).
      this.repo.update(id, { state: 'degraded', lastError: JSON.stringify({ code: 'MEDIA_GATEWAY_UNAVAILABLE', message: safeMessage(error), occurred_at: new Date().toISOString() }) });
      throw error;
    }

    // 2. ONVIF-сессия и подписки (без собственного getStreamUri при override).
    if (session) {
      const runtime = this.ensureRuntime(id);
      runtime.session = session;
      runtime.unsubscribeEvents = session.onEvent((raw) => {
        const stored = this.events.handleRawEvent(id, raw);
        if (stored.inserted && stored.event) {
          this.handle.db
            .update(cameras)
            .set({ lastEventAt: stored.event.received_at })
            .where(eq(cameras.id, id))
            .run();
          // Первое подтверждённое событие движения уточняет capability (раздел 6.1).
          const current = this.repo.get(id);
          if (current) {
            const capabilities = this.toPublic(current).capabilities;
            if (capabilities.motion_events === 'unknown') {
              this.repo.update(id, { capabilities: { ...capabilities, motion_events: 'supported' } });
            }
          }
          this.sse.broadcast(stored.event);
        }
      });
      this.repo.update(id, { state: 'online', lastSeenAt: new Date().toISOString(), lastError: null });
    } else {
      this.repo.update(id, { state: 'degraded', lastSeenAt: new Date().toISOString() });
    }
  }

  private ensureRuntime(id: string): CameraRuntime {
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      runtime = { session: null, unsubscribeEvents: null, probeTimers: new Set() };
      this.runtimes.set(id, runtime);
    }
    return runtime;
  }

  private stopRuntime(id: string): void {
    const runtime = this.runtimes.get(id);
    if (!runtime) {
      return;
    }
    this.runtimes.delete(id);
    runtime.unsubscribeEvents?.();
    for (const timer of runtime.probeTimers) {
      clearTimeout(timer);
    }
    void runtime.session?.close().catch(() => undefined);
  }

  private setState(id: string, state: CameraRow['state'], error: unknown): void {
    this.repo.update(id, {
      state,
      lastError: JSON.stringify({ code: 'ONVIF_UPSTREAM_ERROR', message: safeMessage(error), occurred_at: new Date().toISOString() }),
    });
  }

  private removeStreamOrEnqueue(id: string): void {
    this.media.deleteStream(this.streamName(id)).catch(() => {
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

function upstreamError(error: unknown): ApiError {
  const message = safeMessage(error);
  const isTimeout = error instanceof Error && error.name.toLowerCase().includes('timeout');
  return isTimeout
    ? new ApiError(504, 'ONVIF_TIMEOUT', 'Таймаут ONVIF-запроса')
    : new ApiError(502, 'ONVIF_UPSTREAM_ERROR', message);
}

function mediaError(error: unknown): ApiError {
  const e = error as { status?: string; message?: string };
  if (e?.status === 'timeout') {
    return new ApiError(504, 'MEDIA_TIMEOUT', 'Таймаут медиашлюза');
  }
  if (e?.status === 'unavailable') {
    return new ApiError(503, 'CAMERA_MEDIA_UNAVAILABLE', 'Медиапоток камеры недоступен');
  }
  return new ApiError(502, 'MEDIA_UPSTREAM_ERROR', safeMessage(error));
}
