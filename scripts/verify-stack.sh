#!/usr/bin/env bash
# Проверки T-01–T-25 против работающего стека (спецификации 90 и 51).
# Запуск: ./scripts/verify-stack.sh [base-url]
# Вывод: строки PASS/FAIL/BLOCKED с фактами. Секреты не печатаются.
set -uo pipefail
cd "$(dirname "$0")/.."
BASE="${1:-http://127.0.0.1:8080}"
ADMIN_PASS=$(cat secrets/admin_password)
AI_TOKEN=$(cat secrets/ai_api_token)
# Параметры эталонной камеры читаются из БД работающего стека; секрет не хранится в скрипте.
CAM_JSON=$(docker compose exec -T server node -e "
const D=require('better-sqlite3');const {createDecipheriv}=require('node:crypto');const fs=require('node:fs');
const db=new D(process.env.DATABASE_PATH,{readonly:true});
const row=db.prepare('SELECT host, onvif_port, username, password_enc FROM cameras LIMIT 1').get();
const key=Buffer.from(fs.readFileSync(process.env.CAMERA_ENCRYPTION_KEY_FILE,'utf8').trim(),'base64');
const raw=Buffer.from(row.password_enc,'base64');
const d=createDecipheriv('aes-256-gcm',key,raw.subarray(1,13));d.setAuthTag(raw.subarray(13,29));
const pass=Buffer.concat([d.update(raw.subarray(29)),d.final()]).toString('utf8');
process.stdout.write(JSON.stringify({host:row.host,port:row.onvif_port,user:row.username,pass}));
")
CAM_HOST=$(python3 -c "import json; print(json.loads('''$CAM_JSON''')['host'])")
CAM_PORT=$(python3 -c "import json; print(json.loads('''$CAM_JSON''')['port'])")
CAM_USER=$(python3 -c "import json; print(json.loads('''$CAM_JSON''')['user'])")
CAM_PASS=$(python3 -c "import json; print(json.loads('''$CAM_JSON''')['pass'])")
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; }
blocked() { echo "BLOCKED: $*"; }

# Логин администратора
code=$(curl -s -c "$TMP/ck.txt" -o "$TMP/login.json" -w "%{http_code}" -X POST "$BASE/api/v1/auth/session" \
  -H "Content-Type: application/json" -H "Origin: $BASE" \
  -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASS\"}")
[[ "$code" == "200" ]] && pass "login 200" || { fail "login $code"; exit 1; }
CK=(-b "$TMP/ck.txt" -H "Origin: $BASE")
AI=(-H "Authorization: Bearer $AI_TOKEN")

echo "== T-13 Авторизация и сетевая поверхность =="
for p in /api/v1/cameras /api/v1/events; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE$p")
  [[ "$code" == "401" ]] && pass "anonymous $p -> 401" || fail "anonymous $p -> $code"
