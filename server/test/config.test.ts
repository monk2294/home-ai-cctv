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
  });

  test('читает MAX_CAMERAS и EVENT_RETENTION_PER_CAMERA', () => {
    const config = loadConfig(testEnv({ MAX_CAMERAS: '8', EVENT_RETENTION_PER_CAMERA: '250' }));
    assert.equal(config.maxCameras, 8);
    assert.equal(config.eventRetentionPerCamera, 250);
  });

  test('отклоняет нулевые, отрицательные и дробные limits', () => {
    for (const [name, value] of [
      ['MAX_CAMERAS', '0'],
      ['MAX_CAMERAS', '1.5'],
      ['EVENT_RETENTION_PER_CAMERA', '-1'],
      ['EVENT_RETENTION_PER_CAMERA', 'many'],
    ] as const) {
      assert.throws(() => loadConfig(testEnv({ [name]: value })), new RegExp(name));
    }
  });
});
