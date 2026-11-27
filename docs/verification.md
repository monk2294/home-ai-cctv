# Матрица проверок home-ai-cctv

Дата прогона: 2026-11-22. Стенд: Docker Compose на локальном хосте в домашней сети, эталонная камера TP-Link Tapo C520WS (ONVIF port 2020). Браузер: YaBrowser 26.8 (Chromium 150), Firefox 160 headless (сборка mozilla).

Воспроизведение API-проверок: `./scripts/verify-stack.sh` (54 PASS-строки, фактический вывод ниже). Unit-тесты: `npm test` — 114/114. Firefox E2E: `E2E_FIREFOX=<путь к firefox> node scripts/e2e-firefox.mjs`. Проверки Chromium выполнены через CDP. Скриншоты и CSV остаются локальными artifacts и исключены из git.

## 1. Сценарии T-01–T-25

T-01–T-17 содержат фактические результаты MVP. T-18–T-25 выполнены 2026-11-22 на этапе 2. У Tapo C520WS нет RTSP-backchannel, поэтому звук на динамик идёт через локальный `tapo://`; выбор адаптера автоматический. Живой браузерный микрофон после внедрения адаптера отдельно не перепроверялся.

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
| T-17 | PASS | `scripts/load-test.mjs 60`, профиль 90 §7 на 2 камерах (у владельца 2, запас 4 — расчётный). 2 зрителя WebRTC 2560×1440 + 1 MJPEG (2 fps) на камеру + ONVIF subscriptions, 60 минут. LOAD_STATUS GREEN: server RSS 144→155 МиБ (+7.6%), media RSS 98→118 МиБ (+21.7%), fd 36→34, FFmpeg-процессы после остановки 0, зрители 2/2 всё время. Пик CPU: server 10.9%, media 137.4% (≈1.4 ядра на 6-ядерном хосте). Кадры MJPEG ~7526 за час (≈2.1 fps). CSV сохранён только как локальный artifact. |
| T-18 | PASS | Firefox 160 headless, 372 px (ширина контента 360): grid, экран камеры, мастер добавления, события — без горизонтального переполнения; сайдбар сворачивается в верхнюю панель (`sidebar=row`). E2E 12/12. Скриншоты исключены из публичного репозитория. Реальные Android/iOS остаются за владельцем (раздел 4). |
| T-19 | PASS | Клиент: `useSnapshotPolling` — fetch раз в 1 с, пауза на скрытой вкладке и вне вьюпорта (IntersectionObserver), backoff 5 с, остановка при 401 (logout) и 409 (CAMERA_DISABLED). E2E: 5 запросов `snapshot.jpg` за 3.5 с. Сервер: in-flight дедупликация (6 параллельных запросов → 1 вызов go2rtc), кэш кадра 250 мс — тесты `server/test/stage2.test.ts`. |
| T-20 | PART | Tapo C520WS 1.3.5: RTSP SDP не содержит обратного аудиотрека. Специализированный Tapo-адаптер автоматически проверяет media-порт 8800 и добавляет `tapo://`; probe возвращает `audio_output=supported`, go2rtc отправляет PCMA/8000. Файловый звук слышен, браузерный живой микрофон не перепроверялся. Детали — `compatibility.md`. |
| T-21 | PART | Push-to-talk в E2E (фейковый микрофон Firefox): запись → WAV 16 кГц mono → `POST audio/play` 202. Файловый picker: WAV/MP3, клиентский лимит 5 МиБ, stop-кнопка. HTTP-контракт play/stop/413/415/422/409 — PASS (секция T-21 в `verify-stack.sh`). Физический звук — T-22. |
| T-22 | PART | WAV через динамик реальной камеры слышен; микрофон хоста обнаружил тестовые тона. HTTP-контракт play/stop/ошибки проходит в тестах. Физическое прерывание Stop во время звука не перепроверялось. При `audio_output!=supported` сохраняется no-op по решению владельца. |
| T-23 | PASS | `GET /api/v1/ai/cameras/{id}/audio.wav`: RIFF/WAVE 16000 Гц mono (200); `duration_ms=100` → 400; одновременные capture той же камеры обслужены (dedup); ffmpeg/ffprobe 5.1.9 в серверном образе. |
| T-24 | PASS | AI PTZ: move/stop → 204, presets → 200, goto → 204 по Bearer; скорость вне диапазона → 422. |
| T-25 | PASS | `GET /api/v1/ai/cameras` и `/ai/cameras/{id}`: 200, без `host`/`username`/`password`/`profile_token`/`has_rtsp_override`; AI `audio/play` → 202; stop неизвестного воспроизведения → 404. |

