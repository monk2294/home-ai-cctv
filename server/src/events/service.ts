import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { cameraEvents } from '../db/schema.js';
import type { RawCameraEvent } from '../onvif/types.js';
import { normalizeMotion } from '../onvif/adapter.js';

export interface CameraEvent {
  id: string;
  camera_id: string;
  type: 'motion';
  state: 'active' | 'inactive';
  occurred_at: string;
  received_at: string;
  source: 'onvif';
  topic: string;
}

const RETENTION = 1000;

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
  constructor(private readonly db: Db) {}

  handleRawEvent(cameraId: string, raw: RawCameraEvent): StoredEvent {
    const motion = normalizeMotion(raw);
    if (!motion) {
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
    const hash = dedupHash(cameraId, raw.topic, motion.state, occurredAt, raw.messageId);
    return this.insert(cameraId, motion.state, occurredAt, receivedAt, raw.topic, hash);
  }

  /** Вставка и удаление сверх лимита — одна транзакция. Повторный hash не создаёт записи. */
  insert(cameraId: string, state: 'active' | 'inactive', occurredAt: string, receivedAt: string, topic: string, hash: string): StoredEvent {
    return this.db.transaction((tx) => {
      const result = tx
        .insert(cameraEvents)
        .values({
          cameraId,
          type: 'motion',
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
      // Retention: не более RETENTION событий на камеру.
      tx.run(sql`
        DELETE FROM camera_events
        WHERE camera_id = ${cameraId}
          AND id NOT IN (
            SELECT id FROM camera_events
            WHERE camera_id = ${cameraId}
            ORDER BY id DESC
            LIMIT ${RETENTION}
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
          type: 'motion',
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
      type: r.type as 'motion',
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
      type: r.type as 'motion',
      state: r.state as 'active' | 'inactive',
      occurred_at: r.occurredAt,
      received_at: r.receivedAt,
      source: r.source as 'onvif',
      topic: r.topic,
    }));
  }
}