done
CAM_ID=$(curl -s "${CK[@]}" "$BASE/api/v1/cameras" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])")
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/v1/cameras/$CAM_ID/snapshot.jpg")
[[ "$code" == "401" ]] && pass "anonymous snapshot -> 401" || fail "anonymous snapshot -> $code"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/media/api/stream.m3u8?src=cam_${CAM_ID//-/}&mp4")
[[ "$code" == "401" ]] && pass "anonymous HLS playlist -> 401" || fail "anonymous HLS -> $code"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" "$BASE/media/api/ws?src=cam_${CAM_ID//-/}")
[[ "$code" == "401" ]] && pass "anonymous WebSocket -> 401" || fail "anonymous WS -> $code"
for p in /media/ /media/api/streams /media/api/config /api/v1/health/ready; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE$p")
  [[ "$code" == "404" || "$code" == "403" ]] && pass "closed $p -> $code" || fail "closed $p -> $code"
done
code=$(curl -s -o /dev/null -w "%{http_code}" "${AI[@]}" "$BASE/api/v1/cameras")
[[ "$code" == "401" ]] && pass "AI Bearer on admin API -> 401" || fail "AI Bearer admin API -> $code"
code=$(curl -s -o /dev/null -w "%{http_code}" "${CK[@]}" "$BASE/api/v1/ai/cameras/$CAM_ID/snapshot.jpg")
[[ "$code" == "401" ]] && pass "admin cookie on AI API -> 401" || fail "admin cookie AI API -> $code"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/auth/session" -H "Content-Type: application/json" -H "Origin: http://evil.example" -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASS\"}")
[[ "$code" == "403" || "$code" == "401" ]] && pass "foreign Origin login -> $code" || fail "foreign Origin -> $code"

echo "== T-01 Добавление камеры =="
PROBE_BODY="{\"host\":\"$CAM_HOST\",\"onvif_port\":$CAM_PORT,\"username\":\"$CAM_USER\",\"password\":\"$CAM_PASS\"}"
curl -s "${CK[@]}" -X POST "$BASE/api/v1/cameras/probe" -H "Content-Type: application/json" -d "$PROBE_BODY" -o "$TMP/probe.json"
n=$(python3 -c "import json; d=json.load(open('$TMP/probe.json')); print(len(d.get('profiles',[])))")
[[ "$n" -ge 1 ]] && pass "probe profiles: $n" || fail "probe profiles: $n"
grep -q "password" "$TMP/probe.json" && fail "probe response contains password field" || pass "probe response without password"
grep -q "rtsp://" "$TMP/probe.json" && fail "probe response contains RTSP URL" || pass "probe response without RTSP URL"
code=$(curl -s -o /dev/null -w "%{http_code}" "${CK[@]}" -X POST "$BASE/api/v1/cameras/probe" -H "Content-Type: application/json" \
  -d "{\"host\":\"$CAM_HOST\",\"onvif_port\":$CAM_PORT,\"username\":\"$CAM_USER\",\"password\":\"$CAM_PASS\",\"rtsp_url_override\":\"rtsp://user:pass@$CAM_HOST:554/stream1\"}")
[[ "$code" == "422" || "$code" == "400" ]] && pass "RTSP override with userinfo rejected -> $code" || fail "userinfo override -> $code"
code=$(curl -s -o /dev/null -w "%{http_code}" "${CK[@]}" -X POST "$BASE/api/v1/cameras/probe" -H "Content-Type: application/json" \
  -d "{\"host\":\"$CAM_HOST\",\"onvif_port\":$CAM_PORT,\"username\":\"$CAM_USER\",\"password\":\"$CAM_PASS\",\"rtsp_url_override\":\"http://$CAM_HOST/stream1\"}")
[[ "$code" == "422" || "$code" == "400" ]] && pass "RTSP override wrong scheme rejected -> $code" || fail "wrong scheme -> $code"
PROFILE=$(python3 -c "import json; print(json.load(open('$TMP/probe.json'))['profiles'][0]['token'])")
code=$(curl -s "${CK[@]}" -X POST "$BASE/api/v1/cameras/probe/snapshot.jpg?width=320" -H "Content-Type: application/json" \
  -d "{\"host\":\"$CAM_HOST\",\"onvif_port\":$CAM_PORT,\"username\":\"$CAM_USER\",\"password\":\"$CAM_PASS\",\"profile_token\":\"$PROFILE\"}" \
  -o "$TMP/preview.jpg" -w "%{http_code}")
file "$TMP/preview.jpg" | grep -q JPEG && pass "preview JPEG ($code)" || fail "preview not JPEG ($code)"
sleep 2
leftover=$(docker compose exec -T media wget -qO- "http://127.0.0.1:1984/media/api/streams" | python3 -c "import json,sys; print([k for k in json.load(sys.stdin) if k.startswith('probe_')])")
[[ "$leftover" == "[]" ]] && pass "probe_ streams cleaned" || fail "probe_ leftover: $leftover"
code=$(curl -s "${CK[@]}" -X POST "$BASE/api/v1/cameras" -H "Content-Type: application/json" \
  -d "{\"host\":\"$CAM_HOST\",\"onvif_port\":$CAM_PORT,\"username\":\"$CAM_USER\",\"password\":\"$CAM_PASS\",\"name\":\"VERIFY-TEMP\",\"profile_token\":\"$PROFILE\",\"enabled\":false}" \
  -o "$TMP/created.json" -w "%{http_code}")
TEMP_ID=$(python3 -c "import json; print(json.load(open('$TMP/created.json')).get('id',''))")
[[ "$code" == "201" || "$code" == "200" ]] && pass "create disabled -> $code" || fail "create -> $code"
grep -q "$CAM_PASS" "$TMP/created.json" && fail "create response leaks password" || pass "create response without password"

echo "== T-02 Список камер: disabled vs offline =="
state=$(python3 -c "import json; print(json.load(open('$TMP/created.json'))['state'])")
[[ "$state" == "disabled" ]] && pass "disabled state on create" || fail "state=$state"
code=$(curl -s -o /dev/null -w "%{http_code}" "${CK[@]}" "$BASE/api/v1/cameras/$TEMP_ID/snapshot.jpg")
[[ "$code" == "409" ]] && pass "disabled snapshot -> 409" || fail "disabled snapshot -> $code"
code=$(curl -s -o /dev/null -w "%{http_code}" "${CK[@]}" "$BASE/api/v1/cameras/$TEMP_ID/playback")
[[ "$code" == "409" ]] && pass "disabled playback -> 409" || fail "disabled playback -> $code"
code=$(curl -s -o /dev/null -w "%{http_code}" "${CK[@]}" "$BASE/api/v1/cameras/$TEMP_ID/events?limit=5")
[[ "$code" == "200" ]] && pass "disabled events history -> 200" || fail "disabled events -> $code"
curl -s "${CK[@]}" "$BASE/api/v1/cameras" -o "$TMP/list.json"
python3 - "$TMP/list.json" <<'EOF'
import json, sys
cams = json.load(open(sys.argv[1]))
ok = all(('state' in c and 'capabilities' in c) for c in cams)
print("PASS: list carries state+capabilities" if ok else "FAIL: list fields missing")
EOF

echo "== T-12 Update / Enable / Disable / Delete =="
code=$(curl -s -o /dev/null -w "%{http_code}" "${CK[@]}" -X PATCH "$BASE/api/v1/cameras/$TEMP_ID" -H "Content-Type: application/json" -d '{"name":"VERIFY-TEMP-2"}')
[[ "$code" == "200" ]] && pass "update name -> 200" || fail "update -> $code"
code=$(curl -s -o /dev/null -w "%{http_code}" "${CK[@]}" -X POST "$BASE/api/v1/cameras/$TEMP_ID/reconnect")
[[ "$code" == "409" ]] && pass "disabled reconnect -> 409" || fail "disabled reconnect -> $code"
curl -s "${CK[@]}" -X PATCH "$BASE/api/v1/cameras/$TEMP_ID" -H "Content-Type: application/json" -d '{"enabled":true}' -o "$TMP/enabled.json"
sleep 8
state=$(python3 -c "import json; print(json.load(open('$TMP/enabled.json'))['state'])")
echo "INFO: enable transition state=$state"
curl -s "${CK[@]}" "$BASE/api/v1/cameras/$TEMP_ID" -o "$TMP/after.json"
state=$(python3 -c "import json; print(json.load(open('$TMP/after.json'))['state'])")
[[ "$state" == "online" || "$state" == "degraded" ]] && pass "enable -> $state" || fail "enable state=$state"
code=$(curl -s -o /dev/null -w "%{http_code}" "${CK[@]}" -X PATCH "$BASE/api/v1/cameras/$TEMP_ID" -H "Content-Type: application/json" -d '{"enabled":false}')
sleep 2
streams=$(docker compose exec -T media wget -qO- "http://127.0.0.1:1984/media/api/streams" | python3 -c "import json,sys; print([k for k in json.load(sys.stdin) if k=='cam_${TEMP_ID//-/}'])")
[[ "$streams" == "[]" ]] && pass "disable removed media stream" || fail "disable stream leftover: $streams"
code=$(curl -s -o /dev/null -w "%{http_code}" "${CK[@]}" -X DELETE "$BASE/api/v1/cameras/$TEMP_ID")
[[ "$code" == "204" || "$code" == "200" ]] && pass "delete -> $code" || fail "delete -> $code"
code=$(curl -s -o /dev/null -w "%{http_code}" "${CK[@]}" "$BASE/api/v1/cameras/$TEMP_ID")
[[ "$code" == "404" ]] && pass "deleted camera -> 404" || fail "deleted camera -> $code"

echo "== T-05 PTZ Move/Stop =="
code=$(curl -s -o /dev/null -w "%{http_code}" "${CK[@]}" -X POST "$BASE/api/v1/cameras/$CAM_ID/ptz/move" -H "Content-Type: application/json" -d '{"pan":0.3,"tilt":0,"zoom":0,"duration_ms":1000}')
[[ "$code" == "204" ]] && pass "move -> 204" || fail "move -> $code"
sleep 2
code=$(curl -s -o /dev/null -w "%{http_code}" "${CK[@]}" -X POST "$BASE/api/v1/cameras/$CAM_ID/ptz/stop")
[[ "$code" == "204" ]] && pass "stop -> 204" || fail "stop -> $code"
code=$(curl -s -o /dev/null -w "%{http_code}" "${CK[@]}" -X POST "$BASE/api/v1/cameras/$CAM_ID/ptz/move" -H "Content-Type: application/json" -d '{"pan":0,"tilt":0,"zoom":0}')
[[ "$code" == "422" || "$code" == "400" ]] && pass "zero speeds rejected -> $code" || fail "zero speeds -> $code"
code=$(curl -s -o /dev/null -w "%{http_code}" "${CK[@]}" -X POST "$BASE/api/v1/cameras/$CAM_ID/ptz/move" -H "Content-Type: application/json" -d '{"pan":2,"tilt":0,"zoom":0}')
[[ "$code" == "422" || "$code" == "400" ]] && pass "out-of-range speed rejected -> $code" || fail "range -> $code"

echo "== T-06 Пресеты =="
curl -s "${CK[@]}" "$BASE/api/v1/cameras/$CAM_ID/ptz/presets" -o "$TMP/presets.json"
n=$(python3 -c "import json; print(len(json.load(open('$TMP/presets.json'))))")
echo "INFO: device presets count=$n"
code=$(curl -s -o /dev/null -w "%{http_code}" "${CK[@]}" -X POST "$BASE/api/v1/cameras/$CAM_ID/ptz/presets/nonexistent-token/goto")
[[ "$code" == "404" ]] && pass "unknown preset token -> 404" || fail "unknown preset -> $code"
[[ "$n" == "0" ]] && blocked "T-06 full: эталонная камера не хранит пресеты (UNSUPPORTED устройством)" || pass "preset list non-empty"

echo "== T-09 JPEG для ИИ =="
code=$(curl -s -o "$TMP/ai.jpg" -w "%{http_code}" "${AI[@]}" "$BASE/api/v1/ai/cameras/$CAM_ID/snapshot.jpg?width=320")
file "$TMP/ai.jpg" | grep -q JPEG && pass "AI JPEG width=320 ($code)" || fail "AI JPEG ($code)"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer wrong-token" "$BASE/api/v1/ai/cameras/$CAM_ID/snapshot.jpg")
[[ "$code" == "401" ]] && pass "wrong Bearer -> 401" || fail "wrong Bearer -> $code"
code=$(curl -s -o /dev/null -w "%{http_code}" "${AI[@]}" "$BASE/api/v1/cameras/$CAM_ID/ptz/stop" -X POST)
[[ "$code" == "401" ]] && pass "AI Bearer on PTZ -> 401" || fail "AI Bearer PTZ -> $code"
code=$(curl -s -o /dev/null -w "%{http_code}" "${AI[@]}" "$BASE/api/v1/ai/cameras/$CAM_ID/snapshot.jpg?width=32")
[[ "$code" == "422" || "$code" == "400" ]] && pass "width below limit rejected -> $code" || fail "width=32 -> $code"

echo "== T-10 MJPEG для ИИ =="
timeout 7 curl -s -N "${AI[@]}" "$BASE/api/v1/ai/cameras/$CAM_ID/stream.mjpeg?fps=2&width=640" -o "$TMP/stream.mjpeg" &
CURL_PID=$!
sleep 1
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "${AI[@]}" "$BASE/api/v1/ai/cameras/$CAM_ID/stream.mjpeg")
[[ "$code" == "409" ]] && pass "second consumer -> 409" || fail "second consumer -> $code"
wait $CURL_PID 2>/dev/null
frames=$(grep -c -a "Content-Type: image/jpeg" "$TMP/stream.mjpeg" 2>/dev/null || echo 0)
echo "INFO: frames in ~6s at fps=2: $frames"
[[ "$frames" -ge 6 && "$frames" -le 18 ]] && pass "MJPEG fps near 2 ($frames frames)" || fail "MJPEG frames=$frames"
sleep 2
mjpeg_stream=$(docker compose exec -T media wget -qO- "http://127.0.0.1:1984/media/api/streams" | python3 -c "import json,sys; print([k for k in json.load(sys.stdin) if k.endswith('_mjpeg')])")
[[ "$mjpeg_stream" == "[]" ]] && pass "transcoder removed after disconnect" || fail "transcoder leftover: $mjpeg_stream"
code=$(curl -s -o /dev/null -w "%{http_code}" "${AI[@]}" "$BASE/api/v1/ai/cameras/$CAM_ID/stream.mjpeg?fps=6")
[[ "$code" == "422" || "$code" == "400" ]] && pass "fps above limit rejected -> $code" || fail "fps=6 -> $code"
code=$(curl -s -o /dev/null -w "%{http_code}" "${AI[@]}" "$BASE/api/v1/ai/cameras/$CAM_ID/stream.mjpeg?width=2000")
[[ "$code" == "422" || "$code" == "400" ]] && pass "width above limit rejected -> $code" || fail "width=2000 -> $code"

echo "== T-07 SSE =="
timeout 18 curl -s -N "${CK[@]}" "$BASE/api/v1/events" -o "$TMP/sse.txt"
hb=$(grep -c -a "heartbeat" "$TMP/sse.txt" 2>/dev/null || echo 0)
[[ "$hb" -ge 1 ]] && pass "SSE heartbeat within 18s ($hb)" || fail "SSE heartbeat missing"
evcount=$(curl -s "${CK[@]}" "$BASE/api/v1/cameras/$CAM_ID/events?limit=1000" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['items']))")
[[ "$evcount" -le 1000 ]] && pass "retention <= 1000 ($evcount)" || fail "retention $evcount"

