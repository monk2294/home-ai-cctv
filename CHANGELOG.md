# Changelog

Проект использует [Semantic Versioning](https://semver.org/lang/ru/). Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/).

## [Unreleased]

## [0.3.0] - 2026-11-23

### Изменено

- Первый release в новом репозитории; нумерация продолжена с 0.2.1.
- Скриншоты и CSV проверок исключены из репозитория; каталог `docs/evidence/` добавлен в `.gitignore`.
- Документация не содержит адресов локальной сети, локальных путей и серийных данных.
- Метаданные коммитов приведены к одному автору.

## 0.2.1 - 2026-11-23

### Безопасность

- Глобальный HTTP rate limit по IP: 1200 запросов в минуту по умолчанию.
- `HTTP_RATE_LIMIT_PER_MINUTE` меняет лимит; 429 использует `RATE_LIMIT_EXCEEDED` и общую схему `Error`.
- Документированы пять ложных или требующих совместимости CodeQL alerts без глобального отключения правил.

## 0.2.0 - 2026-11-23

### Добавлено

- CI для tests, typecheck, build, OpenAPI и Docker images.
- CodeQL, Dependabot и Gitleaks с проверкой git history.
- Правила участия, приватные security reports и шаблоны Issues/PR.
- Руководство по адапторам камер.
- Публикация versioned server, web и MCP images в GHCR по tag `v*`.
- `MAX_CAMERAS` и `EVENT_RETENTION_PER_CAMERA` с прежними defaults.

### Исправлено

- `loadConfig(env)` читает файлы секретов из переданного environment.
- Override `esbuild=0.28.2` устраняет GHSA-67mh-4wv8-2f99 в transitive dev-зависимости `drizzle-kit`.

## 0.1.0 - 2026-11-23

### Добавлено

- Fastify API, SQLite и React web client.
- ONVIF, RTSP, go2rtc, WebRTC, HLS, PTZ и motion events.
- AI HTTP API и MCP server.
- Двусторонний звук и мобильная раскладка.
- Docker Compose, backup, restore и verification scripts.
- Лицензия MIT.

[Unreleased]: https://github.com/monk2294/home-ai-cctv/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/monk2294/home-ai-cctv/releases/tag/v0.3.0
