# 60. MCP-сервер для ИИ-агентов

Статус: этап 3 (план). Контракт AI HTTP API — `contracts/api-v1.openapi.yaml` 1.1.0, спецификация 50.

## 1. Цель

Дать ИИ-агентам единую точку входа (MCP) для работы с платформой: смотреть камеры, слушать звук с камер, управлять PTZ и отправлять звук на динамики камер. MCP-сервер — тонкая обёртка над существующим AI HTTP API `/api/v1/ai/*`; новой бизнес-логики и новых секретов нет.

## 2. Область

### Входит

- Workspace `mcp/`: MCP-сервер поверх `@modelcontextprotocol/sdk`.
- Транспорт Streamable HTTP (stateless). Агенты запускаются на других машинах, поэтому stdio не подходит.
- Авторизация: тот же AI Bearer-токен (`secrets/ai_api_token`). MCP-сервер проверяет заголовок сам и передаёт его дальше в server.
- Инструменты (1:1 к AI HTTP API):
  - `cameras_list`, `camera_get` — состояние, capabilities, last_error.
  - `camera_snapshot` — один кадр JPEG, возвращается как image-контент.
  - `camera_listen` — фрагмент звука с микрофона камеры (WAV, base64).
  - `camera_play_audio` — воспроизведение готового WAV на динамике камеры.
  - `camera_stop_audio` — прерывание воспроизведения.
  - `ptz_move`, `ptz_stop`, `ptz_presets`, `ptz_goto`.
- Compose-сервис `mcp` и маршрут Caddy `/mcp`.
- Описания инструментов содержат правила использования (см. §5).

### Не входит

- Генерация звука на стороне MCP. Агент передаёт готовый WAV (base64).
- Новые возможности camera API. Изменения требований к server — отдельной задачей.
- Admin API и сессии администратора через MCP.

## 3. Архитектура

```text
ИИ-агент (другая машина)
   |  MCP Streamable HTTP POST /mcp, Authorization: Bearer <ai_api_token>
   v
Caddy :8080  (маршрут @mcp, тело до 8 МиБ)
   v
mcp:3000  (stateless MCP, проверка токена)
   |  HTTP /api/v1/ai/*, тот же Authorization
   v
server:8000
```

- MCP-сервер не хранит состояние: каждый JSON-RPC запрос обрабатывается новой парой McpServer + StreamableHTTPServerTransport без опции sessionIdGenerator (stateless-режим SDK 1.32.2). SSE/сессии не используются, GET и DELETE на /mcp отвечают 405.
- Порт по умолчанию 3000. Env: `MCP_PORT`, `MCP_BIND` (по умолчанию 0.0.0.0), `SERVER_API_BASE_URL` (по умолчанию `http://server:8000`), `AI_API_TOKEN_FILE` (по умолчанию `/run/secrets/ai_api_token`) или `AI_API_TOKEN`.
- Ошибки upstream маппируются в McpError: 400/422 → InvalidParams, 401/403 → (невозможно, токен проверен ранее) InternalError, 404 → InvalidParams, 409/413/415 → InvalidParams, 502/503/504 → InternalError с человекочитаемым текстом.
- Токен никогда не логируется и не возвращается в ошибках. Проверка — timing-safe сравнение.

## 4. Лимиты

- Тело JSON-RPC запроса: до 16 МиБ внутри MCP (Caddy режет на 8 МиБ).
- WAV на воспроизведение: base64 декодируется до POST; лимиты server неизменны — не более 5 МиБ и 30 с (`AUDIO_TOO_LARGE`, `AUDIO_DURATION_LIMIT_EXCEEDED`, `UNSUPPORTED_AUDIO_FORMAT`).
- `camera_listen`: `duration_ms` 1000–15000, по умолчанию 5000 (зеркало `CAPTURE_MIN_MS/MAX_MS`).
- `camera_snapshot`: опциональный `width` 64–1920 (зеркало AI-схемы server).

## 5. Правила, которые MCP «учит» агента

Правила зашиты в описания инструментов и в тексте ошибок:

1. Перед `camera_play_audio` проверь `capabilities.audio_output == "supported"` через `camera_get`. Иначе воспроизведение — no-op.
2. Платформа — локальная, камеры смотрят в жилые помещения. Не играй звук ночью без запроса владельца. Один playback на камеру (`AUDIO_OUTPUT_BUSY`).
3. `camera_snapshot` — для разовой визуальной проверки. Длительное наблюдение — MJPEG-стрим напрямую (вне MCP).
4. `camera_listen` возвращает WAV base64: передай его STT/анализу, не сохраняй как файл без нужды.
5. PTZ: передвинул — останови (`ptz_stop`), длительность move 100–5000 мс.

## 6. Тестирование

- Юнит-тесты (node:test, мок fetch): auth 401, снапшот → image-контент, listen → WAV base64, play → decode base64 + Content-Type audio/wav, stop, PTZ, маппинг ошибок.
- Smoke против живого стенда без звука: tools/list, cameras_list, camera_snapshot на реальной камере; play не вызывать.

## 7. Развёртывание

- Сервис `mcp` в `docker-compose.yaml`: образ `home-ai-cctv/mcp:0.1.0`, сеть `backend`, secret `ai_api_token`, healthcheck на `/healthz` (лёгкий endpoint MCP-сервера).
- Caddyfile: `@mcp path /mcp*`, `request_body max_size 8MiB`, `reverse_proxy mcp:3000` с `flush_interval -1`.
- MCP-сервис не публикует ничего, кроме /mcp и /healthz.