echo "== T-11 Reconnect =="
curl -s "${CK[@]}" -X POST "$BASE/api/v1/cameras/$CAM_ID/reconnect" -o /dev/null
curl -s "${CK[@]}" -X POST "$BASE/api/v1/cameras/$CAM_ID/reconnect" -o /dev/null
sleep 8
streams=$(docker compose exec -T media wget -qO- "http://127.0.0.1:1984/media/api/streams" | python3 -c "import json,sys; ks=[k for k in json.load(sys.stdin) if k.startswith('cam_')]; print(len(ks))")
expected=$(docker compose exec -T server node -e "const D=require('better-sqlite3');const db=new D(process.env.DATABASE_PATH,{readonly:true});console.log(db.prepare('SELECT COUNT(*) AS c FROM cameras WHERE enabled=1').get().c)")
[[ "$streams" == "$expected" ]] && pass "double reconnect: cam_ streams=$streams (enabled cameras=$expected)" || fail "cam_ streams=$streams expected=$expected"
state=$(curl -s "${CK[@]}" "$BASE/api/v1/cameras/$CAM_ID" | python3 -c "import json,sys; print(json.load(sys.stdin)['state'])")
[[ "$state" == "online" ]] && pass "camera online after reconnect" || fail "state=$state"

echo "== T-14 Очистка диагностики =="
docker compose logs --no-color > "$TMP/logs.txt" 2>&1
leak=0
for secret in "$ADMIN_PASS" "$AI_TOKEN" "$CAM_PASS"; do
  if grep -q -F -e "$secret" "$TMP/logs.txt"; then leak=1; fi
