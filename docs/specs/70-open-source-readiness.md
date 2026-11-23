# 70. Подготовка к открытой разработке

- Дата: 2026-11-23.
- Ветка: `feature/open-source-readiness`.
- Репозиторий: https://github.com/monk2294/home-ai-cctv.

## Цель

Дать внешним участникам безопасный способ установить платформу, предложить изменение и проверить его. Сохранить простой локальный запуск и текущий профиль нагрузки.

## Критерии приёмки

| # | Критерий | Проверка |
|---|---|---|
| 1 | Каждый PR запускает unit-тесты, typecheck, build, проверку OpenAPI и сборку Docker images | GitHub Actions `CI`, локально те же команды |
| 2 | Actions не получают секреты камер и не используют self-hosted runners | Review workflow; `runs-on: ubuntu-24.04` |
| 3 | GitHub проверяет зависимости, код и секреты | Dependabot, CodeQL, Gitleaks |
| 4 | Участник видит правила разработки, приватный канал для уязвимостей и шаблоны issues/PR | `CONTRIBUTING.md`, `SECURITY.md`, `.github/` |
| 5 | Разработчик камеры получает контракт адаптера и правила fixtures | `docs/camera-adapters.md`, `docs/compatibility.md` |
| 6 | Release tag публикует три versioned images в GHCR и GitHub Release | Workflow `Release`, проверка после tag push |
| 7 | Пользователь может запустить опубликованные images без локальной сборки | `IMAGE_PREFIX`, `IMAGE_TAG`, `docker compose up --no-build` |
| 8 | Лимит камер и retention можно задать через environment без изменения кода | Unit-тесты конфигурации, repositories и services |
| 9 | SQLite остаётся backend по умолчанию; PostgreSQL не добавляется без подтверждённого сценария | Решение D-03 в этом документе |
| 10 | `main` требует PR и зелёные проверки | Проверка GitHub Rules после появления CI checks |

## Границы

Входит:

- CI, security automation и зависимости;
- правила участия и приватные security reports;
- versioned Docker releases в GHCR;
- документация для камер и contributors;
- конфигурация лимита камер и event retention;
- защита `main` и базовые настройки репозитория.

Не входит:

- PostgreSQL, MySQL и универсальный DB plugin API;
- динамическая загрузка адаптеров камер;
- RBAC, кластер, Kubernetes и запись видео;
- ARM images без целевого ARM-стенда;
- запуск чужого кода на self-hosted runner;
- изменение публичного API v1.

## Решения

| ID | Вопрос | Решение | Причина |
|---|---|---|---|
| D-01 | Где выполнять проверки PR | GitHub-hosted `ubuntu-24.04`, без secrets | Не открывать LAN и камеры чужому коду |
| D-02 | Как публиковать релизы | Tag `v*` запускает Docker build/push и GitHub Release | Один источник версии, никаких `latest` |
| D-03 | Добавлять ли PostgreSQL сейчас | Нет; SQLite остаётся единственным backend | Четыре камеры и 1000 событий не оправдывают второй backend |
| D-04 | Как расширять камеры | Встроенные реализации существующего `CameraAdapter` | Контракт уже существует; runtime plugins добавляют риск |
| D-05 | Как настроить эксплуатационные лимиты | `MAX_CAMERAS` и `EVENT_RETENTION_PER_CAMERA` с прежними defaults | Пользователь меняет capacity без fork |
| D-06 | Как фиксировать Actions | Полный commit SHA с версией в комментарии | Supply chain и повторяемость |
| D-07 | Как ограничить Dependabot noise | Игнорировать semver-major; major updates начинаются через Issue | Node.js и другие major updates требуют ручной проверки совместимости |

## План раскладки

| Путь | Содержимое | Проверка |
|---|---|---|
| `.github/workflows/` | CI, CodeQL, Release | actionlint, GitHub Actions |
| `.github/dependabot.yml` | npm, Docker, Actions updates | YAML parse, GitHub Dependabot |
| `.github/ISSUE_TEMPLATE/` | Bug, feature, camera reports | GitHub issue forms |
| `CONTRIBUTING.md`, `SECURITY.md` | Правила и security reports | Review ссылок |
| `server/src/config.ts` | Новые limits и validation | Unit-тесты |
| `server/src/cameras/` | Configurable camera limit | Unit-тесты |
| `server/src/events/` | Configurable retention | Unit-тесты |
| `docker-compose.yaml`, `.env.example` | Versioned image selection и limits | `docker compose config` |
| `docs/camera-adapters.md` | Adapter development | Review и links |
| `CHANGELOG.md` | Release notes | Review |

## Обновления

- 2026-11-23 — Gitleaks 8.30.1 проверил пять исходных commits. Два finding относятся к тестовому Bearer `wrong-token` и стандартному WebSocket handshake key. Точечные allowlist-правила устранили оба false positive; повторный scan не нашёл leaks.
- 2026-11-23 — Проверка генерации нашла отсутствующий ответ 422 Probe в generated types. Commit `fix: sync generated OpenAPI types` устранил расхождение до запуска CI.
- 2026-11-23 — Dependabot нашёл GHSA-67mh-4wv8-2f99 в dev-зависимости `drizzle-kit`. Override `esbuild=0.28.2` и dedupe удалили vulnerable copy. `npm audit` возвращает 0, а `db:generate` завершается без schema changes.
- 2026-11-23 — Первый Dependabot run создал десять major PR, включая Node.js 26 при constraint `<23`. Добавлен ignore semver-major; существующие PR закрываются без merge.
