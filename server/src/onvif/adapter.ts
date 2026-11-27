import { Onvif } from 'onvif';
import { safeCameraMessage } from '../cameras/adapter.js';
import type {
  CameraAdapter,
  CameraCapabilities,
  CameraConnection,
  CameraSession,
  MediaProfileInfo,
  ProbeDiagnostic,
  ProbeResult,
  RawCameraEvent,
} from '../cameras/adapter.js';

export function createOnvifClient(conn: CameraConnection): Onvif {
  return new Onvif({
    hostname: conn.host,
    port: conn.port,
    username: conn.username,
    password: conn.password,
    timeout: conn.timeoutMs,
  });
}

/** Добавляет учётные данные в RTSP URL. Результат доступен только go2rtc. */
function withCredentials(uri: string, conn: CameraConnection): string {
  const parsed = new URL(uri);
  parsed.username = encodeURIComponent(conn.username);
  parsed.password = encodeURIComponent(conn.password);
  return parsed.toString();
}

function ptzTimeout(timeoutMs: number): string {
  return `PT${Math.max(1, Math.ceil(timeoutMs / 1000))}S`;
}

function toProfileInfo(p: {
  token?: string;
  name?: string;
  videoEncoderConfiguration?: { resolution?: { width?: number; height?: number }; encoding?: string } | null;
  audioEncoderConfiguration?: { encoding?: string } | null;
}): MediaProfileInfo {
  return {
    token: p.token ?? '',
    name: p.name ?? '',
    width: p.videoEncoderConfiguration?.resolution?.width ?? null,
    height: p.videoEncoderConfiguration?.resolution?.height ?? null,
    videoCodec: p.videoEncoderConfiguration?.encoding ?? null,
    audioCodecs: p.audioEncoderConfiguration?.encoding ? [p.audioEncoderConfiguration.encoding] : [],
  };
}

function capabilitiesFrom(client: Onvif, hasAudio: boolean): CameraCapabilities {
  const hasMedia = Boolean(client.uri.media ?? client.uri.media2);
  const hasPtz = Boolean(client.uri.ptz);
  const hasEvents = Boolean(client.uri.events);
  return {
    video: hasMedia ? 'supported' : 'unsupported',
    audio: hasMedia ? (hasAudio ? 'supported' : 'unsupported') : 'unsupported',
    // Backchannel по одному лишь ONVIF-описанию надёжно не определить:
    // значение уточняется по SDP продюсера go2rtc (reconcileCamera).
    audio_output: 'unknown',
    motion_events: hasEvents ? 'unknown' : 'unsupported',
    ptz_continuous: hasPtz ? 'supported' : 'unsupported',
    ptz_presets: hasPtz ? 'supported' : 'unsupported',
  };
}

export class LibOnvifSession implements CameraSession {
  private eventUnsubscribe: (() => void) | null = null;
  private rtspSource: Promise<string> | null = null;

  constructor(
    protected readonly client: Onvif,
    protected readonly conn: CameraConnection,
  ) {}

  /** RTSP URL с учётными данными, один раз на сессию. */
  protected getRtspSource(profileToken: string): Promise<string> {
    this.rtspSource ??= this.resolveRtspSource(profileToken);
    return this.rtspSource;
  }

  private async resolveRtspSource(profileToken: string): Promise<string> {
    if (this.conn.rtspUrlOverride) {
      return withCredentials(this.conn.rtspUrlOverride, this.conn);
    }
    await this.client.setActiveMediaProfile(profileToken);
    const uri = this.client.uri.media
      ? (await this.client.media.getStreamUri({ protocol: 'RTSP' })).uri
      : await this.client.media2.getStreamUri({ protocol: 'RtspUnicast' });
    return withCredentials(uri, this.conn);
  }

  async getMediaSources(profileToken: string): Promise<string[]> {
    return [await this.getRtspSource(profileToken)];
  }

  async getAudioCaptureUri(profileToken: string): Promise<string | null> {
    return this.getRtspSource(profileToken);
  }

  async ptzContinuousMove(pan: number, tilt: number, zoom: number, timeoutMs: number): Promise<void> {
    await this.client.ptz.continuousMove({
      velocity: { x: pan, y: tilt, zoom },
      timeout: ptzTimeout(timeoutMs),
    });
  }

  async ptzStop(): Promise<void> {
    await this.client.ptz.stop();
  }

  async getPtzPresets(profileToken: string): Promise<{ token: string; name: string }[]> {
    const presets = await this.client.ptz.getPresets({ profileToken });
    return presets
      .filter((p) => p.token != null)
      // Tapo отдаёт token числом; контракт API и проверка goto ждут строку.
      .map((p) => ({ token: String(p.token), name: p.name ?? String(p.token) }));
  }

