# Задача агенту-исполнителю: реализовать этап 2 home-ai-cctv

- Проект: локальная копия репозитория `home-ai-cctv`.
- Тип задачи: реализация, тесты и обновление фактической документации.
- Статус: документация и OpenAPI подготовлены; код этапа 2 ещё не реализован.
- Дата: 2026-11-22.

Этот файл содержит полный контекст задачи. Не ищи требования в истории чата и других спецификациях. Исходники читай по карте из раздела 4. Машиночитаемый контракт уже находится в `docs/specs/contracts/api-v1.openapi.yaml`. Не меняй его без обнаруженного дефекта контракта.

## 1. Результат

Реализуй четыре группы возможностей:

1. Адаптируй все экраны SPA под смартфоны.
2. Дай администратору микрофон push-to-talk и воспроизведение WAV/MP3 через камеру.
3. Обновляй JPEG на главном экране с целевым периодом 1 секунда.
4. Дай ИИ-агенту звук камеры, PTZ, список камер и воспроизведение WAV/MP3.

Сохрани все возможности MVP. Не ломай WebRTC/HLS fallback, ONVIF Events, SSE, MJPEG, авторизацию, backup и reconnect.

## 2. Исходный контекст

### Стек и эксплуатация

- Node.js 22.16.0, Fastify, strict TypeScript, ESM.
- React 19, Vite, React Router, CSS Modules.
- SQLite через better-sqlite3 и Drizzle.
- go2rtc 1.9.9 с FFmpeg в контейнере `media`.
- Caddy 2.9.1 как единственная HTTP-точка входа.
- До 4 камер, 2 зрителя, 1 MJPEG consumer на камеру.
- Один администратор и один AI Bearer-токен.
- Рабочий `config/go2rtc.yaml` содержит учётные данные камер. Не выводи его содержимое.

### Эталонное оборудование

- TP-Link Tapo C520WS.
- Firmware 1.3.5 Build 260522 Rel.14207n.
- ONVIF port 2020.
- Основной профиль: H.264 2560×1440, G711.
- ONVIF PTZ, пресеты и motion events уже работают.
- Tapo разрывает HTTP при `Timeout` в ContinuousMove. Сервер сам планирует Stop. Не добавляй этот параметр.
- WebRTC требует LAN candidate в go2rtc. Не меняй эту конфигурацию без необходимости.
- Поддержка динамика заявлена владельцем, но платформа её ещё не проверяла. T-20 обязателен.

### Сетевые ограничения

- Текущий OpenTunnel переносит только HTTPS/TCP 443.
- Удалённый просмотр работает по HLS.
- WebRTC media через OpenTunnel не работает.
- Микрофон через OpenTunnel получает ограничение `UNSUPPORTED_BY_TUNNEL`. Это не дефект этапа 2.
- WAV для ИИ и файловый playback должны работать через HTTPS tunnel.
- Микрофон в LAN требует HTTPS или localhost. Обычный `http://<LAN-IP>:8080` не даёт secure context.

## 3. Что не входит

- Нативное мобильное приложение.
- Аудиоархив, постоянная запись и библиотека файлов.
- TTS, STT и серверный анализ звука.
- Произвольные HTTP/RTSP URLs и FFmpeg arguments от клиента.
- Проприетарный `tapo://`, облачный пароль Tapo и новые облачные секреты.
- RBAC, scope для AI Bearer и несколько администраторов.
- PTZ-туры и редактирование пресетов.
- Новая state-библиотека, UI-фреймворк или Playwright.

Если реальная камера принимает звук только через `tapo://`, останови audio-ветку. Зафиксируй `BLOCKED` и сообщи владельцу. Не запрашивай облачный пароль самостоятельно.

## 4. Карта текущего кода

