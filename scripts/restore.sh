#!/usr/bin/env bash
# Restore платформы (спецификация 40 §8).
# ВНИМАНИЕ: текущая БД сервера заменяется копией из backup. Активные сессии завершаются.
set -euo pipefail
cd "$(dirname "$0")/.."

DIR="${1:-}"
if [[ -z "$DIR" || ! -f "$DIR/home-ai-cctv.db" || ! -f "$DIR/camera_encryption_key" ]]; then
  echo "usage: ./scripts/restore.sh <backup-dir>" >&2
  echo "Каталог должен содержать home-ai-cctv.db и camera_encryption_key." >&2
  exit 1
fi

echo "ВНИМАНИЕ: БД сервера будет заменена копией из $DIR."
read -r -p "Продолжить? [y/N] " answer
[[ "$answer" == "y" || "$answer" == "Y" ]] || exit 1

echo "1/6 Остановка server..."
docker compose stop server

echo "2/6 Восстановление SQLite..."
docker compose cp "$DIR/home-ai-cctv.db" server:/data/home-ai-cctv.db
# Backup API создаёт автономный файл без WAL; старые WAL/SHM удаляются.
docker compose run --rm --no-deps --entrypoint sh server -c \
  'rm -f /data/home-ai-cctv.db-wal /data/home-ai-cctv.db-shm'

echo "3/6 Восстановление ключа шифрования..."
cp "$DIR/camera_encryption_key" secrets/camera_encryption_key
chmod 600 secrets/camera_encryption_key

echo "4/6 Запуск server (миграции только вперёд)..."
docker compose up -d server

echo "5/6 Ожидание readiness..."
for _ in $(seq 1 30); do
  if docker compose exec -T server node -e "fetch('http://127.0.0.1:8000/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
docker compose exec -T server node -e "fetch('http://127.0.0.1:8000/api/v1/health/ready').then(r=>r.text()).then(t=>console.log(t))"

echo "6/6 Готово. Проверьте список камер, снимок и Reconciliation в веб-клиенте."