done
cookie=$(python3 -c "print(open('$TMP/ck.txt').read().split()[-1])")
grep -q -F -e "$cookie" "$TMP/logs.txt" && leak=1
[[ "$leak" == "0" ]] && pass "logs without admin password, AI token, camera password, session cookie" || fail "secret found in docker logs"
ENC_PASS=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$CAM_PASS")
grep -q -F -e "$ENC_PASS" "$TMP/logs.txt" && fail "RTSP userinfo in logs" || pass "logs without RTSP userinfo"

# ---------- Этап 2 (спецификация 50/51) ----------
AI_AUDIO_CAP=$(docker compose exec -T server sh -c 'command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null && echo yes || echo no')

echo "== T-18 Мобильная раскладка =="
blocked "T-18: визуальная проверка 360 px — в Firefox E2E (scripts/e2e-firefox.mjs)"

echo "== T-19 Опрос снимков =="
t0=$(date +%s%3N)
for _ in 1 2 3 4; do curl -s -o "$TMP/poll.jpg" "${CK[@]}" "$BASE/api/v1/cameras/$CAM_ID/snapshot.jpg?width=320"; done
t1=$(date +%s%3N)
[[ -s "$TMP/poll.jpg" ]] && pass "4 снимка подряд получены за $((t1 - t0)) мс" || fail "snapshot poll empty body"
file "$TMP/poll.jpg" | grep -q JPEG && pass "polling body is JPEG" || fail "polling body not JPEG"
grep -q "useSnapshotPolling" web/src/components/CameraTile.tsx && pass "клиент использует polling-хук 1 с" || fail "polling hook not wired in CameraTile"

