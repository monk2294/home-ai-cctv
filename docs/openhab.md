# Интеграция с openHAB

События попадают из `server` в openHAB по MQTT: движение и бортовые события камер (Tapo C520WS распознаёт людей, тампер, зоны, линии). Свет в кабинете управляется этими событиями без обращения к модели. Анализ кадра decision-моделью отключён: сервер llama.cpp на Steam Deck остановлен, секции 2.4, 3 и 4 описывают отключённый контур как справочник.

## 1. Контур

```text
Камера -> ONVIF Events -> server -> Mosquitto (home-ai-cctv/events)
       -> Generic MQTT Thing -> Item HomeCCTV_Event
       -> правило office_light_presence -> свет (без модели)
       -> правило homecctv_camera_events (отключено) -> снимок -> decision-модель -> Items
```

- `server` публикует событие после сохранения и дедупликации в SQLite. Ошибка MQTT не прерывает ONVIF и SSE.
- Правило не держит SSE и не опрашивает API. Оно работает только по сообщению MQTT.
- Снимок берётся через внутренний listener `proxy:8081`; токен AI API подставляет прокси.
- Модель возвращает вероятности вариантов, а не текст. Текст для человека формирует правило.

## 2. Что создать в openHAB

### 2.1 MQTT Broker

Используется существующий broker thing `mqtt:broker:53c1c90caa`. Учётные данные openHAB не меняются.

### 2.2 Generic MQTT Thing

| Поле | Значение |
|---|---|
| UID | `mqtt:topic:53c1c90caa:home_cctv` |
| Bridge | `mqtt:broker:53c1c90caa` |
| Канал | `event`, тип `mqtt:string`, `stateTopic=home-ai-cctv/events` |

### 2.3 Items

| Item | Тип | Назначение |
|---|---|---|
| `HomeCCTV_Event` | String | Payload события, связан с каналом `event` |
| `HomeCCTV_LastEventId` | String | `id` последнего события любого состояния |
| `HomeCCTV_LastAnalyzedId` | String | `id` последнего проанализированного события |
| `HomeCCTV_LastAnswer` | String | Решения модели в виде текста |
| `HomeCCTV_LastDecision` | String | Решения модели в виде JSON для автоматизации |
| `HomeCCTV_Analyzing` | Switch | Признак идущего анализа, защита от параллельных вызовов |

### 2.4 Правило

UID `homecctv_camera_events`, триггер `core.ItemStateUpdateTrigger` на `HomeCCTV_Event`, действие `script.ScriptAction` с типом `application/javascript`.

Правило отключено (`enabled=false`): оно существует только для анализа кадра моделью, а сервер модели остановлен. Эталонный текст сохранён для возврата: `deploy/openhab/homecctv_camera_events.js`. Он совпадает с правилом в openHAB; после правки файла обновите правило через UI или REST.

Правило делает следующее:

1. Разбирает JSON.
2. Реагирует только на `type=motion` и `state=active`. События `people` правило не анализирует: камера шлёт активное состояние пакетами десятками событий в секунду, сервер троттлирует повторы до одного keepalive-события в 30 секунд, но каждый новый `id` всё равно запускал бы новый анализ.
3. Пропускает событие, если его `id` совпадает с `HomeCCTV_LastEventId`. При живой серии Item получает следующее событие раньше, чем скрипт прочитал состояние, поэтому правило видит самое свежее событие и не повторяет уже обработанные.
4. Пропускает событие, если его `id` уже равен `HomeCCTV_LastAnalyzedId`.
5. Пропускает событие, если `HomeCCTV_Analyzing` включён. Во время серии событий анализируется примерно одно событие за время ответа модели.
6. Берёт снимок по `camera_id` с таймаутом 20 с.
7. Отправляет снимок и вопросы камеры в модель с таймаутом 60 с.
8. Записывает текст в `HomeCCTV_LastAnswer`, JSON в `HomeCCTV_LastDecision`, `id` в `HomeCCTV_LastAnalyzedId`.
9. Снимает `HomeCCTV_Analyzing` в `finally`.

## 3. Вопросы по камерам

Вопросы задаются в правиле, в объекте `CAMERAS` по `camera_id`. Для неизвестной камеры используется `DEFAULT_QUESTIONS`.

Типы вопросов:

