// SQLite backup через backup API (WAL-согласованная копия), спецификация 40 §7.
// Запуск внутри server-контейнера: node scripts/backup.mjs <destination.db>
// Активные admin sessions исключаются из копии.
import Database from 'better-sqlite3';

const dest = process.argv[2];
if (!dest) {
  console.error('usage: node scripts/backup.mjs <destination.db>');
  process.exit(1);
}
const source = process.env.DATABASE_PATH ?? '/data/home-ai-cctv.db';

const db = new Database(source, { readonly: true });
try {
  await db.backup(dest);
} finally {
  db.close();
}

const copy = new Database(dest);
try {
  const removed = copy.prepare('DELETE FROM admin_sessions').run();
  const cameras = copy.prepare('SELECT COUNT(*) AS n FROM cameras').get();
  console.log(JSON.stringify({ ok: true, sessions_removed: removed.changes, cameras: cameras.n }));
} finally {
  copy.close();
}