## 2. Матрица браузеров

| Браузер | Статус | Факт |
|---|---|---|
| YaBrowser 26.8 / Chromium 150 (desktop) | PASS | Login/logout, сетка, плеер WebRTC и HLS, fallback, PTZ pointer/keyboard, SSE, мастер, настройки. |
| Firefox 160 (desktop, headless) | PASS | Интерактивные E2E 12/12: login, сетка, плеер WebRTC 2560×1440, PTZ move/hold/stop, goto пресета, ручной HLS и возврат в WebRTC, polling снимков ~1/с, push-to-talk (фейковый микрофон) с запросом audio/play, мобильная раскладка 372 px, SSE «подключено», logout. Скрипт `scripts/e2e-firefox.mjs` (geckodriver 0.36, WebDriver REST); скриншоты сохраняются локально и не входят в git. |
| Safari desktop | NOT_RUN | Исключён из обязательного списка MVP. |
| iOS Safari и Android Chrome | NOT_RUN | Обязательны для этапа 2 по `specs/50-stage-2.md`. Реальные устройства ещё не проверялись. |
| Мобильная эмуляция MVP | FAIL для адаптива | На 390×844 и 768×1024 desktop-раскладка не сворачивается; на 390 px есть наложения в шапке и ленте. Это исходные данные для T-18, а не проверка мобильного браузера. Скриншоты исключены из публичного репозитория. |

## 3. Unit и typecheck

- `npm test`: 114/114 pass (server, включая `contract.test.ts` — маршруты/схемы контракта v1.1.0 — и `stage2.test.ts` — AI discovery/PTZ/WAV, playback, дедуп снапшотов), web — без unit-тестов по стратегии (E2E через браузер).
- `npm run typecheck`: 0 ошибок, server и web.
- `npm run build`: server и web собираются; hls.js — отдельный chunk (578 КБ, предупреждение о размере — известное).

## 3.1 Эксплуатационные проверки

- Recovery пароля: `server/scripts/reset-admin-password.mjs` проверен на копии БД — Argon2id verify нового пароля true, сессии удалены. Production-пароль не менялся.
- Ротация логов: `docker inspect` server-контейнера — `json-file, max-size 10m, max-file 3` (все сервисы).
- Backup: `backups/20261122-002335` — 1 камера, 1000 событий, 0 сессий; расшифровка исходным ключом OK, чужой ключ → ошибка AES-GCM.
- Репозиторий и права: рабочий `config/go2rtc.yaml` (streams с учётными данными камер) — 0600 и в `.gitignore`; в репозитории только `config/go2rtc.example.yaml` без streams. `secrets/` и `backups/` также исключены. Example проверен запуском go2rtc 1.9.9 в отдельном контейнере: api и webrtc слушают, ошибок конфига нет.
- `WEBRTC_LAN_CANDIDATE`: entrypoint медиашлюза подставляет кандидата из env перед стартом go2rtc; без env остаётся значение из config. Проверено: подстановка в песочнице на другом адресе, рестарт media с env, WebRTC после рестарта.
- Secure cookie через tunnel: на изолированном стенде с `SESSION_COOKIE_SECURE=true` Set-Cookie несёт `Secure; HttpOnly; SameSite=Strict`; tunnel attributes не меняет.
- Скриншоты: создаются только как локальные artifacts; каталог `docs/evidence/` исключён из git.

## 3.2 Задержка WebRTC (T-03, NFR-02)

Метод: эталонные часы с миллисекундами на экране хоста в поле зрения камеры (страница `clock.html`, строка `H:MM:SS.mmm`). Плеер WebRTC открыт в браузере того же хоста. Кадр вырезается canvas-ом из элемента `video`, время захвата фиксируется `Date.now()`. Задержка = время захвата − время часов в кадре. Часы одни и те же, рассинхрона нет. Миллисекунды смазаны экспозицией камеры, поэтому диапазон считается по читаемым цифрам.

