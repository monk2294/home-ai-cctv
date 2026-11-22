# home-ai-cctv

Назначение: локальная платформа для IP-камер с удалённым просмотром, PTZ, событиями движения и API для ИИ-агента.

## Что где лежит

| Путь | Содержимое | Когда изменять |
|---|---|---|
| `specs/00-system.md` | Границы MVP, архитектура, требования и решения | При изменении поведения системы или состава MVP |
| `specs/10-server.md` | API, ONVIF, PTZ, события, авторизация и хранение | При изменении серверной логики |
| `specs/11-media-gateway.md` | go2rtc, WebRTC, HLS, JPEG, MJPEG и кодеки | При изменении медиатракта |
| `specs/20-web-client.md` | Экраны и поведение веб-клиента | При изменении UI или пользовательских сценариев |
| `specs/30-reverse-proxy.md` | Маршруты, авторизация и OpenTunnel | При изменении сетевого доступа |
| `specs/40-deployment.md` | Docker Compose, секреты, backup и обновления | При изменении запуска или конфигурации |
| `specs/90-test-strategy.md` | Проверки и критерии готовности | При изменении критериев приёмки |
| `specs/contracts/api-v1.openapi.yaml` | Машиночитаемый контракт API v1 | При изменении публичного API |
| `compatibility.md` | Матрица совместимости проверенных камер | После проверки камеры на реальном устройстве |
| `verification.md` | Матрица проверок T-01–T-17 с фактами и отложенными работами | После прогонов `scripts/verify-stack.sh` и браузерных проверок |

## Порядок чтения

1. Прочитай `specs/00-system.md`.
2. Прочитай спецификацию изменяемого компонента.
3. Проверь `specs/contracts/api-v1.openapi.yaml` при изменении API.
4. Найди проверки в `specs/90-test-strategy.md`.
5. Обнови все документы, которые затрагивает изменение.

## Правила

- `00-system.md` содержит идентификаторы требований. Компонентные документы ссылаются на них.
- OpenAPI определяет поля и коды ответов. Текстовые документы объясняют поведение.
- Не дублируй полные схемы API в нескольких документах.
- Не добавляй реализацию, которая нарушает границы MVP, без изменения системной спецификации.
- Считай камеру совместимой только после проверки на реальном устройстве или записи такой проверки в матрице совместимости.
- Не сохраняй пароли камер, токены и полные RTSP-URL в документации и примерах логов.

## Команды

Локальная разработка (Node.js 22.16.0, см. `.nvmrc`):

```bash
npm install                 # зависимости всех workspace
npm run dev                 # сервер с hot-reload
npm test                    # unit-тесты сервера
npm run typecheck           # проверка типов server + web
npm run build               # сборка server + web
npm run generate:api        # TS-типы из docs/specs/contracts/api-v1.openapi.yaml
npm run db:generate --workspace server   # сгенерировать SQL-миграцию Drizzle
```

Запуск платформы (Docker Compose):

```bash
./scripts/init-secrets.sh   # создать secrets/ (права 0600)
docker compose build
docker compose up -d
docker compose ps           # healthcheck-и всех сервисов
E2E_FIREFOX=$HOME/opt/firefox/firefox node scripts/e2e-firefox.mjs   # E2E Firefox против поднятого стенда
./scripts/verify-tunnel.sh https://<route>.<id>.opentunnel.xyz   # T-15 через OpenTunnel
node scripts/load-test.mjs 60   # T-17: нагрузочный прогон 60 минут
```

Порты на host: `8080/tcp` (Caddy), `8555/tcp+udp` (WebRTC media go2rtc).
Быстрый старт и backup — в корневом [README.md](../README.md).