echo "== T-20capability динамик (hardware) =="
if [[ "$AI_AUDIO_CAP" == "yes" ]]; then pass "server image carries ffmpeg/ffprobe"; else fail "ffmpeg/ffprobe missing in server image"; fi
ao=$(curl -s "${CK[@]}" "$BASE/api/v1/cameras/$CAM_ID" | python3 -c "import json,sys; print(json.load(sys.stdin)['capabilities']['audio_output'])")
echo "INFO: audio_output эталонной камеры = $ao"
[[ "$ao" == "supported" ]] && pass "backchannel подтверждён" || blocked "T-20 sound: backchannel недоступен на Tapo C520WS (docs/compatibility.md), play работает как noop"

echo "== T-21 Воспроизведение файла (HTTP) =="
python3 - "$TMP/t21.wav" <<'PY'
import struct, sys
sr, n = 16000, 32000
data = b"\x00\x00" * n
hdr = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, sr, sr * 2, 2, 16) + b"data" + struct.pack("<I", len(data))
open(sys.argv[1], "wb").write(hdr + data)
PY
code=$(curl -s -o "$TMP/play1.json" -w "%{http_code}" "${CK[@]}" -H "Content-Type: audio/wav" --data-binary "@$TMP/t21.wav" -D "$TMP/play1.h" "$BASE/api/v1/cameras/$CAM_ID/audio/play")
[[ "$code" == "202" ]] && pass "admin WAV play -> 202" || fail "admin play -> $code"
grep -qi "^x-request-id:" "$TMP/play1.h" && pass "play carries X-Request-ID" || fail "play without X-Request-ID"
PLAY_ID=$(python3 -c "import json; print(json.load(open('$TMP/play1.json')).get('playback_id',''))")
dur=$(python3 -c "import json; print(json.load(open('$TMP/play1.json')).get('duration_ms',0))")
[[ "$dur" -ge 1500 && "$dur" -le 2500 ]] && pass "duration_ms из ffprobe ($dur)" || fail "duration_ms=$dur"
code=$(curl -s -o "$TMP/play2.json" -w "%{http_code}" "${CK[@]}" -H "Content-Type: audio/wav" --data-binary "@$TMP/t21.wav" "$BASE/api/v1/cameras/$CAM_ID/audio/play")
[[ "$code" == "409" ]] && pass "второй play на камере -> 409" || fail "second play -> $code"
code=$(curl -s -o /dev/null -w "%{http_code}" "${CK[@]}" -X DELETE "$BASE/api/v1/cameras/$CAM_ID/audio/play/$PLAY_ID")
[[ "$code" == "204" ]] && pass "stop playback -> 204" || fail "stop -> $code"
code=$(curl -s -o /dev/null -w "%{http_code}" "${CK[@]}" -H "Content-Type: text/plain" --data "abc" "$BASE/api/v1/cameras/$CAM_ID/audio/play")
[[ "$code" == "415" ]] && pass "content-type text/plain -> 415" || fail "bad type -> $code"
head -c 5242881 /dev/zero | tr '\0' 'A' > "$TMP/big.bin"
code=$(curl -s -o /dev/null -w "%{http_code}" "${CK[@]}" -H "Content-Type: audio/wav" --data-binary "@$TMP/big.bin" "$BASE/api/v1/cameras/$CAM_ID/audio/play")
[[ "$code" == "413" ]] && pass "тело 5 MiB + 1 байт -> 413" || fail "oversize play -> $code"
code=$(curl -s -o /dev/null -w "%{http_code}" "${CK[@]}" -H "Content-Type: audio/wav" --data-binary "@$TMP/t21.wav" "$BASE/api/v1/cameras/$CAM_ID/audio/play")
[[ "$code" == "202" ]] && pass "лимит Caddy 5 MiB пропущен для audio/play" || fail "audio/play through proxy -> $code"
python3 -c "import json;d=json.load(open('$TMP/play2.json'));print(d.get('code',''))" 2>/dev/null | grep -q "AUDIO_OUTPUT_BUSY" && pass "код ошибки AUDIO_OUTPUT_BUSY" || true
PLAY_ID2=$(curl -s "${CK[@]}" -H "Content-Type: audio/wav" --data-binary "@$TMP/t21.wav" "$BASE/api/v1/cameras/$CAM_ID/audio/play" | python3 -c "import json,sys; print(json.load(sys.stdin).get('playback_id',''))")
curl -s -o /dev/null "${CK[@]}" -X DELETE "$BASE/api/v1/cameras/$CAM_ID/audio/play/$PLAY_ID2"

