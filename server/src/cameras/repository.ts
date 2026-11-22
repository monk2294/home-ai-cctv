import { randomUUID } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { cameras } from '../db/schema.js';
import type { CameraCapabilities } from '../onvif/types.js';

export type CameraState = 'disabled' | 'connecting' | 'online' | 'degraded' | 'offline';

export interface CameraRow {
  id: string;
  name: string;
  host: string;
  onvifPort: number;
  enabled: boolean;
  username: string;
  passwordEnc: string;
  rtspOverrideEnc: string | null;
  profileToken: string;
  capabilities: string;
  state: CameraState;
  lastError: string | null;
  lastSeenAt: string | null;
  lastEventAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CameraRowRaw {
  id: string;
  name: string;
  host: string;
  onvifPort: number;
  enabled: number;
  username: string;
  passwordEnc: string;
  rtspOverrideEnc: string | null;
  profileToken: string;
  capabilities: string;
  state: string;
  lastError: string | null;
  lastSeenAt: string | null;
  lastEventAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CameraInsert {
  name: string;
  host: string;
  onvifPort: number;
  enabled: boolean;
  username: string;
  passwordEnc: string;
  rtspOverrideEnc: string | null;
  profileToken: string;
  capabilities: CameraCapabilities;
  state: CameraState;
  lastError?: string | null;
}

export const MAX_CAMERAS = 4;
const EVENT_RETENTION_PER_CAMERA = 1000;

function toRow(raw: CameraRowRaw): CameraRow {
  return { ...raw, enabled: raw.enabled === 1, state: raw.state as CameraState };
}

/** Хранилище камер. UUID назначает сервер (спецификация 10, раздел 4.2). */
export class CameraRepository {
  constructor(private readonly db: Db) {}

  list(): CameraRow[] {
    return (this.db.select().from(cameras).all() as CameraRowRaw[]).map(toRow);
  }

  get(id: string): CameraRow | null {
    const rows = this.db.select().from(cameras).where(eq(cameras.id, id)).all() as CameraRowRaw[];
    return rows[0] ? toRow(rows[0]) : null;
  }

  count(): number {
    const rows = this.db.select({ n: sql<number>`count(*)` }).from(cameras).all();
    return rows[0]?.n ?? 0;
  }

  /**
   * Имя занято другой камерой (без учёта регистра).
   * SQLite COLLATE NOCASE не покрывает кириллицу, поэтому сравнение в коде.
   */
  isNameTaken(name: string, excludeId?: string): boolean {
    const target = name.trim().toLowerCase();
    return this.list().some((row) => row.id !== excludeId && row.name.toLowerCase() === target);
  }

  create(data: CameraInsert): CameraRow {
    const now = new Date().toISOString();
    const row: typeof cameras.$inferInsert = {
      id: randomUUID(),
      name: data.name,
      host: data.host,
      onvifPort: data.onvifPort,
      enabled: data.enabled ? 1 : 0,
      username: data.username,
      passwordEnc: data.passwordEnc,
      rtspOverrideEnc: data.rtspOverrideEnc,
      profileToken: data.profileToken,
      capabilities: JSON.stringify(data.capabilities),
      state: data.state,
      lastError: data.lastError ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(cameras).values(row).run();
    return this.get(row.id as string) as CameraRow;
  }

  update(
    id: string,
    patch: Partial<Omit<CameraInsert, 'capabilities' | 'lastError'>> & {
      capabilities?: CameraCapabilities;
      lastError?: string | null;
      lastSeenAt?: string | null;
    },
  ): CameraRow | null {
    if (!this.get(id)) {
      return null;
    }
    const values: Partial<typeof cameras.$inferInsert> = {
      updatedAt: new Date().toISOString(),
    };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.host !== undefined) values.host = patch.host;
    if (patch.onvifPort !== undefined) values.onvifPort = patch.onvifPort;
    if (patch.enabled !== undefined) values.enabled = patch.enabled ? 1 : 0;
    if (patch.username !== undefined) values.username = patch.username;
    if (patch.passwordEnc !== undefined) values.passwordEnc = patch.passwordEnc;
    if (patch.rtspOverrideEnc !== undefined) values.rtspOverrideEnc = patch.rtspOverrideEnc;
    if (patch.profileToken !== undefined) values.profileToken = patch.profileToken;
    if (patch.capabilities !== undefined) values.capabilities = JSON.stringify(patch.capabilities);
    if (patch.state !== undefined) values.state = patch.state;
    if (patch.lastSeenAt !== undefined) values.lastSeenAt = patch.lastSeenAt;
    if (patch.lastError !== undefined) values.lastError = patch.lastError;
    this.db.update(cameras).set(values).where(eq(cameras.id, id)).run();
    return this.get(id);
  }

  delete(id: string): boolean {
    const result = this.db.delete(cameras).where(eq(cameras.id, id)).run();
    return result.changes > 0;
  }

  /** Камеры для Reconciliation: все включённые. */
  listEnabled(): CameraRow[] {
    return this.list().filter((c) => c.enabled);
  }

  recentEvents(id: string, limit: number): unknown[] {
    return this.db
      .select()
      .from(sql`camera_events`)
      .where(sql`camera_id = ${id}`)
      .orderBy(desc(sql`id`))
      .limit(limit)
      .all();
  }

  static eventRetention(): number {
    return EVENT_RETENTION_PER_CAMERA;
  }
}

/** Имя потока go2rtc камеры (спецификация 11, раздел 3). */
export function streamNameFor(cameraId: string): string {
  return `cam_${cameraId.replaceAll('-', '')}`;
}

/** Имя временного probe-потока. */
export function probeStreamName(): string {
  return `probe_${randomUUID().replaceAll('-', '')}`;
}
