// Recovery пароля администратора (спецификация 40 §12).
// Запуск: docker compose exec server node scripts/reset-admin-password.mjs
// Пароль читается с TTY без эха и не попадает в историю shell.
// Все активные сессии завершаются.
import readline from 'node:readline';
import Database from 'better-sqlite3';
import argon2 from 'argon2';

const isTty = Boolean(process.stdin.isTTY);
let password;
let confirm;
if (isTty) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Подавляем эхо символов, оставляя только текст вопроса.
  rl._writeToOutput = (stringToWrite) => {
    if (stringToWrite.includes(': ')) rl.output.write(stringToWrite);
  };
  const ask = (question) => new Promise((resolve) => rl.question(question, resolve));
  password = await ask('Новый пароль администратора (минимум 12 символов): ');
  confirm = await ask('Повторите пароль: ');
  rl.close();
} else {
  // Non-TTY (pipe): строки читаются целиком, readline теряет их между question-вызовами.
  process.stdout.write('Новый пароль администратора (минимум 12 символов): ');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const lines = Buffer.concat(chunks).toString('utf8').split('\n');
  password = lines[0] ?? '';
  confirm = lines[1] ?? '';
  process.stdout.write('Повторите пароль: \n');
}
if (password.length < 12) {
  console.error('Пароль короче 12 символов. Отмена.');
  process.exit(1);
}
if (password !== confirm) {
  console.error('Пароли не совпадают. Отмена.');
  process.exit(1);
}

const hash = await argon2.hash(password, {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
});

const db = new Database(process.env.DATABASE_PATH ?? '/data/home-ai-cctv.db');
try {
  db.prepare('UPDATE admin_users SET password_hash = ? WHERE username = ?').run(hash, 'admin');
  const sessions = db.prepare('DELETE FROM admin_sessions').run();
  console.log(`Пароль обновлён. Завершено сессий: ${sessions.changes}.`);
} finally {
  db.close();
}