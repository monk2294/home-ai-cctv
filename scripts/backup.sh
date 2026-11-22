#!/usr/bin/env bash
# Backup платформы (спецификация 40 §7).
# SQLite копируется через backup API внутри server-контейнера (WAL-согласованность).
# Копия включает ключ шифрования камер и config-файлы; храните её отдельно от production secrets.
set -euo pipefail
cd "$(dirname "$0")/.."

TS=$(date +%Y%m%d-%H%M%S)
DIR="backups/$TS"
mkdir -p "$DIR"
chmod 700 backups "$DIR"

echo "1/4 SQLite backup API..."
docker compose exec -T server node "scripts/backup.mjs" "/data/backup-$TS.db"
docker compose cp "server:/data/backup-$TS.db" "$DIR/home-ai-cctv.db"
docker compose exec -T server rm -f "/data/backup-$TS.db"

echo "2/4 Ключ шифрования и config-файлы..."
cp secrets/camera_encryption_key "$DIR/camera_encryption_key"
cp config/Caddyfile "$DIR/Caddyfile"
# go2rtc.yaml содержит RTSP-учётные данные камер — права 0600.
cp config/go2rtc.yaml "$DIR/go2rtc.yaml"
chmod 600 "$DIR"/*

echo "3/4 Версии образов и lock-файл..."
cp package-lock.json "$DIR/package-lock.json"
docker compose images > "$DIR/images.txt"

echo "4/4 Готово: $DIR"
echo "Восстановление: ./scripts/restore.sh $DIR"