| Файл | Текущее поведение | Что изменить |
|---|---|---|
| `web/src/components/CameraTile.tsx` | `<img>` обновляется раз в 30 секунд только для `online` | Вынести polling в управляемый hook с AbortController и периодом 1 секунда |
| `web/src/components/CameraTile.module.css` | Карточка рассчитана на desktop | Добавить мобильную раскладку и touch targets |
| `web/src/player/VideoPlayer.tsx` | WebRTC video recvonly + audio recvonly; HLS fallback через 8 секунд | Добавить audio sendrecv, push-to-talk и полный cleanup |
| `web/src/api/client.ts` | JSON fetch wrapper и snapshot URL | Добавить binary audio upload, WAV download, AI не подключать к SPA |
| `web/src/components/Layout.tsx` и CSS | Sidebar слева | На узком экране использовать верхнюю панель |
| `web/src/components/Sidebar.tsx` и CSS | Две ссылки и logout | Сохранить все действия в мобильной панели |
| `web/src/screens/*.tsx` и CSS | Частичный responsive | Устранить overflow и наложения на всех экранах |
| `web/src/ptz/PtzPanel.tsx` | Pointer/keyboard PTZ уже реализован | Сохранить Stop, pointercancel и добавить мобильные размеры |
| `server/src/cameras/adapter.ts` | Общий интерфейс камеры | Capabilities с `audio_output` и источники медиа |
| `server/src/onvif/adapter.ts` | Probe ONVIF и профилей | Добавить безопасную диагностику backchannel без блокировки Probe |
| `server/src/cameras/manager.ts` | CRUD, media, PTZ, Reconciliation | Проверка audio_output, lifecycle audio services, безопасная AiCamera |
| `server/src/media/client.ts` | streams, JPEG, MJPEG | Добавить диагностику backchannel и Stream to camera |
| `server/src/ptz/service.ts` | Общий лимит 5 секунд и generation token | Использовать без дублирования для AI |
| `server/src/http/routes/ptz.ts` | Admin PTZ | Вынести общие handlers или вызывать общий service из AI routes |
| `server/src/http/routes/events.ts` | Содержит также AI JPEG/MJPEG | Добавить новые AI routes или разделить модуль без изменения старого поведения |
| `server/src/ai/registry.ts` | MJPEG consumer registry | Не смешивай MJPEG и audio limits без явной необходимости |
| `server/src/app.ts` | Admin scope и AI routes | Подключить новые routes и guards |
| `server/src/index.ts` | Composition root и shutdown | Создать audio services и закрывать их при shutdown |
| `server/Dockerfile` | Production image без FFmpeg | Добавить FFmpeg/ffprobe с фиксированной версией пакета |
| `config/Caddyfile` | Body 64 КиБ; microphone запрещён | Точечный audio limit и `microphone=(self)` |
| `server/test/` | node:test + tsx | Добавить unit/integration tests |
| `scripts/e2e-firefox.mjs` | Firefox E2E через geckodriver | Добавить mobile layout и доступные браузерные сценарии |
| `scripts/verify-stack.sh` | T-01–T-14 | Добавить API/auth/limit checks этапа 2 |
| `scripts/verify-tunnel.sh` | T-15 | Добавить HTTPS audio playback и WAV |
| `scripts/load-test.mjs` | T-17 | Добавить snapshot polling и audio cleanup к профилю |

Новые серверные модули размести в `server/src/audio/`. Новые UI-компоненты звука размести в `web/src/audio/`. Не создавай параллельную архитектуру вокруг существующих manager, service и API client.

## 5. Порядок работы

### Шаг 0. Проверь базу

Выполни:

```bash
npm test
npm run typecheck
npm run build
```

Зафиксируй исходные ошибки отдельно. Не приписывай их своим изменениям.

### Шаг 1. Выполни T-20 как эксперимент

До реализации audio UI и audio API проверь реальную Tapo через go2rtc:

1. Выполни RTSP DESCRIBE с `Require: www.onvif.org/ver20/backchannel`.
2. Найди в SDP `audio` с направлением `sendonly`.
3. Запиши фактические codecs динамика.
4. Проверь исходящий микрофон через WebRTC.
5. Проверь WAV через go2rtc Stream to camera.
6. Подтверди слышимый звук на камере.
7. Запиши модель, firmware, codec и ограничения в `docs/compatibility.md`.

