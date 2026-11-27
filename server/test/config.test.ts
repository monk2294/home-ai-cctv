import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { loadConfig } from '../src/config.js';

const tempDirs: string[] = [];

function testEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'home-ai-cctv-config-'));
  tempDirs.push(dir);
  const files = ['ADMIN_PASSWORD_FILE', 'AI_API_TOKEN_FILE', 'CAMERA_ENCRYPTION_KEY_FILE'];
  const env: NodeJS.ProcessEnv = {};
  for (const name of files) {
    const path = join(dir, name.toLowerCase());
    writeFileSync(path, 'test', { mode: 0o600 });
    env[name] = path;
  }
  return { ...env, ...overrides };
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('loadConfig limits', () => {
  test('сохраняет defaults текущего профиля', () => {
    const config = loadConfig(testEnv());
    assert.equal(config.maxCameras, 4);
    assert.equal(config.eventRetentionPerCamera, 1000);
    assert.equal(config.httpRateLimitPerMinute, 1200);
  });

  test('читает MAX_CAMERAS и EVENT_RETENTION_PER_CAMERA', () => {
    const config = loadConfig(testEnv({ MAX_CAMERAS: '8', EVENT_RETENTION_PER_CAMERA: '250', HTTP_RATE_LIMIT_PER_MINUTE: '600' }));
    assert.equal(config.maxCameras, 8);
    assert.equal(config.eventRetentionPerCamera, 250);
    assert.equal(config.httpRateLimitPerMinute, 600);
  });

  test('отклоняет нулевые, отрицательные и дробные limits', () => {
    for (const [name, value] of [
      ['MAX_CAMERAS', '0'],
      ['MAX_CAMERAS', '1.5'],
      ['EVENT_RETENTION_PER_CAMERA', '-1'],
      ['EVENT_RETENTION_PER_CAMERA', 'many'],
      ['HTTP_RATE_LIMIT_PER_MINUTE', '0'],
    ] as const) {
      assert.throws(() => loadConfig(testEnv({ [name]: value })), new RegExp(name));
    }
  });

  test('MQTT выключен без MQTT_URL и включается с адресом broker', () => {
    assert.equal(loadConfig(testEnv()).mqtt, null);
    const config = loadConfig(testEnv({ MQTT_URL: 'mqtt://mqtt.example:1883' }));
    assert.equal(config.mqtt?.url, 'mqtt://mqtt.example:1883');
    assert.equal(config.mqtt?.username, undefined);
    assert.equal(config.mqtt?.password, undefined);
  });

  test('MQTT принимает username и password из отдельного файла', () => {
    const dir = mkdtempSync(join(tmpdir(), 'home-ai-cctv-mqtt-'));
    tempDirs.push(dir);
    const passwordFile = join(dir, 'mqtt_password');
    writeFileSync(passwordFile, 'mqtt-secret', { mode: 0o600 });
    const config = loadConfig(testEnv({
      MQTT_URL: 'mqtt://mqtt.example:1883',
      MQTT_USERNAME: 'cctv',
      MQTT_PASSWORD_FILE: passwordFile,
    }));
    assert.equal(config.mqtt?.username, 'cctv');
    assert.equal(config.mqtt?.password, 'mqtt-secret');
  });

  test('MQTT отклоняет неполные настройки и URL с userinfo', () => {
    for (const overrides of [
      { MQTT_USERNAME: 'cctv' },
      { MQTT_PASSWORD_FILE: '/tmp/no-file' },
      { MQTT_URL: 'http://mqtt.example:1883' },
      { MQTT_URL: 'mqtt://user:pass@mqtt.example:1883' },
      { MQTT_URL: 'mqtt://user@mqtt.example:1883' },
    ] as const) {
      assert.throws(() => loadConfig(testEnv(overrides)), /MQTT/);
    }
  });

  test('ошибка MQTT не раскрывает пароль из URL', () => {
    let caught = '';
    try {
      loadConfig(testEnv({ MQTT_URL: 'mqtt://user:supersecret@not a url' }));
    } catch (error) {
      caught = error instanceof Error ? error.message : String(error);
    }
    assert.match(caught, /MQTT_URL/);
    assert.ok(!caught.includes('supersecret'), 'пароль не должен попадать в ошибку');
  });
});
