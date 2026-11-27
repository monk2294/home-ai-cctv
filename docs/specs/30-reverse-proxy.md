# 30. Reverse proxy и OpenTunnel

Связанные требования: FR-03, FR-06, FR-08, FR-09, FR-12, FR-13, NFR-08, NFR-09, S2-FR-02–S2-FR-07. Правила audio upload и микрофона этапа 2 — в `50-stage-2.md`.

## 1. Назначение

Caddy принимает HTTP- и WebSocket-трафик и предоставляет единственную HTTP-точку входа. OpenTunnel публикует Caddy через внешний HTTPS URL.

Caddy не заменяет авторизацию сервера. Он защищает media endpoints через `forward_auth`, а сервер проверяет права для своих API.

## 2. Сервисы и внутренние адреса

| Сервис | Внутренний адрес | Назначение |
|---|---|---|
| `web` | `http://web:80` | Статические файлы SPA и SPA fallback |
| `server` | `http://server:8000` | API v1 |
| `media` | `http://media:1984` | Разрешённые API go2rtc |
| `proxy` | `:8080` | HTTP-вход для LAN и OpenTunnel |
| `proxy` | `:8081` | Внутренний listener автоматизаций, только ClusterIP |

В production host публикует только `proxy:8080` и необходимые WebRTC-порты. Внутренние порты web, server и media не публикуются. Listener `8081` не публикуется никогда: он доступен только из кластера.

## 3. Таблица маршрутов

| Внешний путь | Upstream | Авторизация | Особые условия |
|---|---|---|---|
| `/api/v1/auth/session` | server | Публичный login/logout согласно HTTP-методу | JSON body не логировать |
| `/api/v1/health/live` | server | Публичный | Без диагностики секретов |
| `/api/v1/health/ready` | Нет | Не публикуется | Caddy возвращает `404`; Docker вызывает server напрямую |
| `/api/v1/*` | server | Проверяет server | SSE и streaming без буферизации |
| `/media/api/ws*` | media | Admin session через forward_auth | WebSocket, без body timeout |
| `/media/api/webrtc*` | media | Admin session через forward_auth | Только если используется плеером |
| `/media/api/stream.m3u8*` | media | Admin session через forward_auth | Playlist без публичного кэша |
| HLS segment routes | media | Admin session через forward_auth | Точный allowlist выбранной версии |
| `/` и остальные пути | web | Публичная загрузка SPA | Защищённые данные всё равно требуют API auth |

Любой путь go2rtc, который не перечислен явно, должен получать `404` или `403`. Нельзя проксировать `/media/` целиком. Точный маршрут `/api/v1/health/ready` имеет приоритет над общим `/api/v1/*`.

Caddy передаёт `X-Request-ID` upstream и возвращает его клиенту. Если заголовок отсутствует, server создаёт ID. Caddy не заменяет ID, уже назначенный server.

### 3.1 Внутренний listener для автоматизаций

Listener `:8081` обслуживает автоматизации в кластере и не публикуется через Service типа NodePort.

| Внешний путь | Upstream | Авторизация | Особые условия |
|---|---|---|---|
| `GET /api/v1/ai/cameras/*/snapshot.jpg` | server | Caddy подставляет `Authorization: Bearer` из переменной окружения | Только этот путь |
| Остальные пути | Нет | — | Caddy возвращает `404` |

Правила:

- Токен AI API берётся из переменной окружения `CCTV_AI_TOKEN`; в Service `proxy-hooks` (ClusterIP) и в правила автоматизации токен не передаётся. При compose-развёртывании переменная приходит из окружения хоста; без неё listener отвечает 401.
- Caddy заменяет заголовок `Authorization` клиента своим значением; клиент не может подставить чужой токен.
- Маршрут `:8081` не публикует снимки в LAN: порт закрыт вне кластера.
- Доступ к listener имеет только кластерный клиент, например правило openHAB (см. `openhab.md`).

## 4. Авторизация media

Caddy вызывает:

```text
GET http://server:8000/api/v1/auth/verify
```

При проверке:

- Caddy копирует Cookie оригинального запроса.
- Server возвращает `204` или `401`.
- При `204` Caddy передаёт запрос media.
- При `401` Caddy возвращает `401`, не перенаправляя API или media на HTML login.
- Ошибка server auth должна приводить к `502` или `503`, а не к анонимному доступу.
- Ответ auth не должен содержать session token в заголовках upstream.

Для HLS проверка применяется и к playlist, и к сегментам. Для WebSocket проверка выполняется до upgrade.

## 5. HTTPS и доверенные заголовки

### Через OpenTunnel

- Внешний клиент использует HTTPS и WSS.
- OpenTunnel подключается к локальному Caddy по HTTP.
- Публичный hostname задаётся конфигурацией.
- Caddy принимает forwarded scheme только от доверенного локального tunnel, если схема сети это позволяет.
- Server использует доверенный `X-Forwarded-Proto` для Secure cookie и формирования callback URL.
- Внешний клиент не должен подделывать внутренние заголовки авторизации.

### Прямой LAN-доступ

- Для начальной локальной настройки допускается `http://<server>:8080`.
- В режиме `SESSION_COOKIE_SECURE=true` администратор использует HTTPS URL OpenTunnel.
- При необходимости постоянного LAN HTTPS нужно отдельно настроить TLS в Caddy и доверенный сертификат.
- Нельзя отключать проверку TLS в веб-клиенте.

