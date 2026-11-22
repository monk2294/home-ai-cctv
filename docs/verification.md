# Матрица проверок home-ai-cctv

Дата прогона: 2026-11-22. Стенд: Docker Compose на хосте 192.168.1.203, эталонная камера TP-Link Tapo C520WS (192.168.1.193:2020). Браузер: YaBrowser 26.8 (Chromium 150), Firefox 160 headless (сборка mozilla).

Воспроизведение API-проверок: `./scripts/verify-stack.sh` (54 PASS-строки, фактический вывод ниже). Unit-тесты: `npm test` — 76/76. Firefox E2E: `E2E_FIREFOX=<путь к firefox> node scripts/e2e-firefox.mjs`. Проверки Chromium выполнены через CDP, скриншоты в `docs/evidence/`.

## 1. Сценарии T-01–T-17

| ID | Статус | Факт |
|---|---|---|
| T-01 | PASS | Probe: 3 профиля, без password и RTSP-URL в ответе. Override с userinfo → 400, чужая scheme → 422. Preview JPEG 200. `probe_`-потоки удалены. Create disabled → 201, пароль не в ответе. |
| T-02 | PASS | Список несёт state и capabilities. `disabled`: snapshot/playback → 409, история событий → 200. Карточки остальных камер не блокируются. |
| T-03 | PASS | WebRTC в LAN: H.264 2560×1440, аудиотрек G711 live, звук включается кнопкой. Задержка 0.48–0.95 с по 4 кадрам (методика и таблица — §3.2), цель NFR-02 ≤ 2 с выполнена. |
| T-04 | PASS | `preferred=webrtc`. При блокировке media (недостижимый ICE-кандидат) клиент включил HLS за 9.5 с. Один активный плеер (один playlist id в опросе). Звук проверен в WebRTC. |
| T-05 | PASS | Move → 204, Stop → 204 на реальной камере (движение подтверждено визуально в прошлой сессии). Нулевые скорости → 400, диапазон → 422. Таймеры и generation token: unit-тесты `ptz.test.ts`, включая «таймер A не останавливает B». |
| T-06 | PASS | Пресеты созданы в приложении Tapo и отдаются через ONVIF (2 шт.). Список: token — строки (числовой token Tapo нормализуется, unit `adapter.test.ts`). Goto 1/2 → 204, позиция GetStatus совпадает с пресетом. Несуществующий token → 404 `PRESET_NOT_FOUND`. |
| T-07 | PASS | События active/inactive приходят через SSE и видны в ленте. Heartbeat за 18 с. Retention: 1000 событий. Дедупликация и транзакция retention: unit-тесты `events.test.ts`, `motion.test.ts`. |
| T-08 | PASS | `CAPABILITY_UNSUPPORTED` → 409 и блокировка команды (unit + серверные проверки). `unknown` в probe не трактуется как supported (UI показывает «не подтверждено», PTZ-панель скрыта до подтверждения). Ошибка PTZ не останавливает видео. |
| T-09 | PASS | AI Bearer → JPEG 320 px. Неверный Bearer → 401. Bearer на PTZ → 401. Width ниже лимита → 400. RTSP-URL не в ответе. |
| T-10 | PASS | Multipart JPEG, 9 кадров за ~6 с при fps=2. Второй consumer → 409 без нового транскодера. После disconnect `_mjpeg`-поток удалён. fps=6 и width=2000 → 400. |
| T-11 | PASS | После `docker compose up -d` (restart всех сервисов): один `cam_`-поток, камера online. Два ручных reconnect подряд: один поток, одна задача, online. |
| T-12 | PASS | Update имени → 200. Disable: media stream удалён, snapshot/playback/reconnect → 409, события доступны. Enable → online. Delete → 204, камера → 404. |
| T-13 | PASS | Анонимные API/snapshot/HLS/WebSocket → 401. `/media/`, `/media/api/streams`, `/media/api/config`, `/api/v1/health/ready` → 404. AI Bearer на admin API → 401, admin cookie на AI API → 401. Чужой Origin → 403. |
| T-14 | PASS | `docker compose logs` не содержат пароль администратора, AI-токен, пароль камеры, session cookie и RTSP userinfo (проверка `grep -F -e`). |
| T-15 | PASS | OpenTunnel (`anomalyco/opentunnel`, blind TLS, только TCP 443). `scripts/verify-tunnel.sh`: 10/10 — static, login, Secure cookie (secure-режим проверен на изолированном стенде), JSON body без потерь, WSS answer, SSE 130 с (8 heartbeat), HLS playlist+segment, MJPEG 130 с (254 кадра), одновременный API, cookie attributes не меняются, reconnect tunnel. Удалённый режим — HLS; WebRTC media через tunnel не переносится. |
| T-16 | PASS | `scripts/backup.sh`: SQLite backup API, сессии исключены (4 удалены), камеры и 1000 событий в копии. Restore на отдельном стеке `cctv-restore-test`: readiness ok, камера online, снимок JPEG 320×180, один `cam_`-поток. Потеря ключа обнаруживается: AES-GCM auth error при чужом ключе. |
| T-17 | PASS | `scripts/load-test.mjs 60`, профиль 90 §7 на 2 камерах (у владельца 2, запас 4 — расчётный). 2 зрителя WebRTC 2560×1440 + 1 MJPEG (2 fps) на камеру + ONVIF subscriptions, 60 минут. LOAD_STATUS GREEN: server RSS 144→155 МиБ (+7.6%), media RSS 98→118 МиБ (+21.7%), fd 36→34, FFmpeg-процессы после остановки 0, зрители 2/2 всё время. Пик CPU: server 10.9%, media 137.4% (≈1.4 ядра на 6-ядерном хосте). Кадры MJPEG ~7526 за час (≈2.1 fps). CSV `docs/evidence/load-60min.csv`. |

