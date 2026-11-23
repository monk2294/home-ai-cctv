import { readFileSync } from 'node:fs';

export const DEFAULT_MAX_CAMERAS = 4;
export const DEFAULT_EVENT_RETENTION_PER_CAMERA = 1000;

/** Значение конфигурации сервера. Все секреты читаются из файлов. */
export interface Config {
  host: string;
  port: number;
  databasePath: string;
  maxCameras: number;
  eventRetentionPerCamera: number;
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
  const cameraEncryptionKeyB64 = readSecretFile(env, 'CAMERA_ENCRYPTION_KEY_FILE');

  return {
    host: env.SERVER_HOST ?? '127.0.0.1',
    port,
    databasePath: env.DATABASE_PATH ?? '/data/home-ai-cctv.db',
    maxCameras,
    eventRetentionPerCamera,
    adminBootstrapPassword: readSecretFile(env, 'ADMIN_PASSWORD_FILE'),
    aiApiToken: readSecretFile(env, 'AI_API_TOKEN_FILE'),
    cameraEncryptionKeyB64,
    sessionCookieSecure: env.SESSION_COOKIE_SECURE === 'true',
    mediaApiBaseUrl: env.MEDIA_API_BASE_URL ?? 'http://127.0.0.1:1984',
    audioInternalBaseUrl: env.AUDIO_INTERNAL_BASE_URL ?? `http://127.0.0.1:${port}`,
    logLevel: logLevelRaw as Config['logLevel'],
  };
}

/** Проверяет формат ключа шифрования камер: base64 ровно на 32 байта. */
export function validateCameraEncryptionKey(keyB64: string): void {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32 || key.toString('base64') !== keyB64) {
    throw new Error('CAMERA_ENCRYPTION_KEY_FILE должен содержать base64 ровно от 32 байт');
  }
}
