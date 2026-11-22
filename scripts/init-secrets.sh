#!/usr/bin/env bash
# Создаёт файлы секретов со случайными значениями и правами 0600.
# Запускать на host перед первым `docker compose up`.
set -euo pipefail

cd "$(dirname "$0")/.."

mkdir -p secrets

if [ ! -f secrets/admin_password ]; then
  openssl rand -base64 24 | tr -d '\n' > secrets/admin_password
fi

if [ ! -f secrets/ai_api_token ]; then
  # 32 случайных байта в base64url (без padding).
  openssl rand -base64 32 | tr '+/' '-_' | tr -d '= \n' > secrets/ai_api_token
fi

if [ ! -f secrets/camera_encryption_key ]; then
  openssl rand -base64 32 | tr -d '\n' > secrets/camera_encryption_key
fi

chmod 600 secrets/admin_password secrets/ai_api_token secrets/camera_encryption_key

# Рабочий config go2rtc: go2rtc дописывает в него streams с учётными данными камер.
# В репозитории лежит только example без streams; рабочий файл — 0600 и в .gitignore.
if [ ! -f config/go2rtc.yaml ]; then
  install -m 600 config/go2rtc.example.yaml config/go2rtc.yaml
fi
chmod 600 config/go2rtc.yaml

echo "Секреты созданы в ./secrets (права 0600). Рабочий config/go2rtc.yaml готов (0600)."
