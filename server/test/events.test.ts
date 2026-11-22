import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createDb, type DbHandle } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { cameras } from '../src/db/schema.js';
import { EventService } from '../src/events/service.js';
import { SseHub } from '../src/events/sse.js';
import type { RawCameraEvent } from '../src/onvif/types.js';

function motionRaw(state: string, utcTime = '2026-11-21T12:00:00.000Z'): RawCameraEvent {
  return {
    topic: 'tns1:RuleEngine/CellMotionDetector/Motion',
    utcTime,
    messageId: null,
    stateName: 'IsMotion',
    stateValue: state,
  };
}

describe('EventService', () => {
  let handle: DbHandle;
  let events: EventService;
  let cameraId: string;

  before(() => {
    handle = createDb(':memory:');
    runMigrations(handle.db);
    events = new EventService(handle.db);
    cameraId = randomUUID();
    handle.db.insert(cameras).values({
      id: cameraId,
      name: 'test-cam',
      host: '192.0.2.10',
      onvifPort: 80,
      enabled: 1,
      username: 'u',
      passwordEnc: 'enc',
      profileToken: 'p1',
      state: 'online',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();
  });

  after(() => {
    handle.close();
  });

  test('сохраняет active/inactive с occurred_at от камеры', () => {
    const stored = events.handleRawEvent(cameraId, motionRaw('true'));
    assert.equal(stored.inserted, true);
    assert.equal(stored.event?.state, 'active');
    assert.equal(stored.event?.occurred_at, '2026-11-21T12:00:00.000Z');
    assert.equal(stored.event?.source, 'onvif');
    assert.match(stored.event?.id ?? '', /^[1-9][0-9]*$/);
  });

  test('неизвестный топик не создаёт событие', () => {
    const stored = events.handleRawEvent(cameraId, {
      topic: 'tns1:RuleEngine/LineDetector/Crossed',
      utcTime: null,
      messageId: null,
      stateName: null,
      stateValue: 'true',
    });
    assert.equal(stored.inserted, false);
  });

  test('повторная доставка PullMessages не создаёт дубликат', () => {
    const first = events.handleRawEvent(cameraId, motionRaw('true', '2026-11-21T12:01:00.000Z'));
    const second = events.handleRawEvent(cameraId, motionRaw('true', '2026-11-21T12:01:00.000Z'));
    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);
    const list = events.list(cameraId, 10).filter((e) => e.occurred_at === '2026-11-21T12:01:00.000Z');
    assert.equal(list.length, 1);
  });

  test('retention оставляет не более 1000 событий на камеру', () => {
    for (let i = 0; i < 1005; i += 1) {
      const stored = events.handleRawEvent(cameraId, motionRaw(i % 2 === 0 ? 'true' : 'false', `2026-11-21T13:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`));
      assert.equal(stored.inserted, true);
    }
    const rows = handle.sqlite.prepare(`SELECT count(*) AS n FROM camera_events WHERE camera_id = ?`).all(cameraId) as { n: number }[];
    assert.ok((rows[0]?.n ?? 0) <= 1000, `ожидалось <= 1000, получено ${rows[0]?.n}`);
  });

  test('list возвращает события в порядке убывания ID', () => {
    const items = events.list(cameraId, 5);
    assert.equal(items.length, 5);
    for (let i = 1; i < items.length; i += 1) {
      assert.ok(BigInt(items[i - 1]!.id) > BigInt(items[i]!.id));
    }
  });
});

describe('SseHub', () => {
  test('broadcast фильтрует по camera_id и пишет SSE-формат', () => {
    const hub = new SseHub();
    const written: string[] = [];
    const fakeRes = {
      write: (chunk: string) => {
        written.push(chunk);
        return true;
      },
      end: () => undefined,
    } as never;
    hub.add(fakeRes, 'cam-a');
    hub.broadcast({
      id: '42',
      camera_id: 'cam-b',
      type: 'motion',
      state: 'active',
      occurred_at: '2026-11-21T12:00:00.000Z',
      received_at: '2026-11-21T12:00:01Z',
      source: 'onvif',
      topic: 'tns1:RuleEngine/CellMotionDetector/Motion',
    });
    assert.equal(written.length, 0);
    hub.broadcast({
      id: '43',
      camera_id: 'cam-a',
      type: 'motion',
      state: 'inactive',
      occurred_at: '2026-11-21T12:00:10Z',
      received_at: '2026-11-21T12:00:11Z',
      source: 'onvif',
      topic: 'tns1:RuleEngine/CellMotionDetector/Motion',
    });
    assert.equal(written.length, 1);
    assert.match(written[0] ?? '', /^id: 43\nevent: camera-event\ndata: \{.*"state":"inactive"/s);
    hub.closeAll();
    assert.equal(hub.clientCount(), 0);
  });
});