Используй существующие настройки камеры. Не печатай пароли, RTSP userinfo, Cookie и Bearer.

Если go2rtc 1.9.9 не работает с backchannel, проверь новый стабильный релиз на отдельном стенде. Не используй `latest` или `master`. После обновления повтори T-03, T-04, T-09, T-10 и T-15.

### Шаг 2. Сгенерируй типы

OpenAPI уже имеет version 1.1.0 и все новые маршруты. Выполни:

```bash
npm run generate:api
```

Не редактируй generated files вручную.

### Шаг 3–7. Реализация

1. Реализуй capabilities и серверные audio services.
2. Добавь AI discovery, WAV, PTZ и playback.
3. Реализуй snapshot scheduler.
4. Реализуй мобильную раскладку.
5. Добавь микрофон и файловый UI.
6. Обнови Caddy и server image.
7. Выполни проверки и обнови фактические документы.

Небольшие независимые части можно менять в другом порядке. T-20 остаётся gate для audio-реализации.

## 6. Требования к главному экрану

Используй `GET /api/v1/cameras/{id}/snapshot.jpg?width=640`.

1. Запускай polling только для `online` и `degraded` карточек в viewport.
2. Используй целевой период запуска 1000 мс при успешных ответах.
3. Не создавай overlap для одной карточки.
4. Пропускай тики во время медленного запроса.
5. Не накапливай очередь тиков.
6. Останавливай polling и отменяй запросы в скрытой вкладке.
7. Останавливай polling вне viewport.
8. Отменяй timers и requests при размонтировании.
9. Не запускай polling для `disabled`, `connecting` и `offline`.
10. Пересоздавай polling только при смене соответствующего состояния.

Правила отображения:

- Атомарно заменяй JPEG после успеха.
- Не очищай прежний кадр между запросами.
- Не показывай loader при каждом обновлении.
- Не позволяй старому ответу заменить новый кадр.
- Освобождай object URLs после замены и при cleanup.
- Сохраняй последний кадр при ошибке.
- Не считай AbortError при cleanup ошибкой камеры.
- После сетевой или media ошибки используй backoff 5 секунд.
- При `401` выполни общий logout flow.
- При `409 CAMERA_DISABLED` прекрати polling.

На сервере объединяй одинаковые in-flight JPEG requests по camera ID и width. Допустим memory cache до 250 мс. Не создавай disk cache и новый RTSP source.

Приёмка T-19: здоровая видимая карточка получает 55–61 кадр за 60 секунд при ответах быстрее 1 секунды. Overlap и очередь отсутствуют.

## 7. Требования к мобильному клиенту

Проверь viewport:

- 320×568;
- 360×800;
- 390×844;
- 768×1024;
- landscape на реальном смартфоне.

Требования:

- Все routes работают без горизонтального скролла.
- Sidebar становится компактной верхней панелью.
- Сетка камер и детальный экран используют одну колонку на смартфоне.
- Плеер находится перед PTZ и событиями.
- Touch targets имеют размер не менее 44×44 CSS px.
- Поля ввода на iOS используют font-size не менее 16 px.
- Controls плеера и PTZ переносятся без наложений.
- Длинные строки не расширяют страницу.
- Диалоги помещаются в viewport и прокручиваются по вертикали.
- Экранная клавиатура не скрывает активное поле и submit.
- Учитывай safe-area у закреплённых элементов.
- Скрывай fullscreen button при отсутствии Fullscreen API.
- Не применяй `touch-action: none` ко всей странице.
- Сохрани pointer capture и Stop для PTZ.

Обязательные браузеры: текущие стабильные Android Chrome и iOS Safari. Firefox viewport emulation проверяет только layout. Отсутствие реального устройства даёт `BLOCKED`, а не `PASS`.

## 8. Capability `audio_output`

Добавь обязательное поле во все публичные capabilities:

