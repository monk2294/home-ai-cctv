/** Типы ONVIF-адаптера. Бизнес-логика зависит только от этого интерфейса. */

export type CapabilityState = 'supported' | 'unsupported' | 'unknown';

export interface CameraCapabilities {
  video: CapabilityState;
  audio: CapabilityState;
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
  onvifPort: number;
  username: string;
  password: string;
  /** Общий таймаут ONVIF-операций, мс. */
  timeoutMs: number;
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

/** Открытая сессия к камере: ONVIF-подключение и подписка на события. */
export interface OnvifSession {
  getStreamUri(profileToken: string): Promise<string>;
  ptzContinuousMove(pan: number, tilt: number, zoom: number, timeoutMs: number): Promise<void>;
  ptzStop(): Promise<void>;
  getPtzPresets(profileToken: string): Promise<{ token: string; name: string }[]>;
  gotoPreset(profileToken: string, presetToken: string): Promise<void>;
  /** Подписывается на события. Возвращает функцию отписки. */
  onEvent(handler: (event: RawCameraEvent) => void): () => void;
  close(): Promise<void>;
}

export interface OnvifAdapter {
  probe(conn: CameraConnection): Promise<ProbeResult>;
  /** Подключение с медиапрофилями; слушатель событий подключается отдельно. */
  open(conn: CameraConnection): Promise<OnvifSession>;
}