| # | Захват (локальное, UTC+3) | Часы в кадре | Задержка |
|---|---|---|---|
| 1 | 00:47:00.982 | 00:47:00.4x9 | 483–582 мс |
| 2 | 00:48:07.034 | 00:48:06.2xx | 735–834 мс |
| 3 | 00:53:50.316 | 00:53:49.50x | 807–816 мс |
| 4 | 00:57:40.247 | 00:57:39.30x | 938–947 мс |

Вывод: задержка 0.48–0.95 с, цель ≤ 2 с выполнена. Исходные кадры не входят в публичный репозиторий.

## 3.3 Инструменты браузерных проверок

- Firefox E2E: geckodriver 0.36.0 (бинарник mozilla в `~/.local/bin/geckodriver`) и Firefox 160.0.1 (сборка mozilla в `~/opt/firefox`). Snap-версии не пригодны: snap geckodriver не видит хостовый `/usr/bin/firefox`, snap Firefox не принимает внешний `-profile` и не отдаёт Marionette-порт. Playwright не используется по правилам окружения.
- Запуск: `E2E_FIREFOX=$HOME/opt/firefox/firefox node scripts/e2e-firefox.mjs`. Переопределения: `E2E_BASE_URL`, `E2E_GECKO_PORT`, `E2E_GECKODRIVER`.
- Chromium: проверки через CDP (chrome-devtools); скриншоты остаются локальными artifacts.
- OpenTunnel: CLI 0.6.2 (`~/.local/bin/opentunnel`), маршрут `cctv` → 127.0.0.1:8080. Secure-cookie проверялся на изолированном проекте `cctv-secure-test` (override: proxy 8081, `SESSION_COOKIE_SECURE=true`, media не запускается, чтобы не трогать общий config).
- T-17: `scripts/load-test.mjs 60` — 2 зрителя headless Firefox (WebRTC), по 1 MJPEG consumer на камеру, ежеминутные семплы RSS/fd/ffmpeg; CSV сохраняется локально в исключённом из git каталоге.

## 4. Отложенные работы (требуют владельца или оборудования)

1. Мобильные устройства: владелец проверяет сам. MVP был desktop-only; этап 2 требует T-18 на реальных Android Chrome и iOS Safari. Исходные screenshots эмуляции сохранены только локально. Эмуляция этапа 2 (Firefox, 372 px) пройдена.
2. Живой микрофон и физический Stop (T-20–T-22): файловый звук через `tapo://` уже работает. Нужно отдельно проверить живой браузерный push-to-talk и прерывание звука кнопкой Stop без повторных громких прогонов.
3. Микрофон в реальном браузере телефона: требует HTTPS (GetUser Media только в secure context). На стенде HTTP только `127.0.0.1` является secure context; для LAN-доступа нужен сертификат (отложено).

T-15, T-17 и T-06 закрыты в этой сессии. Расчётный нагрузочный профиль на 4 источника на стенде владельца не воспроизводится (камер две); T-17 выполнен на 2, запас 4 остаётся расчётным.

## 6. MCP smoke (2026-11-23, спецификация 60)

Прогон против живого стенда через `http://127.0.0.1:8080/mcp` (AI Bearer-токен из `secrets/ai_api_token`):

- `POST /mcp` без токена → 401; не-POST → 405.
- `tools/list` → 10 инструментов (`cameras_list` … `ptz_goto`).
- Ошибки upstream доходят до агента с кодом сервера: неизвестный `camera_id` → `CAMERA_NOT_FOUND`.
- `cameras_list` → камера `dfeab160-…` в `online`, `audio_output=supported`.
- `camera_snapshot` (width 640) → image/jpeg, 34 618 байт.
- `ptz_presets` → 2 пресета на реальной камере.
- `camera_play_audio` не вызывался (запрет на воспроизведение звука).

Локально: `npm run typecheck` без ошибок, `npm test` — 114 server + 13 mcp, `npm run build` зелёный.

## 7. Перенос в microk8s (2026-11-23)