- `supported`: SDP подтверждает ONVIF backchannel и совместимый codec.
- `unsupported`: проверка завершена без backchannel или камера вернула `Unsupported`.
- `unknown`: timeout, сеть или неполный ответ.

Правила:

- `audio` означает микрофон камеры.
- `audio_output` означает динамик камеры.
- DeviceIO без SDP не доказывает `supported`.
- Проверка относится к выбранному профилю.
- Probe может проверить первый совместимый профиль.
- Create и Reconciliation уточняют выбранный профиль.
- Смена профиля повторяет проверку.
- Ошибка проверки не блокирует камеру и видео.
- Старые записи БД без поля возвращают `unknown`.
- Disabled камера сохраняет последний известный результат.
- API и logs не содержат SDP, RTSP или credentials.

UI разрешает микрофон и playback только при `supported`. Для `unknown` покажи «Передача звука не подтверждена». Для `unsupported` покажи отсутствие поддержки.

## 9. Микрофон администратора

Размести push-to-talk рядом с громкостью на детальном экране.

Условия:

- камера включена;
- `audio_output=supported`;
- фактический режим WebRTC;
- доступен `navigator.mediaDevices.getUserMedia`;
- secure context.

Реализация:

1. При создании PeerConnection замени audio `recvonly` на `sendrecv`.
2. Не запрашивай микрофон при открытии страницы.
3. Запроси `getUserMedia` только после нажатия.
4. Добавь track через `replaceTrack` без нового SDP offer.
5. До нажатия не передавай исходящий track.
6. Если кнопку отпустили до разрешения, останови полученные tracks и не начинай речь.
7. На время речи отключай входящий звук этой камеры.
8. После речи восстанови прежние mute и volume.
9. Используй echoCancellation, noiseSuppression и autoGainControl при поддержке.
10. После отпускания вызови `replaceTrack(null)` и останови tracks.

Прекращай речь при:

- pointerup, pointercancel и потере capture;
- keyup клавиши активации;
- 60 секундах непрерывной речи;
- скрытии вкладки;
- размонтировании;
- logout и Disable;
- разрыве WebRTC;
- переходе на HLS или смене режима.

Не используй automatic retry. При HLS покажи «Говорить можно только через WebRTC». При insecure context покажи требование HTTPS или localhost. Permission denied не перезапускает плеер.

Сохрани текущий go2rtc signaling V1: raw SDP через `webrtc/offer`, candidates строками, answer и `sdpMid: '0'`. Не открывай новые media routes.

## 10. Файловый playback для администратора и ИИ

### Маршруты

| Операция | Admin cookie | AI Bearer |
|---|---|---|
| Play | `POST /api/v1/cameras/{camera_id}/audio/play` | `POST /api/v1/ai/cameras/{camera_id}/audio/play` |
| Stop | `DELETE /api/v1/cameras/{camera_id}/audio/play/{playback_id}` | `DELETE /api/v1/ai/cameras/{camera_id}/audio/play/{playback_id}` |

### Формат

- Raw HTTP body, не JSON, не base64 и не multipart.
- Content-Type: `audio/wav` или `audio/mpeg`.
- Максимум 5 МиБ.
- Максимум 30 секунд декодированного звука.
- Хотя бы одна аудиодорожка.
- Видео и дополнительные дорожки игнорируются.
- Внешние URL запрещены.
- Одно активное файловое playback на камеру для admin и AI вместе.

### Жизненный цикл

1. Проверь авторизацию до чтения большого body.
2. Проверь камеру, `audio_output` и busy-лимит.
3. Прочитай body с жёстким лимитом.
4. Проверь файл через ffprobe.
5. Храни bytes только в памяти server.
6. Создай случайный internal resource ID.
7. Открывай internal HTTP resource только в Docker backend.
8. Не проксируй internal resource через Caddy.
9. Вызови go2rtc `POST /media/api/streams?dst=<cam>&src=<ffmpeg-source>` из server.
10. Сформируй FFmpeg source из internal URL и `#input=file`.
11. Используй codec, который реально объявила камера. Для Tapo подтверди codec в T-20.
12. Верни `202 AudioPlayback` после принятия команды go2rtc.
13. При Stop вызови go2rtc с пустым `src`.
14. Освободи buffer и internal resource после Stop или `estimated_end_at + 5 секунд`.
15. Сними busy-лимит по тому же lifecycle.

