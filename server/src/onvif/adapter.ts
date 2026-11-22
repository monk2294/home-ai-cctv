import { Onvif, OnvifError, Subscription } from 'onvif';
import type {
  CameraCapabilities,
  CameraConnection,
  MediaProfileInfo,
  OnvifAdapter,
  OnvifSession,
  ProbeDiagnostic,
  ProbeResult,
  RawCameraEvent,
} from './types.js';

/** Топики стандартного движения ONVIF. Неизвестный топик движением не считается. */
const MOTION_TOPICS = [
  'tns1:RuleEngine/CellMotionDetector/Motion',
  'tns1:RuleEngine/MotionRegionDetector/Motion',
];

export function isMotionTopic(topic: string): boolean {
  return MOTION_TOPICS.includes(topic);
}

/** Приводит RawCameraEvent к состоянию движения или null, если событие не про движение. */
export function normalizeMotion(event: RawCameraEvent): { state: 'active' | 'inactive' } | null {
  if (!isMotionTopic(event.topic)) {
    return null;
  }
  const value = (event.stateValue ?? '').toLowerCase();
  if (value === 'true' || value === '1') {
    return { state: 'active' };
  }
  if (value === 'false' || value === '0') {
    return { state: 'inactive' };
  }
  return null;
}

function createClient(conn: CameraConnection): Onvif {
  return new Onvif({
    hostname: conn.host,
    port: conn.onvifPort,
    username: conn.username,
    password: conn.password,
    timeout: conn.timeoutMs,
  });
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
    motion_events: hasEvents ? 'unknown' : 'unsupported',
    ptz_continuous: hasPtz ? 'supported' : 'unsupported',
    ptz_presets: hasPtz ? 'supported' : 'unsupported',
  };
}

export class LibOnvifSession implements OnvifSession {
  private eventUnsubscribe: (() => void) | null = null;

  constructor(private readonly client: Onvif) {}

  async getStreamUri(profileToken: string): Promise<string> {
    const client = this.client;
    await client.setActiveMediaProfile(profileToken);
    if (client.uri.media) {
      const result = await client.media.getStreamUri({ protocol: 'RTSP' });
      return result.uri;
    }
    return client.media2.getStreamUri({ protocol: 'RtspUnicast' });
  }

  async ptzContinuousMove(pan: number, tilt: number, zoom: number, _timeoutMs: number): Promise<void> {
    // Tapo C520WS (firmware 1.3.5) рвёт соединение на параметре Timeout в ContinuousMove.
    // Сервер сам планирует Stop на тот же срок (D-10), поэтому Timeout камере не передаём.
    await this.client.ptz.continuousMove({
      velocity: { x: pan, y: tilt, zoom },
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
    if (item.name === 'IsMotion' || item.name === 'Motion') {
      stateName = String(item.name);
      stateValue = item.value === undefined || item.value === null ? null : String(item.value);
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

/** Адаптер на библиотеке agsh/onvif. Выбор подтверждается интеграционным тестом T-01/T-07. */
export class LibOnvifAdapter implements OnvifAdapter {
  async probe(conn: CameraConnection): Promise<ProbeResult> {
    const client = createClient(conn);
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

  async open(conn: CameraConnection): Promise<OnvifSession> {
    const client = createClient(conn);
    await client.connect();
    return new LibOnvifSession(client);
  }
}

async function safeCall<T>(fn: () => Promise<T>, check: string, diagnostics: ProbeDiagnostic[]): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    diagnostics.push({ check, status: 'error', message: safeMessage(error) });
    return null;
  }
}

/** Очищенное от секретов сообщение об ошибке (NFR-08). */
export function safeMessage(error: unknown): string {
  if (error instanceof OnvifError) {
    return `${error.name}: ${error.message}`.slice(0, 300);
  }
  if (error instanceof Error) {
    return error.message.replace(/\/\/[^/@\s]+@/g, '//***@').slice(0, 300);
  }
  return String(error).slice(0, 300);
}
