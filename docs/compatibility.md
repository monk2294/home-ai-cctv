# Матрица совместимости камер

Правила заполнения — в `specs/90-test-strategy.md`, раздел 5. Дата проверки: 2026-11-21, стенд: Docker Compose на LAN 192.168.1.0/24.

| Поле | Значение |
|---|---|
| Производитель и модель | TP-Link Tapo C520WS |
| Firmware | 1.3.5 Build 260522 Rel.14207n |
| ONVIF | PASS (порт 2020, а не 80; device/media/events/ptz/imaging/deviceIO) |
| Профиль и кодек | profile_1 mainStream H264 2560×1440; profile_2 minorStream H264 640×360; profile_3 jpegStream JPEG 640×360 |
| Аудио | G711 (все профили), capability=supported |
| WebRTC | PASS (браузер YaBrowser/Chrome 150: H264 2560×1440 + звук G711, режим Auto; fallback на HLS за ~9.5 с при блокировке media — T-04; Firefox 160 headless: E2E 9/9, 2026-11-22 — `scripts/e2e-firefox.mjs`; задержка 0.48–0.95 с — `verification.md` §3.2) |
| HLS | PASS (playlist/init/segment.m4s через Caddy, ~0.5 с сегменты; через OpenTunnel TLS — T-15, обязательный удалённый режим) |
| Motion topic | `tns1:RuleEngine/CellMotionDetector/Motion`, simpleItem `IsMotion` = boolean |
| Continuous PTZ | PASS (без `Timeout` в команде — см. примечания) |
| Presets | PASS (2 пресета, созданные в приложении Tapo; ONVIF GetPresets/GotoPreset работают; token числовой — сервер нормализует к строке; пустой список до создания в приложении не означает UNSUPPORTED) |
| Reconnect | PASS (ручной reconnect → online за <3 с) |
| Примечания | 1) ONVIF-порт 2020. 2) Камера рвёт HTTP на `Timeout` в ContinuousMove — сервер не передаёт Timeout и останавливает сам по таймеру. 3) События приходят пачками одинаковых `active`; occurred_at от камеры. 4) GetStreamUri требует предварительного setActiveMediaProfile. 5) go2rtc в Docker отдаёт ICE-кандидатом адрес контейнерной сети — WebRTC не работает без `webrtc.candidates` с LAN-адресом хоста (порт 8555 tcp+udp опубликован). |