`AudioPlayback` содержит `playback_id`, `camera_id`, `duration_ms`, `started_at`, `estimated_end_at`. `202` подтверждает команду go2rtc, но не физический звук.

Disable, Delete, reconnect, shutdown и смена профиля останавливают playback этой камеры. Restart не восстанавливает старые файлы.

UI:

- Предоставь file picker на детальном экране.
- Показывай имя, длительность, отправку и Stop.
- Не запускай второй Play при `AUDIO_OUTPUT_BUSY`.
- Не сохраняй файл в Web Storage или IndexedDB.
- Не останавливай видео при ошибке playback.

## 11. WAV для ИИ

Добавь:

```text
GET /api/v1/ai/cameras/{camera_id}/audio.wav?duration_ms=5000
```

Параметр:

- default 5000;
- minimum 1000;
- maximum 15000.

Ответ:

- `audio/wav`;
- PCM signed 16-bit little-endian;
- mono;
- 16000 Hz;
- `Cache-Control: no-store`;
- полный WAV с корректным размером.

Реализация:

1. Используй внутренний RTSP `rtsp://media:8554/<cam_stream>` без публикации порта наружу.
2. Читай существующий `cam_` stream через go2rtc.
3. Запусти FFmpeg в server только для звука.
4. Пиши WAV в stdout.
5. Собери ответ в память без диска и SQLite.
6. Не превышай 500 КиБ на максимальный fragment.
7. Заверши FFmpeg после заданной длительности.
8. Убей процесс при disconnect, shutdown, Disable, Delete и reconnect.
9. Разреши один capture на камеру и два capture на server.
10. Верни `409 AI_AUDIO_LIMIT_REACHED` при превышении.
11. Верни `503 CAMERA_MEDIA_UNAVAILABLE`, если звук не появился за 5 секунд.
12. Не возвращай `200` с частичным WAV после ошибки источника.

Для `audio=unsupported` верни `409 CAPABILITY_UNSUPPORTED`. Для disabled верни `409 CAMERA_DISABLED`.

## 12. PTZ и discovery для ИИ

Добавь AI Bearer routes:

```text
POST /api/v1/ai/cameras/{camera_id}/ptz/move
POST /api/v1/ai/cameras/{camera_id}/ptz/stop
GET  /api/v1/ai/cameras/{camera_id}/ptz/presets
POST /api/v1/ai/cameras/{camera_id}/ptz/presets/{preset_token}/goto
```

Используй существующие manager methods и один `PtzService` с admin API. Сохрани:

- pan, tilt, zoom от -1 до 1;
- хотя бы одну ненулевую скорость;
- duration_ms от 100 до 5000;
- automatic Stop;
- generation token;
- capability checks;
- preset ownership check;
- отсутствие automatic retry Move.

Добавь:

```text
GET /api/v1/ai/cameras
GET /api/v1/ai/cameras/{camera_id}
```

`AiCamera` содержит только `id`, `name`, `state`, `capabilities`, `last_error`. Не возвращай `host`, `onvif_port`, `username`, `profile_token`, RTSP override, secrets и stream names.

Admin cookie не принимается на AI routes. AI Bearer не принимается на admin routes. AI Bearer по-прежнему не даёт CRUD, admin events и admin session.

## 13. Caddy, server image и безопасность

### Caddy

- Сохрани 64 КиБ для обычных API.
- Задай 5 МиБ только для двух `audio/play` POST routes.
- Не увеличивай общий `/api/v1/*` limit.
- Установи `Permissions-Policy: camera=(), microphone=(self), geolocation=()`.
- Сохрани CSP без `unsafe-eval`.
- Не добавляй internal audio resource.
- Не добавляй публичный go2rtc Stream to camera.
- Сохрани media allowlist.