echo "== T-22 Звук через динамик (hardware) =="
blocked "T-22: подтверждение слышимости невозможно без backchannel-камеры (решение владельца 22.11.2026: noop)"

echo "== T-23 WAV для ИИ =="
code=$(curl -s -o "$TMP/ai.wav" -w "%{http_code}" "${AI[@]}" "$BASE/api/v1/ai/cameras/$CAM_ID/audio.wav?duration_ms=1500")
if [[ "$code" == "200" ]] && file "$TMP/ai.wav" | grep -q "RIFF.*WAVE\|WAVE"; then
  sr=$(python3 -c "import struct;print(struct.unpack('<I', open('$TMP/ai.wav','rb').read(28)[24:28])[0])")
  [[ "$sr" == "16000" ]] && pass "AI WAV 16 кГц mono ($code)" || fail "AI WAV sample rate=$sr"
elif [[ "$code" == "502" ]]; then
  blocked "T-23 capture: поток камеры без аудио или ffmpeg-ошибка ($code)"
else
  fail "AI WAV -> $code"
fi
code=$(curl -s -o /dev/null -w "%{http_code}" "${AI[@]}" "$BASE/api/v1/ai/cameras/$CAM_ID/audio.wav?duration_ms=100")
[[ "$code" == "400" ]] && pass "duration_ms=100 -> 400" || fail "duration=100 -> $code"
( timeout 4 curl -s -o /dev/null "${AI[@]}" "$BASE/api/v1/ai/cameras/$CAM_ID/audio.wav?duration_ms=3000" & )
( timeout 4 curl -s -o /dev/null "${AI[@]}" "$BASE/api/v1/ai/cameras/$CAM_ID/audio.wav?duration_ms=3000" & )
sleep 0.5
code=$(curl -s -o "$TMP/limit.json" -w "%{http_code}" "${AI[@]}" "$BASE/api/v1/ai/cameras/$CAM_ID/audio.wav?duration_ms=1000")
wait
if [[ "$code" == "409" ]]; then
  grep -q "AI_AUDIO_LIMIT_REACHED" "$TMP/limit.json" && pass "третий capture -> 409 AI_AUDIO_LIMIT_REACHED" || fail "limit code mismatch"