## 2. Матрица браузеров

| Браузер | Статус | Факт |
|---|---|---|
| YaBrowser 26.8 / Chromium 150 (desktop) | PASS | Login/logout, сетка, плеер WebRTC и HLS, fallback, PTZ pointer/keyboard, SSE, мастер, настройки. |
| Firefox 160 (desktop, headless) | PASS | Интерактивные E2E 9/9: login, сетка, плеер WebRTC 2560×1440, PTZ move/hold/stop, goto пресета, ручной HLS и возврат в WebRTC, SSE «подключено», logout. Скрипт `scripts/e2e-firefox.mjs` (geckodriver 0.36, WebDriver REST), скриншоты `docs/evidence/firefox-e2e-*.png`. |
| Safari | NOT_RUN | Исключён из обязательного списка владельцем 2026-11-22. |
| Мобильные браузеры | вне MVP | MVP desktop-only (решение владельца 2026-11-22). Адаптив просмотрен эмуляцией 390×844 и 768×1024: desktop-раскладка не сворачивается, на 390 px есть наложения в шапке и ленте; скриншоты `docs/evidence/mobile-*`, `tablet-*`. Устройства владелец проверяет сам. |

## 3. Unit и typecheck

- `npm test`: 76/76 pass (server), web — без unit-тестов по стратегии (E2E через браузер).
- `npm run typecheck`: 0 ошибок, server и web.
- `npm run build`: server и web собираются; основной web-бандл 326 КБ (hls.js — отдельный chunk).

## 3.1 Эксплуатационные проверки

- Recovery пароля: `server/scripts/reset-admin-password.mjs` проверен на копии БД — Argon2id verify нового пароля true, сессии удалены. Production-пароль не менялся.
- Ротация логов: `docker inspect` server-контейнера — `json-file, max-size 10m, max-file 3` (все сервисы).
- Backup: `backups/20261122-002335` — 1 камера, 1000 событий, 0 сессий; расшифровка исходным ключом OK, чужой ключ → ошибка AES-GCM.
- Репозиторий и права: рабочий `config/go2rtc.yaml` (streams с учётными данными камер) — 0600 и в `.gitignore`; в репозитории только `config/go2rtc.example.yaml` без streams. `secrets/` и `backups/` также исключены. Example проверен запуском go2rtc 1.9.9 в отдельном контейнере: api и webrtc слушают, ошибок конфига нет.
- `WEBRTC_LAN_CANDIDATE`: entrypoint медиашлюза подставляет кандидата из env перед стартом go2rtc; без env остаётся значение из config. Проверено: подстановка в песочнице на другом адресе, рестарт media с env, WebRTC после рестарта.
- Secure cookie через tunnel: на изолированном стенде с `SESSION_COOKIE_SECURE=true` Set-Cookie несёт `Secure; HttpOnly; SameSite=Strict`; tunnel attributes не меняет.
- Скриншоты: `docs/evidence/firefox-login.png`, `docs/evidence/firefox-e2e-1-login.png` … `firefox-e2e-6-logout.png`, `docs/evidence/chrome-cameras.png`, `docs/evidence/chrome-camera-webrtc.png`, `docs/evidence/latency-frame-1.png` … `latency-frame-4.jpg`.

## 3.2 Задержка WebRTC (T-03, NFR-02)

Метод: эталонные часы с миллисекундами на экране хоста в поле зрения камеры (страница `clock.html`, строка `H:MM:SS.mmm`). Плеер WebRTC открыт в браузере того же хоста. Кадр вырезается canvas-ом из элемента `video`, время захвата фиксируется `Date.now()`. Задержка = время захвата − время часов в кадре. Часы одни и те же, рассинхрона нет. Миллисекунды смазаны экспозицией камеры, поэтому диапазон считается по читаемым цифрам.

| # | Захват (локальное, UTC+3) | Часы в кадре | Задержка |
|---|---|---|---|
| 1 | 00:47:00.982 | 00:47:00.4x9 | 483–582 мс |
| 2 | 00:48:07.034 | 00:48:06.2xx | 735–834 мс |
| 3 | 00:53:50.316 | 00:53:49.50x | 807–816 мс |
| 4 | 00:57:40.247 | 00:57:39.30x | 938–947 мс |