| Тип | Поля | Ответ модели |
|---|---|---|
| `choice` | `instructions`, `criteria` (объект вариант → описание) | выбранный вариант и вероятность |
| `score` | `instructions`, `criteria` (массив 2–10 уровней) | номер уровня и вероятность |
| `noul` | `instructions`, необязательные `true` и `false` | вероятность «да» от 0 до 1 |

Поле `label` правило не отправляет в модель: это подпись для текста в `HomeCCTV_LastAnswer`.

| Камера | `camera_id` | Вопросы |
|---|---|---|
| Рабочее место | `dfeab160-5904-4bfe-9465-d1936b30a205` | человек; сколько людей; работа за столом; человек в кабинете; нештатная ситуация |
| Tapo C520WS 239 | `c968560c-4609-4e07-99cf-11b5be2c05f7` | человек; сколько людей; готовка; нештатная ситуация |

Пример итогового текста:

```text
Рабочее место (2 с): человек — человек есть (100%); людей — один (99%); работа за столом — за столом (74%); в кабинете — человек или люди в помещении (100%); нештатная ситуация — 5%
```

Чтобы изменить вопросы, отредактируйте правило в UI openHAB (`Settings -> Rules -> Home CCTV camera events`) или обновите его через `PUT /rest/rules/homecctv_camera_events`.

## 4. Модель (сервер остановлен)

| Параметр | Значение |
|---|---|
| Хост | `192.168.1.233`, llama.cpp |
| Endpoint | `POST http://192.168.1.233:8080/v1/systemone` |
| Модель | `/home/deck/sd/d1/d1-2B-Q4_K_M.gguf` |
| Вход | `state: null`, `images: ["data:image/jpeg;base64,..."]`, `questions` |
| Выход | `answers` с вероятностями, `output_tokens` всегда 0 |
| Таймаут | 60 с |

Сервер llama.cpp на Steam Deck остановлен, картинки в него не отправляются. Для возврата анализа запустите llama.cpp с этой моделью, включите правило `homecctv_camera_events` и верните модельный путь в правиле света.

Факты про модель (для возврата):

- Один снимок 2560×1440 занимает около 500 входных токенов.
- Ответ на четыре вопроса занимает 2–3 с.
- Модель читает изображение: на снимке «Рабочее место» вариант `office` получил 0.997, на снимке кухни вариант `kitchen` — 0.911.
- Endpoint `/v1/chat/completions` эта модель не обслуживает и отвечает `501`. Используйте только `/v1/systemone`.

## 5. Свет в кабинете по присутствию

Правило `office_light_presence` управляет `OfficeLight_Switch` по бортовым событиям камеры «Рабочее место». Модель в правиле не используется. Расписание `office_light_schedule` отключено: принудительного включения в 07:00 больше нет.

| Item | Тип | Назначение |
|---|---|---|
| `HomeCCTV_OfficePresent` | Switch | Текущее решение о присутствии |
| `HomeCCTV_OfficeLastSeen` | String | Время последнего подтверждения присутствия, epoch мс |

Эталонный текст: `deploy/openhab/office_light_presence.js`.

Триггеры: cron каждую минуту, обновление `HomeCCTV_Event`.

Логика (гистерезис против шума бортового детектора):

1. Включение — по событию `people active` (для камер без `people` — по `motion active`). Камера должна видеть человека непрерывно `ON_CONFIRM_MS` (0,75 с): `active` запускает таймер подтверждения, `inactive` до подтверждения отменяет его. Короткие всплески детектора свет не включают. Пока камера шлёт `people`, `motion` сам свет не включает.
2. Выключение — по решению face-check. Сигналы присутствия замолчали на `OFF_DEBOUNCE_MS` (10 с) → правило спрашивает сервис `presence-check`: есть ли лицо в свежем кадре. Лицо есть → присутствие держится, отсчёт 10 с начинается заново. Лица нет → повторная проверка через `FACE_RETRY_MS` (1 с). Два промотра подряд → свет выключить. Ошибка face-check (502, таймаут) → свет не трогается, перепроверка через 10 с. Сервер троттлирует повтор одного состояния события (keepalive 30 с).
3. Пока человек в кадре, активные события приходят не реже одного keepalive в 30 с. `HomeCCTV_OfficeLastSeen` обновляется каждым активным событием. Если people-детектор потерял человека, но камера видит движение, `motion active` удерживает уже включённый свет.
4. Cron раз в минуту — страховка на случай потери событий: если свет включён и активных сигналов нет `OFF_AFTER_MS` (2 мин), правило гасит свет.

