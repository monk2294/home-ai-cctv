# home-ai-cctv

Локальная платформа для IP-камер: удалённый просмотр, PTZ, события движения и API для ИИ-агента.
Архитектура, требования и решения — в [docs/](docs/README.md). Требования этапа 2 — в [docs/specs/50-stage-2.md](docs/specs/50-stage-2.md). Самодостаточное задание агенту-исполнителю — в [docs/specs/51-stage-2-executor-task.md](docs/specs/51-stage-2-executor-task.md).

## Состав

| Каталог | Содержимое |
|---|---|
| `server/` | Node.js 22 + Fastify + SQLite (Drizzle). Авторизация, API v1, звук (WAV-захват для ИИ, воспроизведение файлов). |
| `web/` | React + Vite + TypeScript. Веб-клиент администратора: просмотр, PTZ, события, push-to-talk, polling снимков, мобильная раскладка. |
| `config/` | Caddyfile и go2rtc.example.yaml для Docker Compose. |
| `scripts/` | Создание файлов секретов. |
| `docs/` | Спецификации и OpenAPI-контракт. |

## Запуск готового релиза

Требования: Docker с Compose plugin.

1. Скачайте tag релиза:

   ```bash
   git clone --branch v0.2.0 --depth 1 https://github.com/monk2294/home-ai-cctv.git
   cd home-ai-cctv
   ```

2. Создайте секреты и скопируйте конфигурацию:

   ```bash
   ./scripts/init-secrets.sh
   cp .env.example .env
   ```

3. Установите в `.env`:

   ```dotenv
   IMAGE_PREFIX=ghcr.io/monk2294/home-ai-cctv
   IMAGE_TAG=0.2.0
   ```

4. Скачайте и запустите versioned images:

   ```bash
   docker compose pull
   docker compose up -d --no-build
   ```

5. Проверьте healthcheck-и и войдите по инструкции ниже.

## Первичный запуск из исходников (Docker Compose)

Требования: Docker с Compose plugin, Node.js 22.16.0 (для локальной разработки).

1. Создайте файлы секретов и рабочий config медиашлюза:

   ```bash
   ./scripts/init-secrets.sh
   ```

2. При необходимости скопируйте `.env.example` в `.env` и измените `SESSION_COOKIE_SECURE` / `LOG_LEVEL`.

3. Соберите и запустите сервисы:

   ```bash
   docker compose build
   docker compose up -d
   ```

4. Проверьте healthcheck-и:

   ```bash
   docker compose ps
   curl http://127.0.0.1:8080/api/v1/health/live
   ```

5. Войдите как `admin` через веб-интерфейс `http://<server>:8080`. Пароль — содержимое `secrets/admin_password` (минимум 12 символов).

Порты на host: `8080/tcp` (HTTP-вход Caddy), `8555/tcp+udp` (WebRTC media). Порты сервера, веб-клиента и API медиашлюза наружу не публикуются.

WebRTC: go2rtc в Docker отдаёт ICE-кандидатом адрес контейнерной сети. Задайте LAN-адрес хоста в рабочем `config/go2rtc.yaml` (`webrtc.candidates: [<LAN IP>:8555]`), иначе браузер уйдёт в HLS fallback. Рабочий config создаёт `init-secrets.sh` из `config/go2rtc.example.yaml`: go2rtc дописывает в него streams с учётными данными камер, поэтому файл имеет права 0600 и исключён из репозитория.

## Локальная разработка

```bash
npm install                 # установка зависимостей всех workspace
npm run dev                 # сервер с hot-reload (tsx watch)
npm test                    # unit-тесты сервера (node:test)
npm run typecheck           # проверка типов server + web
npm run build               # сборка server + web
npm run generate:api        # генерация TS-типов из OpenAPI-контракта
```

Веб-клиент для разработки: `npm run dev --workspace web` (Vite на `:5173`, прокси `/api` и `/media` на Caddy `:8080`).

Миграции БД: `npm run db:generate --workspace server` (SQL появляется в `server/drizzle/`). Сервер применяет их автоматически перед стартом HTTP.

## Эксплуатационные лимиты

`.env` принимает `MAX_CAMERAS=4` и `EVENT_RETENTION_PER_CAMERA=1000`. Оба параметра требуют положительное целое число. Значения по умолчанию соответствуют проверенному профилю. После увеличения `MAX_CAMERAS` повторите нагрузочный тест `node scripts/load-test.mjs 60`.

SQLite остаётся единственным backend. Текущее решение и границы PostgreSQL описаны в [docs/specs/70-open-source-readiness.md](docs/specs/70-open-source-readiness.md).

## Backup и restore

```bash
./scripts/backup.sh                  # копия в backups/<timestamp>: SQLite через backup API, ключ, config, версии
./scripts/restore.sh backups/<ts>    # восстановление: stop server, замена БД и ключа, запуск, readiness
```

Backup исключает активные admin sessions. Без исходного `camera_encryption_key` пароли камер не восстановить: потеря ключа обнаруживается ошибкой AES-GCM и требует повторного ввода паролей. Подробности — [docs/specs/40-deployment.md](docs/specs/40-deployment.md). Проверено на отдельном тестовом стеке — [docs/verification.md](docs/verification.md), T-16.

## Смена пароля администратора

```bash
docker compose exec server node scripts/reset-admin-password.mjs
```

Команда читает новый пароль с TTY без эха (не попадает в историю shell), обновляет Argon2id hash и завершает все активные сессии.

## Проверки стека

```bash
./scripts/verify-stack.sh            # T-01–T-25 против работающего стека: PASS/FAIL/BLOCKED с фактами
E2E_FIREFOX=$HOME/opt/firefox/firefox node scripts/e2e-firefox.mjs   # интерактивные E2E Firefox (11 шагов)
```

Матрица результатов и отложенные работы — [docs/verification.md](docs/verification.md).

## Удалённый доступ (OpenTunnel)

Продукт: [OpenTunnel](https://github.com/anomalyco/Opentunnel) — blind TLS tunnel, наружу только HTTPS/TCP 443. UDP и произвольные TCP-порты не поддерживает, поэтому удалённый режим просмотра — HLS; WebRTC работает в LAN.

```bash
opentunnel route add 8080 --name cctv   # печатает https://cctv.<id>.opentunnel.xyz
./scripts/verify-tunnel.sh https://cctv.<id>.opentunnel.xyz   # T-15: 10 сетевых проверок
```

Для Secure cookie задайте `SESSION_COOKIE_SECURE=true` в `.env` и перезапустите server; вход выполняйте по HTTPS-URL туннеля. URL туннеля не является аутентификацией: доступ к платформе всё равно требует пароль администратора.

## Участие и безопасность

- Правила разработки и проверки — [CONTRIBUTING.md](CONTRIBUTING.md).
- Приватное сообщение об уязвимости — [SECURITY.md](SECURITY.md).
- Разработка адаптеров камер — [docs/camera-adapters.md](docs/camera-adapters.md).
- Изменения релизов — [CHANGELOG.md](CHANGELOG.md).

## Лицензия

MIT, см. [LICENSE](LICENSE).
