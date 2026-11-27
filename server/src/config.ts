import { readFileSync } from 'node:fs';

export const DEFAULT_MAX_CAMERAS = 4;
export const DEFAULT_EVENT_RETENTION_PER_CAMERA = 1000;
export const DEFAULT_HTTP_RATE_LIMIT_PER_MINUTE = 1200;

/** Значение конфигурации сервера. Все секреты читаются из файлов. */
export interface Config {
  host: string;
  port: number;
  databasePath: string;
  maxCameras: number;
  eventRetentionPerCamera: number;
  httpRateLimitPerMinute: number;
  /** Содержимое файла ADMIN_PASSWORD_FILE. Только для первичного bootstrap. */
  adminBootstrapPassword: string;
  /** Содержимое файла AI_API_TOKEN_FILE. */
  aiApiToken: string;
  /** Содержимое файла CAMERA_ENCRYPTION_KEY_FILE, base64, 32 байта. */
  cameraEncryptionKeyB64: string;
  sessionCookieSecure: boolean;
  mediaApiBaseUrl: string;
  /** Внутренний base URL этого сервера для выдачи аудио контейнеру media. */
  audioInternalBaseUrl: string;
  /** Опциональный MQTT-публикатор camera events. Без MQTT_URL выключен. */
  mqtt: {
    url: string;
    username?: string;
    password?: string;
  } | null;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

const LOG_LEVELS: readonly Config['logLevel'][] = ['debug', 'info', 'warn', 'error'];

function readSecretFile(env: NodeJS.ProcessEnv, envName: string): string {
  const path = env[envName];
  if (!path) {
    throw new Error(`Переменная ${envName} не задана`);
  }
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Файл ${envName}=${path} не читается`);
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw new Error(`Файл ${envName}=${path} пуст`);
  }
  return trimmed;
}

function readPositiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name}=${raw} не является положительным целым числом`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const logLevelRaw = env.LOG_LEVEL ?? 'info';
  if (!LOG_LEVELS.includes(logLevelRaw as Config['logLevel'])) {
    throw new Error(`LOG_LEVEL=${logLevelRaw} не поддерживается`);
  }

  const port = Number(env.SERVER_PORT ?? '8000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SERVER_PORT=${env.SERVER_PORT} не является портом`);
  }

  const maxCameras = readPositiveInteger(env, 'MAX_CAMERAS', DEFAULT_MAX_CAMERAS);
  const eventRetentionPerCamera = readPositiveInteger(
    env,
    'EVENT_RETENTION_PER_CAMERA',
    DEFAULT_EVENT_RETENTION_PER_CAMERA,
  );
  const httpRateLimitPerMinute = readPositiveInteger(
    env,
    'HTTP_RATE_LIMIT_PER_MINUTE',
    DEFAULT_HTTP_RATE_LIMIT_PER_MINUTE,
  );
  const cameraEncryptionKeyB64 = readSecretFile(env, 'CAMERA_ENCRYPTION_KEY_FILE');
  const mqtt = readMqttConfig(env);

  return {
    host: env.SERVER_HOST ?? '127.0.0.1',
    port,
    databasePath: env.DATABASE_PATH ?? '/data/home-ai-cctv.db',
    maxCameras,
    eventRetentionPerCamera,
    httpRateLimitPerMinute,
    adminBootstrapPassword: readSecretFile(env, 'ADMIN_PASSWORD_FILE'),
    aiApiToken: readSecretFile(env, 'AI_API_TOKEN_FILE'),
    cameraEncryptionKeyB64,
    sessionCookieSecure: env.SESSION_COOKIE_SECURE === 'true',
    mediaApiBaseUrl: env.MEDIA_API_BASE_URL ?? 'http://127.0.0.1:1984',
    audioInternalBaseUrl: env.AUDIO_INTERNAL_BASE_URL ?? `http://127.0.0.1:${port}`,
    mqtt,
    logLevel: logLevelRaw as Config['logLevel'],
  };
}

/** Опциональный MQTT-публикатор событий. Пароль читается только из файла, userinfo в URL запрещён. */
function readMqttConfig(env: NodeJS.ProcessEnv): Config['mqtt'] {
  const url = env.MQTT_URL;
  const username = env.MQTT_USERNAME;
  const passwordFile = env.MQTT_PASSWORD_FILE;

  if (!url) {
    if (username || passwordFile) {
      throw new Error('MQTT_URL обязателен при MQTT_USERNAME или MQTT_PASSWORD_FILE');
    }
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Значение URL не включаем: оно может содержать userinfo с паролем.
    throw new Error('MQTT_URL некорректен');
  }
  if (parsed.protocol !== 'mqtt:' && parsed.protocol !== 'mqtts:') {
    throw new Error('MQTT_URL должен использовать mqtt:// или mqtts://');
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    throw new Error('MQTT_URL должен содержать host без userinfo');
  }
  if (Boolean(username) !== Boolean(passwordFile)) {
    throw new Error('MQTT_USERNAME и MQTT_PASSWORD_FILE задаются вместе');
  }

  const password = passwordFile ? readSecretFile(env, 'MQTT_PASSWORD_FILE') : undefined;
  return { url, ...(username !== undefined && password !== undefined ? { username, password } : {}) };
}

/** Проверяет формат ключа шифрования камер: base64 ровно на 32 байта. */
export function validateCameraEncryptionKey(keyB64: string): void {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32 || key.toString('base64') !== keyB64) {
    throw new Error('CAMERA_ENCRYPTION_KEY_FILE должен содержать base64 ровно от 32 байт');
  }
}