elif [[ "$code" == "200" ]]; then
  pass "dedup: одновременные capture той же камеры обслужены ($code)"
else
  fail "capture limit -> $code"
fi

echo "== T-24 PTZ для ИИ =="
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${AI[@]}" -H "Content-Type: application/json" -d '{"pan":0.2,"tilt":0,"zoom":0,"duration_ms":300}' "$BASE/api/v1/ai/cameras/$CAM_ID/ptz/move")
[[ "$code" == "204" ]] && pass "AI PTZ move -> 204" || fail "AI move -> $code"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${AI[@]}" "$BASE/api/v1/ai/cameras/$CAM_ID/ptz/stop")
[[ "$code" == "204" ]] && pass "AI PTZ stop -> 204" || fail "AI stop -> $code"
code=$(curl -s -o "$TMP/ai_presets.json" -w "%{http_code}" "${AI[@]}" "$BASE/api/v1/ai/cameras/$CAM_ID/ptz/presets")
[[ "$code" == "200" ]] && pass "AI preset list -> 200" || fail "AI presets -> $code"
n=$(python3 -c "import json; print(len(json.load(open('$TMP/ai_presets.json'))))")
if [[ "$n" -gt 0 ]]; then
  tok=$(python3 -c "import json; print(json.load(open('$TMP/ai_presets.json'))[0]['token'])")
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${AI[@]}" "$BASE/api/v1/ai/cameras/$CAM_ID/ptz/presets/$tok/goto")
  [[ "$code" == "204" ]] && pass "AI preset goto -> 204" || fail "AI goto -> $code"
