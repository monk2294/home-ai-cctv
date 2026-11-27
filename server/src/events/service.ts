import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import { DEFAULT_EVENT_RETENTION_PER_CAMERA } from '../config.js';
import type { Db } from '../db/client.js';
import { cameraEvents } from '../db/schema.js';
import type { RawCameraEvent } from '../cameras/adapter.js';
import { normalizeEvent, type CameraEventType } from './normalize.js';

export interface CameraEvent {
  id: string;
  camera_id: string;
  type: CameraEventType;
  state: 'active' | 'inactive';
  occurred_at: string;
  received_at: string;
  source: 'onvif';
  topic: string;
}

/** Период keepalive-события при неизменном состоянии (см. isRepeatedState). */
const STATE_KEEPALIVE_MS = 30_000;

/** SHA-256 от канонической комбинации для дедупликации повторной доставки PullMessages. */
export function dedupHash(cameraId: string, topic: string, state: string, occurredAt: string, messageId: string | null): string {
  return createHash('sha256')
    .update(JSON.stringify([cameraId, topic, state, occurredAt, messageId]))
    .digest('hex');
}

export interface StoredEvent {
  inserted: boolean;
  event: CameraEvent | null;
}

/** Нормализация, дедупликация, хранение и retention событий (спецификация 10, раздел 6.3). */
export class EventService {
  constructor(
    private readonly db: Db,
    private readonly retention = DEFAULT_EVENT_RETENTION_PER_CAMERA,
  ) {}

  handleRawEvent(cameraId: string, raw: RawCameraEvent): StoredEvent {
    const event = normalizeEvent(raw);
    if (!event) {
      return { inserted: false, event: null };
    }
    const receivedAt = new Date().toISOString();
    let occurredAt = receivedAt;
    if (raw.utcTime) {
      const parsed = Date.parse(raw.utcTime);
      if (!Number.isNaN(parsed)) {
        occurredAt = new Date(parsed).toISOString();
      }
    }
    if (this.isRepeatedState(cameraId, event.type, event.state, receivedAt)) {
      return { inserted: false, event: null };
    }
    const hash = dedupHash(cameraId, raw.topic, event.state, occurredAt, raw.messageId);
    return this.insert(cameraId, event.type, event.state, occurredAt, receivedAt, raw.topic, hash);
  }

  /**
   * троттл одинакового состояния: Tapo C520WS шлёт активное состояние пакетами
   * десятками событий в секунду (замер — 22/с). Переходы состояния пишутся сразу,
   * повтор того же состояния — не чаще одного keepalive-события в STATE_KEEPALIVE_MS.
   */
  private isRepeatedState(cameraId: string, type: CameraEventType, state: 'active' | 'inactive', receivedAt: string): boolean {
    const row = this.db
      .select({ state: cameraEvents.state, receivedAt: cameraEvents.receivedAt })
      .from(cameraEvents)
      .where(and(eq(cameraEvents.cameraId, cameraId), eq(cameraEvents.type, type)))
      .orderBy(desc(cameraEvents.id))
      .limit(1)
      .get();
    if (!row || row.state !== state) {
      return false;
    }
    const lastAt = Date.parse(row.receivedAt);
    const now = Date.parse(receivedAt);
    if (Number.isNaN(lastAt) || Number.isNaN(now)) {
      return false;
    }
    return now - lastAt < STATE_KEEPALIVE_MS;
  }

  /** Вставка и удаление сверх лимита — одна транзакция. Повторный hash не создаёт записи. */
  insert(cameraId: string, type: CameraEventType, state: 'active' | 'inactive', occurredAt: string, receivedAt: string, topic: string, hash: string): StoredEvent {
    return this.db.transaction((tx) => {
      const result = tx
        .insert(cameraEvents)
        .values({
          cameraId,
          type,
          state,
          occurredAt,
          receivedAt,
          source: 'onvif',
          topic,
          dedupHash: hash,
        })
        .onConflictDoNothing()
        .run();
      if (result.changes === 0) {
        return { inserted: false, event: null };
      }
      const row = tx
        .select()
        .from(cameraEvents)
        .where(eq(cameraEvents.dedupHash, hash))
        .all()[0] as { id: number } | undefined;
      // Retention: не более заданного числа событий на камеру.
      tx.run(sql`
        DELETE FROM camera_events
        WHERE camera_id = ${cameraId}
          AND id NOT IN (
            SELECT id FROM camera_events
            WHERE camera_id = ${cameraId}
            ORDER BY id DESC
            LIMIT ${this.retention}
          )
      `);
      if (!row) {
        return { inserted: false, event: null };
      }
      return {
        inserted: true,
        event: {
          id: String(row.id),
          camera_id: cameraId,
          type,
          state,
          occurred_at: occurredAt,
          received_at: receivedAt,
          source: 'onvif',
          topic,
        },
      };
    });
  }

  list(cameraId: string, limit: number): CameraEvent[] {
    const rows = this.db
      .select()
      .from(cameraEvents)
      .where(eq(cameraEvents.cameraId, cameraId))
      .orderBy(desc(cameraEvents.id))
      .limit(limit)
      .all();
    return rows.map((r) => ({
      id: String(r.id),
      camera_id: r.cameraId,
      type: r.type as CameraEventType,
      state: r.state as 'active' | 'inactive',
      occurred_at: r.occurredAt,
      received_at: r.receivedAt,
      source: r.source as 'onvif',
      topic: r.topic,
    }));
  }

  /** Новые события после ID (для reconnect SSE-клиентов через REST, раздел 6.4). */
  listAfter(cameraId: string, afterId: number, limit: number): CameraEvent[] {
    const rows = this.db
      .select()
      .from(cameraEvents)
      .where(and(eq(cameraEvents.cameraId, cameraId), gt(cameraEvents.id, afterId)))
      .orderBy(asc(cameraEvents.id))
      .limit(limit)
      .all();
    return rows.map((r) => ({
      id: String(r.id),
      camera_id: r.cameraId,
      type: r.type as CameraEventType,
      state: r.state as 'active' | 'inactive',
      occurred_at: r.occurredAt,
      received_at: r.receivedAt,
      source: r.source as 'onvif',
      topic: r.topic,
    }));
  }
}
