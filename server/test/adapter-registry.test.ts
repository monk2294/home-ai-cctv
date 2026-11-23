import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AdapterNotApplicableError,
  CameraAdapterDetectionError,
  type CameraAdapter,
  type CameraCapabilities,
  type CameraConnection,
  type ProbeResult,
} from '../src/cameras/adapter.js';
import { CameraAdapterRegistry } from '../src/cameras/adapter-registry.js';

const CONN: CameraConnection = {
  host: '192.0.2.10',
  port: 80,
  username: 'admin',
  password: 'secret',
  timeoutMs: 1000,
};

const CAPS: CameraCapabilities = {
  video: 'supported',
  audio: 'supported',
  audio_output: 'unknown',
  motion_events: 'unknown',
  ptz_continuous: 'supported',
  ptz_presets: 'supported',
};

function result(model: string): ProbeResult {
  return {
    device: { manufacturer: 'Test', model, firmware: '1.0' },
    capabilities: CAPS,
    profiles: [],
    diagnostics: [],
  };
}

function adapter(id: string, probe: CameraAdapter['probe']): CameraAdapter {
  return {
    id,
    displayName: id,
    probe,
    async open() {
      throw new Error('not used');
    },
  };
}

test('реестр выбирает первый подходящий адаптер перебором', async () => {
  const calls: string[] = [];
  const registry = new CameraAdapterRegistry([
    adapter('first', async () => {
      calls.push('first');
      throw new AdapterNotApplicableError('не та модель');
    }),
    adapter('second', async () => {
      calls.push('second');
      return result('Second');
    }),
  ]);

  const selected = await registry.select(CONN);
  assert.equal(selected.adapter.id, 'second');
  assert.deepEqual(calls, ['first', 'second']);
});

test('реестр возвращает человекочитаемую ошибку, если адаптеры не подошли', async () => {
  const registry = new CameraAdapterRegistry([
    adapter('first', async () => {
      throw new AdapterNotApplicableError('не та модель');
    }),
    adapter('second', async () => {
      throw new Error('connect failed at rtsp://user:pass@camera/stream');
    }),
  ]);

  await assert.rejects(
    registry.select(CONN),
    (error: unknown) => {
      assert.ok(error instanceof CameraAdapterDetectionError);
      assert.match(error.message, /Не удалось определить тип камеры/);
      assert.match(error.attempts[1]?.reason ?? '', /\/\/\*\*\*@camera/);
      return true;
    },
  );
});