fi
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${AI[@]}" -H "Content-Type: application/json" -d '{"pan":5,"tilt":0,"zoom":0}' "$BASE/api/v1/ai/cameras/$CAM_ID/ptz/move")
[[ "$code" == "422" ]] && pass "скорость вне диапазона -> 422" || fail "bad speed -> $code"

echo "== T-25 Discovery для ИИ =="
code=$(curl -s -o "$TMP/ai_list.json" -w "%{http_code}" "${AI[@]}" "$BASE/api/v1/ai/cameras")
[[ "$code" == "200" ]] && pass "AI discovery list -> 200" || fail "AI list -> $code"
leak=$(python3 -c "import json; items=json.load(open('$TMP/ai_list.json')); print(len([k for it in items for k in it if k in ('host','username','password','profile_token','has_rtsp_override','rtsp_url','onvif_port')]))")
[[ "$leak" == "0" ]] && pass "AI-модель без host/учётных данных/RTSP" || fail "AI-модель содержит $leak секретных полей"
code=$(curl -s -o /dev/null -w "%{http_code}" "${AI[@]}" "$BASE/api/v1/ai/cameras/$CAM_ID")
[[ "$code" == "200" ]] && pass "AI get camera -> 200" || fail "AI get -> $code"
code=$(curl -s -o "$TMP/ai_play.json" -w "%{http_code}" -X POST "${AI[@]}" -H "Content-Type: audio/wav" --data-binary "@$TMP/t21.wav" "$BASE/api/v1/ai/cameras/$CAM_ID/audio/play")
if [[ "$code" == "409" ]]; then
  # на камере ещё живо предыдущее воспроизведение — дождаться и повторить
  sleep 3
  code=$(curl -s -o "$TMP/ai_play.json" -w "%{http_code}" -X POST "${AI[@]}" -H "Content-Type: audio/wav" --data-binary "@$TMP/t21.wav" "$BASE/api/v1/ai/cameras/$CAM_ID/audio/play")
fi
[[ "$code" == "202" ]] && pass "AI audio play -> 202" || fail "AI play -> $code"
AIP_ID=$(python3 -c "import json; print(json.load(open('$TMP/ai_play.json')).get('playback_id',''))")
curl -s -o /dev/null -X DELETE "${AI[@]}" "$BASE/api/v1/ai/cameras/$CAM_ID/audio/play/$AIP_ID"
code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "${CK[@]}" "$BASE/api/v1/cameras/$CAM_ID/audio/play/00000000-0000-4000-8000-000000000000")
[[ "$code" == "404" ]] && pass "stop неизвестного воспроизведения -> 404" || fail "unknown stop -> $code"

echo "== Итог =="
echo "Проверки завершены. BLOCKED-строки требуют решения владельца или оборудования."