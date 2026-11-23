/** Общий контракт камеры. Бизнес-логика не знает протокол и модель устройства. */

export type CapabilityState = 'supported' | 'unsupported' | 'unknown';

export interface CameraCapabilities {
  video: CapabilityState;
  /** Приём звука с микрофона камеры. */
  audio: CapabilityState;
  /** Передача звука на динамик камеры. */
  audio_output: CapabilityState;
  motion_events: CapabilityState;
  ptz_continuous: CapabilityState;
  ptz_presets: CapabilityState;
}

export interface MediaProfileInfo {
  token: string;
  name: string;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodecs: string[];
}

export interface DeviceInfo {
  manufacturer: string | null;
  model: string | null;
  firmware: string | null;
}

export interface ProbeDiagnostic {
  check: string;
  status: 'ok' | 'warning' | 'error';
  message: string;
}

export interface ProbeResult {
  device: DeviceInfo;
  capabilities: CameraCapabilities;
  profiles: MediaProfileInfo[];
  diagnostics: ProbeDiagnostic[];
}

export interface CameraConnection {
  host: string;
  port: number;
  username: string;
  password: string;
  timeoutMs: number;
  /** Пользовательский RTSP URL без учётных данных. */
  rtspUrlOverride?: string | null;
}

export interface RawCameraEvent {
  /** Исходный топик, например tns1:RuleEngine/CellMotionDetector/Motion. */
  topic: string;
  /** Время камеры из сообщения, если есть. */
  utcTime: string | null;
  /** MessageID доставки, если камера его предоставляет (для дедупликации). */
  messageId: string | null;
  /** Имя simpleItem, описывающего состояние (IsMotion и т.п.). */
  stateName: string | null;
  /** Значение simpleItem (true/false/1/0). */
  stateValue: string | null;
}

/** Открытая сессия камеры. Протокол полностью скрыт реализацией. */
export interface CameraSession {
  /** Все источники для go2rtc. URL содержит учётные данные и не попадает наружу. */
  getMediaSources(profileToken: string): Promise<string[]>;
  /** Источник для FFmpeg-захвата входящего звука или null. */
  getAudioCaptureUri(profileToken: string): Promise<string | null>;
  ptzContinuousMove(pan: number, tilt: number, zoom: number, timeoutMs: number): Promise<void>;
  ptzStop(): Promise<void>;
  getPtzPresets(profileToken: string): Promise<{ token: string; name: string }[]>;
  gotoPreset(profileToken: string, presetToken: string): Promise<void>;
  /** Подписывается на события. Возвращает функцию отписки. */
  onEvent(handler: (event: RawCameraEvent) => void): () => void;
  close(): Promise<void>;
}

/** Один протокол или семейство камер. Реализацию выбирает реестр перебором. */
export interface CameraAdapter {
  readonly id: string;
  readonly displayName: string;
  probe(conn: CameraConnection): Promise<ProbeResult>;
  open(conn: CameraConnection): Promise<CameraSession>;
}

export interface SelectedCameraAdapter {
  adapter: CameraAdapter;
  result: ProbeResult;
}

export interface AdapterAttemptFailure {
  adapter: string;
  reason: string;
}

/** Адаптер понял, что камера не его. Это штатный результат перебора. */
export class AdapterNotApplicableError extends Error {
  constructor(message = 'Адаптер не подходит камере') {
    super(message);
    this.name = 'AdapterNotApplicableError';
  }
}

/** Ни один адаптер не смог определить камеру. Сообщение предназначено пользователю. */
export class CameraAdapterDetectionError extends Error {
  constructor(readonly attempts: AdapterAttemptFailure[]) {
    super('Не удалось определить тип камеры. Проверьте IP-адрес, порт, логин и пароль.');
    this.name = 'CameraAdapterDetectionError';
  }
}

/** Очищает текст ошибки от userinfo и ограничивает длину. */
export function safeCameraMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/\/\/[^/@\s]+@/g, '//***@').slice(0, 300);
  }
  return String(error).slice(0, 300);
}