Вывод: задержка 0.48–0.95 с, цель ≤ 2 с выполнена. Кадры: `docs/evidence/latency-frame-1.png`, `latency-frame-2.jpg`, `latency-frame-3.jpg`, `latency-frame-4.jpg`.

## 3.3 Инструменты браузерных проверок

- Firefox E2E: geckodriver 0.36.0 (бинарник mozilla в `~/.local/bin/geckodriver`) и Firefox 160.0.1 (сборка mozilla в `~/opt/firefox`). Snap-версии не пригодны: snap geckodriver не видит хостовый `/usr/bin/firefox`, snap Firefox не принимает внешний `-profile` и не отдаёт Marionette-порт. Playwright не используется по правилам окружения.
- Запуск: `E2E_FIREFOX=$HOME/opt/firefox/firefox node scripts/e2e-firefox.mjs`. Переопределения: `E2E_BASE_URL`, `E2E_GECKO_PORT`, `E2E_GECKODRIVER`.
- Chromium: проверки через CDP (chrome-devtools), скриншоты `docs/evidence/chrome-*.png`.
- OpenTunnel: CLI 0.6.2 (`~/.local/bin/opentunnel`), маршрут `cctv` → 127.0.0.1:8080. Secure-cookie проверялся на изолированном проекте `cctv-secure-test` (override: proxy 8081, `SESSION_COOKIE_SECURE=true`, media не запускается, чтобы не трогать общий config).
- T-17: `scripts/load-test.mjs 60` — 2 зрителя headless Firefox (WebRTC), по 1 MJPEG consumer на камеру, ежеминутные семплы RSS/fd/ffmpeg; CSV `docs/evidence/load-60min.csv`.

## 4. Отложенные работы (требуют владельца или оборудования)

1. Мобильные устройства: владелец проверяет сам. MVP desktop-only (решение 2026-11-22); адаптив просмотрен эмуляцией, скриншоты `docs/evidence/mobile-*`, `tablet-*`.

T-15, T-17 и T-06 закрыты в этой сессии. Расчётный нагрузочный профиль на 4 источника на стенде владельца не воспроизводится (камер две); T-17 выполнен на 2, запас 4 остаётся расчётным.

## 5. Фактический вывод verify-stack.sh (2026-11-22)

```text
PASS: login 200
== T-13 Авторизация и сетевая поверхность ==
PASS: anonymous /api/v1/cameras -> 401
PASS: anonymous /api/v1/events -> 401
PASS: anonymous snapshot -> 401
PASS: anonymous HLS playlist -> 401
PASS: anonymous WebSocket -> 401
PASS: closed /media/ -> 404
PASS: closed /media/api/streams -> 404
PASS: closed /media/api/config -> 404
PASS: closed /api/v1/health/ready -> 404
PASS: AI Bearer on admin API -> 401
PASS: admin cookie on AI API -> 401
PASS: foreign Origin login -> 403
== T-01 Добавление камеры ==
PASS: probe profiles: 3
PASS: probe response without password
PASS: probe response without RTSP URL
PASS: RTSP override with userinfo rejected -> 400
PASS: RTSP override wrong scheme rejected -> 422
PASS: preview JPEG (200)
PASS: probe_ streams cleaned
PASS: create disabled -> 201
PASS: create response without password
== T-02 Список камер: disabled vs offline ==
PASS: disabled state on create
PASS: disabled snapshot -> 409
PASS: disabled playback -> 409
PASS: disabled events history -> 200
PASS: list carries state+capabilities
== T-12 Update / Enable / Disable / Delete ==
PASS: update name -> 200
PASS: disabled reconnect -> 409
INFO: enable transition state=online
PASS: enable -> online
PASS: disable removed media stream
PASS: delete -> 204
PASS: deleted camera -> 404
== T-05 PTZ Move/Stop ==
PASS: move -> 204
PASS: stop -> 204
PASS: zero speeds rejected -> 400
PASS: out-of-range speed rejected -> 422
== T-06 Пресеты ==
INFO: device presets count=2
PASS: unknown preset token -> 404
PASS: preset list non-empty
== T-09 JPEG для ИИ ==
PASS: AI JPEG width=320 (200)
PASS: wrong Bearer -> 401
PASS: AI Bearer on PTZ -> 401
PASS: width below limit rejected -> 400
== T-10 MJPEG для ИИ ==
PASS: second consumer -> 409
INFO: frames in ~6s at fps=2: 10
PASS: MJPEG fps near 2 (10 frames)
PASS: transcoder removed after disconnect
PASS: fps above limit rejected -> 400
PASS: width above limit rejected -> 400
== T-07 SSE ==
PASS: SSE heartbeat within 18s (1)
PASS: retention <= 1000 (1000)
== T-11 Reconnect ==
PASS: double reconnect: cam_ streams=2 (enabled cameras=2)
PASS: camera online after reconnect
== T-14 Очистка диагностики ==
PASS: logs without admin password, AI token, camera password, session cookie
PASS: logs without RTSP userinfo
== Итог ==
Проверки завершены. BLOCKED-строки требуют решения владельца или оборудования.
```