# Участие в разработке

## Перед изменением

1. Проверьте открытые Issues и Pull Requests.
2. Создайте Issue для ошибки, новой камеры или предложения.
3. Согласуйте спецификацию перед крупным изменением API, БД, media или безопасности.
4. Создайте ветку от актуального `main`.

Не отправляйте в Issue или PR пароли, токены, cookies, RTSP userinfo, внешние URL и серийные номера. Об уязвимости сообщайте приватно по [SECURITY.md](SECURITY.md).

## Среда

- Node.js из `.nvmrc`;
- Docker с Compose plugin;
- npm workspaces из корневого `package-lock.json`.

```bash
npm ci
./scripts/init-secrets.sh
docker compose build
docker compose up -d
```

Для серверной разработки используйте `npm run dev`. Для веб-клиента используйте `npm run dev --workspace web`.

## Обязательные проверки

Запустите из корня:

```bash
npm test
npm run typecheck
npm run build
npm run generate:api
git diff --exit-code -- server/src/generated/api-v1.d.ts web/src/generated/api-v1.d.ts
docker compose config --quiet
docker compose build
```

Не ослабляйте тест ради получения PASS. Если проверка требует отсутствующую камеру или браузер, укажите `NOT_RUN` или `BLOCKED` в PR.

## Правила изменений

- Делайте маленький PR с одной целью.
- Используйте Conventional Commits, например `fix(server): handle ONVIF reconnect`.
- Сохраняйте strict TypeScript и точные версии зависимостей.
- Не используйте `latest` для Docker images.
- Обновляйте спецификацию и OpenAPI при изменении поведения.
- Не меняйте публичный API v1 без обсуждения совместимости.
- После `server/src/db/schema.ts` запустите `npm run db:generate --workspace server` и приложите миграцию.
- Проверяйте backup и restore при изменении хранения.
- Не добавляйте новый сервис или зависимость без объяснения задачи.
- Major updates зависимостей начинайте через Issue. Dependabot предлагает minor, patch и security updates; major updates требуют отдельной оценки совместимости.

Архитектура и источники истины перечислены в [docs/README.md](docs/README.md).

## Адаптеры камер

Прочитайте [docs/camera-adapters.md](docs/camera-adapters.md). Бизнес-логика зависит только от `CameraAdapter`. Не импортируйте классы библиотеки `onvif` вне адаптера.

PR с поддержкой камеры содержит:

1. Unit-тесты с очищенными fixtures.
2. Проверку выбора адаптера и обработки ошибок.
3. Обновление `docs/compatibility.md` с фактическими результатами.
4. Отдельное указание непроверенных WebRTC, HLS, PTZ, events и audio.

## Pull Request

1. Заполните шаблон PR.
2. Свяжите PR с Issue.
3. Перечислите выполненные проверки и риски.
4. Дождитесь зелёного CI и review maintainer.
5. Исправляйте review отдельными commits без force push после начала обсуждения.

Maintainer может отклонить изменение вне roadmap или попросить уменьшить объём. Согласование Issue до реализации снижает этот риск.