Параметры в правиле: `ON_CONFIRM_MS = 0,75 с`, `OFF_DEBOUNCE_MS = 10 с`, `FACE_RETRY_MS = 1 с`, `OFF_AFTER_MS = 2 мин`, cron `0 0/1 * * * ?`.

Поведение:

- Ручное выключение света при присутствии правило не отменяет: команда `ON` идёт только на активном событии.
- Ошибка разбора события не меняет Items и не гасит свет.

## 6. Ограничения

- Среда JS-правил (`script.ScriptAction`): нет глобального `executeHttpRequest`, `require()` из openhab-js падает (`Path.getRoot()` is null). HTTP в правиле идёт через `Java.type("java.net.http.HttpClient")` — проверено. После PUT правила перезапустите openHAB: старые setTimeout-колбэки и модули обновлённого правила могут продолжать работать параллельно с новыми.

- QoS 1 без `retain`: событие теряется, если broker недоступен. Догон возможен по `event.id` через `GET /api/v1/cameras/{camera_id}/events`.
- Бортовой people-детектор шумит: теряет и находит человека за доли секунды. Гистерезис правила (включение после 0,75 с непрерывного присутствия, выключение после 10 с отсутствия) гасит дребезг. Если детектор потерял неподвижного человека более чем на 10 с, свет гаснет; возврат — по следующему активному событию через 0,75 с.
- Замеры живой БД: `people active` живёт 0,3–4,6 с, между вспышками паузы 2–10 с; при неподвижном человеке камера не шлёт ничего по 40–97 с. `motion active` в этих паузах удерживает свет; если движения нет, свет гаснет через 10 с.
- Причина провалов бортового детектора (замер 24.11.2026): он не видит сидящего человека без корпуса в полный рост (голова, руки, плечо). Решение — детекция лица: OpenCV `FaceDetectorYN` + YuNet (`face_detection_yunet_2023mar.onnx`, 233 КБ), сервис `presence-check` (`docs/specs/55-face-presence-check.md`). Замер на homesv (ThinkCentre M75q, CPU): лицо сидящего человека находится при входе 1920×1080 (score 0.91, 21 мс); при входе 1280×704 теряется.
- События `people` правило `homecctv_camera_events` не анализировало и раньше: оно обновляло только `HomeCCTV_LastEventId`. Светом управляет правило `office_light_presence`.
- Проверочное событие, опубликованное во время живой серии, может не дойти до правила: Item получает следующее событие ONVIF раньше, чем скрипт прочитал состояние. Проверяйте при спокойной камере.

## 7. Проверка

1. Опубликуйте тестовое событие:

   ```bash
   kubectl -n home-ai-cctv exec deployment/server -- node --input-type=module -e '
   import { connectAsync } from "mqtt";
   import fs from "node:fs";
   const client = await connectAsync("mqtt://mosquitto.smart-devices.svc.cluster.local:1883", {
     username: "home-cctv",
     password: fs.readFileSync("/run/secrets-mqtt/password", "utf8").trim(),
   });
   const now = new Date().toISOString();
   const event = { id: "probe-1", camera_id: "<camera_id>", type: "motion", state: "active", occurred_at: now, received_at: now, source: "probe", topic: "probe" };
   await new Promise((resolve, reject) => client.publish("home-ai-cctv/events", JSON.stringify(event), { qos: 1 }, (e) => e ? reject(e) : resolve()));
   await client.endAsync();
   '
   ```

2. Проверьте Items: `HomeCCTV_Event` содержит JSON события. Анализ отключён, `HomeCCTV_LastAnswer` и `HomeCCTV_LastDecision` не обновляются.
3. Проверьте лог правила света:

   ```bash
   kubectl -n smart-devices exec deployment/openhab -- \
     sh -c 'grep -h "Office light" /openhab/userdata/logs/openhab.log | tail -5'
   ```

   Пробное событие `motion active` включает свет; гашение — по `motion inactive` через 2 с или по cron после `OFF_AFTER_MS`.