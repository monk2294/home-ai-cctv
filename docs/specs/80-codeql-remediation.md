# 80. Обработка результатов CodeQL

- Дата: 2026-11-23.
- Ветка: `fix/codeql-remediation`.
- Источник: восемь High alerts после первого CodeQL scan `main`.

## Цель

Закрыть реальный пробел с rate limiting и сохранить видимыми будущие находки. Ложные срабатывания документируются точечно в месте кода.

## Критерии приёмки

| # | Критерий | Проверка |
|---|---|---|
| 1 | HTTP API ограничивает частоту запросов по IP | Тест: третий запрос при лимите 2/min возвращает 429 |
| 2 | Ответ 429 использует OpenAPI `Error` и `X-Request-ID` | Тест тела и headers |
| 3 | Default 1200/min не мешает проверенному профилю snapshots, HLS и healthchecks | Расчёт профиля в этом документе, существующие tests |
| 4 | `HTTP_RATE_LIMIT_PER_MINUTE` принимает положительное целое число | `server/test/config.test.ts` |
| 5 | Login сохраняет отдельный лимит 5 ошибок за 5 минут | Существующий auth test |
| 6 | CodeQL не сообщает прежние восемь alerts после merge | Security → Code scanning |

## Разбор исходных alerts

| Alert | Правило | Решение |
|---|---|---|
| #1 Tapo Digest MD5 | `js/weak-cryptographic-algorithm` | GitHub dismissal: камера требует HTTP Digest MD5; заменить протокол нельзя |
| #2 Admin route group | `js/missing-rate-limiting` | Исправить глобальным `@fastify/rate-limit` |
| #3 Login | `js/missing-rate-limiting` | Исправить глобальным limit; отдельный login limit сохраняется |
| #4 Caddy forward_auth | `js/missing-rate-limiting` | Исправить тем же глобальным limit |
| #5 PTZ timer | `js/resource-exhaustion` | GitHub dismissal: `PtzService.validate` ограничивает duration 100–5000 мс |
| #6 MCP Bearer | `js/insufficient-password-hash` | GitHub dismissal: SHA-256 нормализует высокоэнтропийный token для timing-safe comparison, это не password hash |
| #7 Session/Bearer tokens | `js/insufficient-password-hash` | GitHub dismissal: случайные 256-битные tokens не требуют Argon2 |
| #8 Tapo password derivation | `js/insufficient-password-hash` | GitHub dismissal: это обязательный Digest derivation, не хранение пароля |

## Решения

| ID | Решение | Причина |
|---|---|---|
| D-01 | Использовать `@fastify/rate-limit` вместо собственного общего bucket | Стандартный Fastify lifecycle виден CodeQL и уменьшает новый код |
| D-02 | Default 1200 запросов в минуту на IP | 20 rps дают запас над профилем: 4 snapshots/s и два HLS viewer |
| D-03 | Не ограничивать streaming по числу кадров или bytes в этом PR | Rate limit считает начало HTTP request, а не объём media |
| D-04 | Не добавлять rate limit в MCP в этом PR | MCP — отдельный Node HTTP service; текущий alert относится к Fastify |
| D-05 | Не менять MD5 и SHA-256 ради scanner | Это сломает Tapo или не даст security benefit |

## Границы

- Не добавляется distributed rate limiting.
- Не меняются cookie, session и AI token contracts.
- Не подавляются правила CodeQL глобально.
- Не включается CodeQL query pack без review новых findings.

## Обновления

- 2026-11-23 — Начат анализ восьми alerts после первого scan merge commit `c3f526a`.
- 2026-11-23 — Inline comments не устранили findings и были удалены. Пять оставшихся alerts закрыты через GitHub с причинами и dismissal comments. Code scanning показывает 0 Open.
