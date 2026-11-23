import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PtzService, PTZ_DEFAULT_DURATION_MS } from '../src/ptz/service.js';
function fakeSession(calls: string[]) {
  return {
    ptzContinuousMove: async (...args: unknown[]) => {
      calls.push(`move:${JSON.stringify(args)}`);
    },
    ptzStop: async () => {
      calls.push('stop');
    },
  };
}

describe('PTZ validation', () => {
  test('принимает валидную команду', () => {
    assert.equal(PtzService.validate({ pan: 0.5, tilt: 0, zoom: 0, durationMs: PTZ_DEFAULT_DURATION_MS }), null);
    assert.equal(PtzService.validate({ pan: 0, tilt: -1, zoom: 0.2, durationMs: 100 }), null);
  });

  test('отклоняет все нулевые скорости', () => {
    assert.match(PtzService.validate({ pan: 0, tilt: 0, zoom: 0, durationMs: 1000 }) ?? '', /отличаться от нуля/);
  });

  test('отклоняет скорости вне [-1, 1] и не-числа', () => {
    assert.ok(PtzService.validate({ pan: 1.5, tilt: 0, zoom: 0, durationMs: 1000 }));
    assert.ok(PtzService.validate({ pan: Number.NaN, tilt: 0, zoom: 0, durationMs: 1000 }));
    assert.ok(PtzService.validate({ pan: 0, tilt: 0, zoom: -2, durationMs: 1000 }));
  });

  test('отклоняет duration вне 100–5000 и нецелый', () => {
    assert.ok(PtzService.validate({ pan: 1, tilt: 0, zoom: 0, durationMs: 99 }));
    assert.ok(PtzService.validate({ pan: 1, tilt: 0, zoom: 0, durationMs: 5001 }));
    assert.ok(PtzService.validate({ pan: 1, tilt: 0, zoom: 0, durationMs: 1500.5 }));
  });
});

describe('PTZ timers и generation token', () => {
  test('автоматический Stop после срока', async () => {
    const calls: string[] = [];
    const ptz = new PtzService();
    const result = await ptz.move('cam1', { pan: 1, tilt: 0, zoom: 0, durationMs: 100 }, () => fakeSession(calls));
    assert.equal(result, 'ok');
    assert.equal(calls.length, 1);
    assert.match(calls[0] ?? '', /^move:/);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(calls, [calls[0], 'stop']);
  });

  test('таймер старой команды не останавливает новую (T-05 тест 3)', async () => {
    const calls: string[] = [];
    const ptz = new PtzService();
    await ptz.move('cam1', { pan: 1, tilt: 0, zoom: 0, durationMs: 120 }, () => fakeSession(calls));
    await ptz.move('cam1', { pan: -1, tilt: 0, zoom: 0, durationMs: 300 }, () => fakeSession(calls));
    await new Promise((r) => setTimeout(r, 180));
    // Таймер первой команды сработал, но Stop не отправлен из-за generation.
    assert.deepEqual(calls.filter((c) => c === 'stop'), []);
    await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(calls.filter((c) => c === 'stop'), ['stop']);
  });

  test('ручной Stop отменяет таймер и шлёт Stop сразу', async () => {
    const calls: string[] = [];
    const ptz = new PtzService();
    await ptz.move('cam1', { pan: 1, tilt: 0, zoom: 0, durationMs: 5000 }, () => fakeSession(calls));
    const result = await ptz.stop('cam1', () => fakeSession(calls));
    assert.equal(result, 'ok');
    assert.deepEqual(calls, [calls[0] ?? '', 'stop'].filter((c) => c !== ''));
    assert.equal(calls.filter((c) => c === 'stop').length, 1);
  });

  test('unavailable при отсутствии сессии', async () => {
    const ptz = new PtzService();
    assert.equal(await ptz.move('cam1', { pan: 1, tilt: 0, zoom: 0, durationMs: 100 }, () => null), 'unavailable');
    assert.equal(await ptz.stop('cam1', () => null), 'unavailable');
  });

  test('shutdown останавливает активные камеры best effort', async () => {
    const calls: string[] = [];
    const ptz = new PtzService();
    await ptz.move('cam1', { pan: 1, tilt: 0, zoom: 0, durationMs: 5000 }, () => fakeSession(calls));
    await ptz.move('cam2', { pan: 0, tilt: 1, zoom: 0, durationMs: 5000 }, () => fakeSession(calls));
    await ptz.shutdown(() => fakeSession(calls));
    assert.equal(calls.filter((c) => c === 'stop').length, 2);
  });
});