  async gotoPreset(profileToken: string, presetToken: string): Promise<void> {
    await this.client.ptz.gotoPreset({ profileToken, presetToken });
  }

  onEvent(handler: (event: RawCameraEvent) => void): () => void {
    const listener = (msg: unknown): void => {
      handler(extractRawEvent(msg));
    };
    const errorListener = (): void => {
      // Ошибки pull-point обрабатывает сама библиотека (reconnect/backoff).
    };
    this.client.on('event', listener);
    this.client.on('eventError', errorListener);
    this.eventUnsubscribe = () => {
      this.client.off('event', listener);
      this.client.off('eventError', errorListener);
      this.client.removeAllListeners('event');
    };
    return this.eventUnsubscribe;
  }

  async close(): Promise<void> {
    this.eventUnsubscribe?.();
    await this.client.close();
  }
}

/** Извлекает topic/время/состояние из NotificationMessage agsh/onvif. */
export function extractRawEvent(msg: unknown): RawCameraEvent {
  const m = msg as {
    topic?: { _?: string } | string;
    message?: {
      message?: {
        $?: { UtcTime?: string };
        data?: { simpleItem?: unknown };
      };
    };
  };
  const topic = typeof m.topic === 'string' ? m.topic : (m.topic?._ ?? '');
  const inner = m.message?.message;
  // simpleItem бывает одиночным объектом или массивом — камеры ведут себя по-разному.
  const rawItems = inner?.data?.simpleItem;
  const items: { name?: unknown; value?: unknown }[] = Array.isArray(rawItems)
    ? (rawItems as { name?: unknown; value?: unknown }[])
    : rawItems && typeof rawItems === 'object'
      ? [rawItems as { name?: unknown; value?: unknown }]
      : [];
  let stateName: string | null = null;
  let stateValue: string | null = null;
  for (const item of items) {
    // Берём первое булево-подобное значение: IsMotion, IsPeople, IsTamper и другие Is*.
    const value = item.value === undefined || item.value === null ? null : String(item.value);
    const normalizedValue = (value ?? '').toLowerCase();
    if (normalizedValue === 'true' || normalizedValue === 'false' || normalizedValue === '1' || normalizedValue === '0') {
      stateName = String(item.name ?? '');
      stateValue = value;
      break;
    }
  }
  return {
    topic,
    utcTime: inner?.$?.UtcTime ?? null,
    messageId: null,
    stateName,
    stateValue,
  };
}

/** Общий ONVIF-адаптер. Реестр проверяет его после специализированных адаптеров. */
export class LibOnvifAdapter implements CameraAdapter {
  readonly id = 'onvif';
  readonly displayName = 'ONVIF';

  async probe(conn: CameraConnection): Promise<ProbeResult> {
    const client = createOnvifClient(conn);
    const diagnostics: ProbeDiagnostic[] = [];
    try {
      await client.connect();
      const device = await safeCall(() => client.device.getDeviceInformation(), 'device', diagnostics);
      let profiles: MediaProfileInfo[] = [];
      if (client.uri.media ?? client.uri.media2) {
        profiles = (await client.media.getProfiles()).map(toProfileInfo);
        diagnostics.push({ check: 'profiles', status: 'ok', message: `Профилей: ${profiles.length}` });
      } else {
        diagnostics.push({ check: 'profiles', status: 'error', message: 'Media-сервис не найден' });
      }
      const hasAudio = profiles.some((p) => p.audioCodecs.length > 0);
      const capabilities = capabilitiesFrom(client, hasAudio);
      if (capabilities.motion_events === 'unknown') {
        diagnostics.push({ check: 'events', status: 'warning', message: 'Свойства событий не запрошены; поддержка уточняется подпиской' });
      }
      return {
        device: {
          manufacturer: device?.manufacturer ?? null,
          model: device?.model ?? null,
          firmware: device?.firmwareVersion ?? null,
        },
        capabilities,
        profiles,
        diagnostics,
      };
    } finally {
      await client.close();
    }
  }

  async open(conn: CameraConnection): Promise<CameraSession> {
    const client = createOnvifClient(conn);
    await client.connect();
    return new LibOnvifSession(client, conn);
  }
}

async function safeCall<T>(fn: () => Promise<T>, check: string, diagnostics: ProbeDiagnostic[]): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    diagnostics.push({ check, status: 'error', message: safeCameraMessage(error) });
    return null;
  }
}