- Namespace `home-ai-cctv`: `proxy`, `web`, `server`, `media`, `mcp` — все Deployment 1/1. PVC `server-data` и `media-config` — Bound. Compose-контейнеры остановлены и сохранены для отката.
- Финальный backup перед переносом: `backups/20261123-222035`. SQLite создан через backup API после остановки server; 2 камеры перенесены, admin sessions исключены.
- LAN: Caddy — `30081`, WebRTC — `30555/tcp+udp`, API go2rtc на host не открыт. Runtime ICE candidate — `192.168.1.123:30555`.
- NetworkPolicy: `proxy` получает `media:1984`, обращение `web` к тому же endpoint завершается timeout.
- API: admin login, 2 камеры online, JPEG обеих камер, anonymous API → 401, readiness через Caddy → 404, MCP tools/list → 10 инструментов.
- Потоки: SSE heartbeat получен, MJPEG — 11 кадров примерно за 6 секунд при fps=2. Firefox headless: login, grid и живой WebRTC 2560×1440; `currentTime` увеличивается.
- Тест восстановления: `media` остановлен, `server` перезапущен и зафиксировал обе камеры `offline`. После запуска `media` обе камеры автоматически стали `online` без ручного reconnect. Проверка покрыта unit-тестом `reconcileOffline`.
- Локально после изменения retry: `npm test` — 121 server + 13 mcp, `npm run typecheck` и `npm run build` — без ошибок.
- PTZ, физический звук и нагрузочный тест после переноса не повторялись.

## 8. MQTT и openHAB (2026-11-23)

- Mosquitto `smart-devices`: добавлен пользователь `home-cctv` в `mosquitto-credentials`. Секрет `home-ai-cctv-mqtt` содержит только пароль. Проверка аутентификации из pod `server` (`connectAsync`) — `PASS`.
- `server` публикует событие в `home-ai-cctv/events` после сохранения. Публикация из pod `server` тем же клиентом: событие получено openHAB, `HomeCCTV_Event` содержит JSON, `HomeCCTV_LastEventId` обновился.
- openHAB 5.0.2, JavaScript Scripting: созданы Thing `mqtt:topic:53c1c90caa:home_cctv`, Item `HomeCCTV_Event`, `HomeCCTV_LastEventId`, `HomeCCTV_LastAnalyzedId`, `HomeCCTV_LastAnswer`, `HomeCCTV_LastDecision`, `HomeCCTV_Analyzing` и правило `homecctv_camera_events`. Статус правила `IDLE`, ошибок компиляции нет.
- Снимок без токена: внутренний listener `proxy-hooks:8081` отдаёт `GET /api/v1/ai/cameras/{id}/snapshot.jpg` с кодом 200; другие пути — 404. Из LAN порт `8081` закрыт, публичный API без токена — 401.
- Сквозной анализ на снимке «Рабочее место»: снимок 337698 байт за 2,5 с, ответ модели за 9 с. Повторная публикация того же `id` не вызывает повторного анализа.
- Decision-модель переведена на llama.cpp `192.168.1.233:8080`, endpoint `/v1/systemone`, модель `/home/deck/sd/d1/d1-2B-Q4_K_M.gguf`. `/v1/chat/completions` отвечает `501`: модель не генерирует текст.
- Модель читает изображение: вопрос «что это за помещение» дал `office` 0.997 на снимке «Рабочее место» и `kitchen` 0.911 на снимке Tapo. Снимок занимает около 500 входных токенов, четыре вопроса — 2–3 с.
- Живые события камеры «Рабочее место» (`source=onvif`) прошли полный путь ONVIF -> server -> MQTT -> openHAB -> снимок -> модель. Проанализированы события `142090`, `142126`, `142137`, `142160`, `142174`, `142195`, `142281`. Пример: «человек есть (100%); один (97%); за столом (72%); нештатная ситуация — 7%». `HomeCCTV_LastDecision` содержит `event_id` и вероятности ответов.
- Серия событий (около 10 в секунду) не создаёт очередь: правило анализирует одно событие за 2–3 с и пропускает остальные с предупреждением «предыдущий анализ ещё идёт».
- Проверочное событие `probe-8`, отправленное во время живой серии, до правила не дошло: Item `HomeCCTV_Event` успел получить следующее событие ONVIF раньше, чем скрипт прочитал состояние. Проверочные публикации делать при спокойной камере, а результат подтверждать по `id` в логе правила.
- Свет в кабинете по присутствию: правило `office_light_presence`, порог присутствия 0.7. Включение — по событию движения через готовый ответ модели; выключение — по `motion inactive` после 2 с тишины и проверки кадра (~5–7 с после ухода). Cron 1 мин — страховка с выключением через 2 мин без подтверждения. Правило `office_light_schedule` отключено.
- Калибровка порога на живых кадрах: кабинет с человеком — `p(yes)=0.998` три раза подряд, пустая кухня — 0.030–0.040. Ответ модели 2,3–4,7 с.
- Включение по cron: `23:57:03` присутствие 100%, `OfficeLight_Switch` = `ON`.
- Выключение: камера правила временно переключена на кухню, `HomeCCTV_OfficeLastSeen` сдвинут на 6 мин назад. Результат `23:56:42` — «присутствия нет 6 мин, свет выключен», `OfficeLight_Switch` = `OFF`. После возврата камеры «Рабочее место» свет включился на следующем тике cron.
- Быстрый путь без вызова модели: `probe-9` проанализирован в `23:58:46.374`, правило присутствия обновило Items в `23:58:46.379`, то есть через 5 мс, по готовому ответу `answers.room`.
- Быстрое выключение по событию: камера правила временно переключена на кухню, опубликовано `motion inactive` `probe-off-1` в `00:07:44.838`. Свет выключен в `00:07:49.476` — через 4,6 с (2 с пауза + снимок + модель). После возврата камеры «Рабочее место» свет включён, `OfficeLight_Power` = 143 Вт.
- Таймеры openHAB: `setTimeout`/`clearTimeout` и `cache.private` работают в JS-правиле; колбэк таймера видит `items`, `Java`, `console`. Проверено отдельным правилом `timer_probe_tmp` (удалено).
- Тёмный кадр: свет выключен, снимок 94956 байт, `p(yes)=0.998`, средняя яркость кадра 71 из 255. Камера видит человека без освещения, путь «вход в тёмный кабинет» работает.
- Попутная правка `homecctv_camera_events`: у камеры «Рабочее место» появился пятый вопрос «человек в кабинете». Ответ попадает в `HomeCCTV_LastAnswer` и `HomeCCTV_LastDecision`.