### Server image и процессы

- Добавь FFmpeg и ffprobe в production image.
- Зафиксируй package versions по правилам репозитория.
- Запускай processes через argument array без shell.
- Не принимай аргументы процесса от клиента.
- Ограничь startup, duration, stdout и process count.
- Освобождай processes и buffers на всех exit paths.

### Ошибки

| HTTP | Код | Условие |
|---|---|---|
| 409 | `AUDIO_OUTPUT_BUSY` | Активное файловое playback на камере |
| 409 | `AI_AUDIO_LIMIT_REACHED` | Превышен WAV capture limit |
| 404 | `AUDIO_PLAYBACK_NOT_FOUND` | Playback завершён или не найден |
| 413 | `AUDIO_TOO_LARGE` | Body больше 5 МиБ |
| 415 | `UNSUPPORTED_AUDIO_FORMAT` | Неверный MIME |
| 422 | `INVALID_AUDIO` | Нет декодируемой аудиодорожки |
| 422 | `AUDIO_DURATION_LIMIT_EXCEEDED` | Больше 30 секунд |

Сохрани существующие коды камер и media. Каждый response содержит `X-Request-ID`. Error body использует текущую схему `Error`. Логи не содержат audio bytes, upload body, internal audio URLs, Cookie, Authorization, Bearer, RTSP userinfo и пароли.

## 14. Проверки

| ID | Обязательный результат |
|---|---|
| T-18 | Все экраны проходят указанные viewports без overflow. Android Chrome и iOS Safari проходят основные сценарии |
| T-19 | 55–61 JPEG за 60 секунд на здоровой видимой карточке; нет overlap; visibility/offscreen/backoff работают |
| T-20 | Реальная Tapo подтверждает SDP, mic и файл; слышен динамик; compatibility matrix заполнена |
| T-21 | Permission denied, insecure context и HLS имеют диагностику; все release paths останавливают mic; limit 60 секунд работает |
| T-22 | Admin WAV/MP3 и Stop работают; busy, MIME, size, duration и corrupt file checks проходят; resources очищены |
| T-23 | AI WAV имеет нужный format/duration; auth, capture limits и disconnect cleanup работают |
| T-24 | Четыре AI PTZ routes повторяют admin behavior; automatic Stop и cross-auth checks проходят |
| T-25 | AI discovery не раскрывает лишние поля; AI Play/Stop работает; admin и AI делят busy-лимит |

Дополнительно:

1. Повтори T-01–T-17.
2. Расширь T-13 новыми auth checks.
3. Расширь T-14 поиском internal audio URLs и secrets.
4. Расширь T-15 HTTPS playback и WAV.
5. Расширь T-17 двумя главными экранами с 1-second polling, WAV capture и sequential playback.
6. Не выставляй `PASS` без фактического вывода.
7. Отсутствие оборудования отмечай `BLOCKED`.

Финальные команды:

```bash
npm test
npm run typecheck
npm run build
./scripts/verify-stack.sh
E2E_FIREFOX=$HOME/opt/firefox/firefox node scripts/e2e-firefox.mjs
```

Запускай Firefox E2E против живого стека. Tunnel и load tests выполняй по необходимости соответствующих изменений; перед финальной приёмкой они обязательны.

## 15. Результат работы агента

Передай владельцу:

- список изменённых модулей;
- фактические результаты T-18–T-25;
- результаты регрессий;
- версии go2rtc и FFmpeg;
- ограничения реальных устройств и OpenTunnel;
- любые `FAIL` или `BLOCKED` без скрытия.

Обнови:

- generated API types;
- `docs/compatibility.md` фактами камеры;
- `docs/verification.md` фактическими проверками;
- остальные docs только при расхождении реализации с заданием.

Не заявляй готовность при отсутствии T-20. Этап считается готовым только при прохождении обязательных проверок или явном решении владельца принять конкретное ограничение.
