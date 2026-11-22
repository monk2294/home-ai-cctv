import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Единственный администратор платформы. */
export const adminUsers = sqliteTable('admin_users', {
  username: text('username').primaryKey(),
  passwordHash: text('password_hash').notNull(),
  createdAt: text('created_at').notNull(),
});

/** Активные сессии администратора. Хранится SHA-256 от opaque token. */
export const adminSessions = sqliteTable('admin_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  createdAt: text('created_at').notNull(),
  /** Текущий срок действия. Активность продлевает срок не более чем до absoluteExpiresAt. */
  expiresAt: text('expires_at').notNull(),
  /** Вход + 24 часа. Потолок sliding expiration. */
  absoluteExpiresAt: text('absolute_expires_at').notNull(),
});

export const cameras = sqliteTable(
  'cameras',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    host: text('host').notNull(),
    onvifPort: integer('onvif_port').notNull(),
    enabled: integer('enabled').notNull().default(1),
    username: text('username').notNull().default(''),
    /** version(1) || nonce(12) || tag(16) || ciphertext. */
    passwordEnc: text('password_enc').notNull(),
    rtspOverrideEnc: text('rtsp_override_enc'),
    profileToken: text('profile_token').notNull().default(''),
    /** JSON-serialized CameraCapabilities. */
    capabilities: text('capabilities').notNull().default('{}'),
    state: text('state').notNull().default('disabled'),
    /** JSON-serialized CameraError или NULL. */
    lastError: text('last_error'),
    lastSeenAt: text('last_seen_at'),
    lastEventAt: text('last_event_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    // Уникальность имени без учёта регистра (FR-01, спецификация 10, раздел 5.2).
    uniqueIndex('cameras_name_unique').on(table.name),
  ],
);

/** SQLite не поддерживает COLLATE NOCASE внутри uniqueIndex через Drizzle;
 * регистронезависимость имени проверяет запрос с COLLATE NOCASE в репозитории. */

export const cameraEvents = sqliteTable(
  'camera_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    cameraId: text('camera_id')
      .notNull()
      .references(() => cameras.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    state: text('state').notNull(),
    occurredAt: text('occurred_at').notNull(),
    receivedAt: text('received_at').notNull(),
    source: text('source').notNull(),
    topic: text('topic').notNull(),
    dedupHash: text('dedup_hash').notNull(),
  },
  (table) => [
    uniqueIndex('camera_events_dedup_hash_unique').on(table.dedupHash),
    uniqueIndex('camera_events_camera_id_id_idx').on(table.cameraId, table.id),
  ],
);

/** Очередь удаления потоков go2rtc, когда медиашлюз был недоступен. */
export const mediaCleanup = sqliteTable('media_cleanup', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  streamName: text('stream_name').notNull(),
  createdAt: text('created_at').notNull(),
});