## 5. Фактический вывод verify-stack.sh (2026-11-22)

Вывод ниже снят до внедрения специализированного Tapo-адаптера. Строки T-20/T-22 о noop отражают прежнее поведение.

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
== T-18 Мобильная раскладка ==
BLOCKED: T-18: визуальная проверка 360 px — в Firefox E2E (scripts/e2e-firefox.mjs)
== T-19 Опрос снимков ==
PASS: 4 снимка подряд получены за 99 мс
PASS: polling body is JPEG
PASS: клиент использует polling-хук 1 с
== T-20capability динамик (hardware) ==
PASS: server image carries ffmpeg/ffprobe
INFO: audio_output эталонной камеры = unknown
BLOCKED: T-20 sound: backchannel недоступен на Tapo C520WS (docs/compatibility.md), play работает как noop
== T-21 Воспроизведение файла (HTTP) ==
PASS: admin WAV play -> 202
PASS: play carries X-Request-ID
PASS: duration_ms из ffprobe (2000)
PASS: второй play на камере -> 409
PASS: stop playback -> 204
PASS: content-type text/plain -> 415
PASS: тело 5 MiB + 1 байт -> 413
PASS: лимит Caddy 5 MiB пропущен для audio/play
PASS: код ошибки AUDIO_OUTPUT_BUSY
== T-22 Звук через динамик (hardware) ==
BLOCKED: T-22: подтверждение слышимости невозможно без backchannel-камеры (решение владельца 22.11.2026: noop)
== T-23 WAV для ИИ ==
PASS: AI WAV 16 кГц mono (200)
PASS: duration_ms=100 -> 400
PASS: dedup: одновременные capture той же камеры обслужены (200)
== T-24 PTZ для ИИ ==
PASS: AI PTZ move -> 204
PASS: AI PTZ stop -> 204
PASS: AI preset list -> 200
PASS: AI preset goto -> 204
PASS: скорость вне диапазона -> 422
== T-25 Discovery для ИИ ==
PASS: AI discovery list -> 200
PASS: AI-модель без host/учётных данных/RTSP
PASS: AI get camera -> 200
PASS: AI audio play -> 202
PASS: stop неизвестного воспроизведения -> 404
== Итог ==
Проверки завершены. BLOCKED-строки требуют решения владельца или оборудования.
```


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