## 6. Длительные соединения

### SSE

Для `/api/v1/events`:

- отключить response buffering;
- не применять короткий read timeout;
- разрешить heartbeat;
- не буферизовать ответ до закрытия;
- не включать compression, если она задерживает события.

### MJPEG

Для `/api/v1/ai/cameras/*/stream.mjpeg`:

- отключить response buffering;
- не применять общий короткий response timeout;
- ограничить время установления upstream connection;
- закрывать upstream при disconnect клиента;
- не кешировать ответ.

### WebSocket

- Сохранить `Upgrade` и `Connection`.
- Разрешить WSS через тот же origin.
- Не использовать короткий idle timeout.
- Проверить прохождение ping/pong или эквивалентного heartbeat.

### HLS

- Не кешировать playlist публично.
- Не объединять запросы разных пользователей без проверки auth.
- Не применять запрет streaming к обычным сегментам, если это ломает воспроизведение.

## 7. Заголовки безопасности

Базовый набор:

```text
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-Frame-Options: DENY
Permissions-Policy: camera=(), microphone=(self), geolocation=()
Content-Security-Policy: ...
```

CSP должен разрешать только необходимые ресурсы своего origin и используемые media/worker blob URL. Нельзя без необходимости добавлять `unsafe-eval`. В MVP microphone остаётся запрещён; этап 2 разрешает `microphone=(self)` для push-to-talk.

Дополнительно:

- Скрывать версии Caddy и upstream, где это поддерживается.
- Не передавать клиенту внутренние URL в ошибках.
- Не включать directory listing.
- Не добавлять wildcard CORS.
- Не включать HSTS на plain HTTP LAN. HSTS допустим на внешнем HTTPS после проверки домена.

## 8. OpenTunnel

### 8.1 Выбранный продукт

Продукт: OpenTunnel (`anomalyco/opentunnel`) — blind TLS tunnel: клиент терминирует TLS локально, наружу только HTTPS/TCP 443. UDP и произвольные TCP-порты не поддерживает. Удалённый WebRTC media не гарантируется; обязательный удалённый режим — HLS (результаты — T-15).

### 8.2 Обязательный сетевой эксперимент T-15

До объявления удалённого доступа готовым нужно проверить:

1. HTTPS GET статических файлов.
2. Login и Secure cookie.
3. JSON POST без потери тела.
4. WSS для WebRTC signaling.
5. SSE и heartbeat более 2 минут.
6. HLS playlist и сегменты.
7. MJPEG не менее 2 минут.
8. Одновременную работу HLS и API.
9. Отсутствие смены cookie attributes tunnel-ом.
10. Поведение после reconnect tunnel.
11. В этапе 2 — файловый playback и WAV для ИИ через HTTPS. Микрофон проверяется только при рабочем WebRTC media; иначе фиксируется `UNSUPPORTED_BY_TUNNEL`.

### 8.3 WebRTC

Если tunnel поддерживает только HTTPS/TCP на одном порту:

- WebRTC signaling может работать;
- WebRTC media через tunnel не гарантируется;
- HLS является обязательным удалённым режимом;
- документация не должна обещать удалённый WebRTC;
- этап 2 не обещает удалённый микрофон через этот tunnel. Файловый playback и WAV для ИИ используют HTTPS и проверяются отдельно.

Если tunnel поддерживает отдельные TCP/UDP mappings:

- опубликовать `8555` согласно документации go2rtc;
- настроить candidates на внешний hostname и порт;
- повторить T-03 через внешнюю сеть.

TURN используется как отдельное решение, если tunnel не может перенести WebRTC media. TURN credentials не входят в публичный API и хранятся как секреты.

## 9. Таймауты и лимиты

Конкретные значения фиксируются в конфигурации, но должны соблюдаться следующие правила:

- Login и ONVIF proxy не ждут бесконечно.
- Streaming endpoints не используют короткий общий request timeout.
- Request body для JSON ограничен небольшим значением, достаточным для RTSP URL и форм.
- Нельзя принимать файлы upload в MVP. В этапе 2 только admin и AI `audio/play` принимают WAV/MP3 до 5 МиБ. Остальные routes сохраняют 64 КиБ.
- Внутренний audio resource server не проксируется через Caddy.
- Число одновременных соединений ограничивается ресурсами сервера и лимитами NFR-01.
- Slowloris-защита не должна разрывать установленный SSE, MJPEG или WebSocket.

## 10. Логи

Access log может содержать:

- метод;
- нормализованный route template;
- status;
- длительность;
- request ID;
- внешний адрес согласно политике владельца.

Access log не должен содержать:

- Cookie;
- Authorization;
- тела запросов;
- пароли;
- Bearer-токены;
- RTSP userinfo;
- полный query string media endpoints, если он может содержать чувствительные параметры.

## 11. Критерии завершения компонента

- Панель go2rtc недоступна через внешний hostname.
- `/media/api/streams` go2rtc недоступен через Caddy.
- Анонимный playlist и WebSocket получают `401`.
- `/api/v1/health/ready` через внешний hostname возвращает `404`.
- SSE и MJPEG не обрываются штатным proxy timeout.
- HLS работает через OpenTunnel.
- WebRTC работает в LAN или явно помечен недоступным по результатам T-15.
- Логи не содержат секреты.
