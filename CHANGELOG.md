# Changelog

Проект использует [Semantic Versioning](https://semver.org/lang/ru/). Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/).

## [Unreleased]

## [0.2.0] - 2026-11-23

### Добавлено

- CI для tests, typecheck, build, OpenAPI и Docker images.
- CodeQL, Dependabot и Gitleaks с проверкой git history.
- Правила участия, приватные security reports и шаблоны Issues/PR.
- Руководство по адапторам камер.
- Публикация versioned server, web и MCP images в GHCR по tag `v*`.
- `MAX_CAMERAS` и `EVENT_RETENTION_PER_CAMERA` с прежними defaults.

### Исправлено

- `loadConfig(env)` читает файлы секретов из переданного environment.

## [0.1.0] - 2026-11-23

### Добавлено

- Fastify API, SQLite и React web client.
- ONVIF, RTSP, go2rtc, WebRTC, HLS, PTZ и motion events.
- AI HTTP API и MCP server.
- Двусторонний звук и мобильная раскладка.
- Docker Compose, backup, restore и verification scripts.
- Лицензия MIT.

[Unreleased]: https://github.com/monk2294/home-ai-cctv/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/monk2294/home-ai-cctv/releases/tag/v0.2.0
[0.1.0]: https://github.com/monk2294/home-ai-cctv/releases/tag/v0.1.0
