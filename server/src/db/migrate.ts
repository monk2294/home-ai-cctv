import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Db } from './client.js';

/**
 * Применяет версионированные миграции Drizzle.
 * Каталог drizzle/ копируется в Docker-образ рядом с dist/.
 */
export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname });
}
