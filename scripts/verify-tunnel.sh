#!/usr/bin/env bash
# T-15: сетевой эксперимент через OpenTunnel (спецификация 30, раздел 8.2).
# Запуск: ./scripts/verify-tunnel.sh <https-base> [lan-base]
# Вывод: строки PASS/FAIL с фактами. Секреты не печатаются.
set -uo pipefail
cd "$(dirname "$0")/.."
T="${1:?usage: verify-tunnel.sh <https-base> [lan-base]}"
LAN="${2:-http://127.0.0.1:8080}"
ADMIN_PASS=$(cat secrets/admin_password)
AI_TOKEN=$(cat secrets/ai_api_token)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; }

THOST=$(python3 -c "import sys,urllib.parse;print(urllib.parse.urlparse(sys.argv[1]).hostname)" "$T")
LHOST=$(python3 -c "import sys,urllib.parse;print(urllib.parse.urlparse(sys.argv[1]).hostname)" "$LAN")

login() {
  curl -s -c "$2" -D "$3" -o /dev/null -w "%{http_code}" -X POST "$1/api/v1/auth/session" \
    -H "Content-Type: application/json" -H "Origin: $1" \
    -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASS\"}"
}
codeT=$(login "$T" "$TMP/ckT" "$TMP/hT")
codeL=$(login "$LAN" "$TMP/ckL" "$TMP/hL")
[[ "$codeT" == "200" && "$codeL" == "200" ]] && pass "2 login via tunnel and LAN: 200/200" || fail "2 login tunnel=$codeT lan=$codeL"

# 1. HTTPS GET статики.
read -r code ctype < <(curl -s -o "$TMP/index.html" -w "%{http_code} %{content_type}" "$T/")
[[ "$code" == "200" && "$ctype" == text/html* ]] && pass "1 HTTPS static: $code $ctype" || fail "1 static: $code $ctype"

# 2 и 9. Attributes cookie: Secure по режиму стенда; tunnel не меняет attributes.
SECURE_MODE=$(docker compose exec -T server printenv SESSION_COOKIE_SECURE)
cookieT=$(grep -i "^set-cookie:" "$TMP/hT" | head -1 | tr -d '\r')
cookieL=$(grep -i "^set-cookie:" "$TMP/hL" | head -1 | tr -d '\r')
echo "$cookieT" | grep -qi "HttpOnly" && echo "$cookieT" | grep -qi "SameSite" && pass "2 cookie HttpOnly+SameSite via tunnel" || fail "2 cookie attributes: $cookieT"
if [[ "$SECURE_MODE" == "true" ]]; then
  echo "$cookieT" | grep -qi "Secure" && pass "2 Secure cookie in secure mode" || fail "2 no Secure in secure mode"
else
  echo "$cookieT" | grep -qi "Secure" && fail "2 Secure present in plain mode" || pass "2 no Secure in plain LAN mode (expected)"
fi
attrsT=$(python3 -c "import sys; print(sorted(p.strip().split('=')[0].lower() for p in sys.argv[1].split(':',1)[1].split(';')[1:]))" "$cookieT")
attrsL=$(python3 -c "import sys; print(sorted(p.strip().split('=')[0].lower() for p in sys.argv[1].split(':',1)[1].split(';')[1:]))" "$cookieL")
[[ "$attrsT" == "$attrsL" ]] && pass "9 cookie attributes identical tunnel vs LAN: $attrsT" || fail "9 attributes differ: $attrsT vs $attrsL"

CKT=(-b "$TMP/ckT" -H "Origin: $T")
CAM_ID=$(curl -s "${CKT[@]}" "$T/api/v1/cameras" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])")
CAM_HEX=${CAM_ID//-/}

# 3. JSON POST с unicode-телом без потери.
OLD_NAME=$(curl -s "${CKT[@]}" "$T/api/v1/cameras" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['name'])")
NEW_NAME="T-15 проверка тела ✓"
code=$(curl -s -o "$TMP/patch.json" -w "%{http_code}" "${CKT[@]}" -X PATCH "$T/api/v1/cameras/$CAM_ID" -H "Content-Type: application/json" -d "{\"name\":\"$NEW_NAME\"}")
GOT=$(python3 -c "import json; print(json.load(open('$TMP/patch.json'))['name'])")
[[ "$code" == "200" && "$GOT" == "$NEW_NAME" ]] && pass "3 JSON POST unicode body intact" || fail "3 body: $code got=$GOT"
curl -s -o /dev/null "${CKT[@]}" -X PATCH "$T/api/v1/cameras/$CAM_ID" -H "Content-Type: application/json" -d "{\"name\":\"$OLD_NAME\"}"

# 4. WSS signaling: offer уходит, ответ go2rtc приходит через tunnel.
COOKIE_T=$(sed 's/^#HttpOnly_//' "$TMP/ckT" | awk -v d="$THOST" '$1==d{print $6"="$7}' | head -1)
T="$T" COOKIE_T="$COOKIE_T" CAM_HEX="$CAM_HEX" node <<'EOF'
const base = process.env.T;
const ws = new WebSocket(base.replace('https://', 'wss://') + '/media/api/ws?src=cam_' + process.env.CAM_HEX, {
  headers: { Cookie: process.env.COOKIE_T, Origin: base },
});
const sdp = [
  'v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96', 'c=IN IP4 0.0.0.0',
  'a=rtpmap:96 H264/90000', 'a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
  'a=ice-ufrag:t15u', 'a=ice-pwd:t15passwordt15passwordt15',
  'a=fingerprint:sha-256 ' + Array.from({ length: 32 }, () => '00').join(':'),
  'a=setup:actpass', 'a=mid:0', 'a=recvonly', '',
].join('\r\n');
const timer = setTimeout(() => { console.log('FAIL: 4 WSS no answer in 10s'); process.exit(1); }, 10000);
ws.onopen = () => ws.send(JSON.stringify({ type: 'webrtc/offer', value: sdp }));
ws.onmessage = (ev) => {
  clearTimeout(timer);
  const kind = String(ev.data).slice(0, 60);
  console.log('PASS: 4 WSS signaling answer via tunnel: ' + kind.replace(/\s+/g, ' '));
  ws.close();
  process.exit(0);
};
ws.onerror = () => { clearTimeout(timer); console.log('FAIL: 4 WSS error'); process.exit(1); };
EOF

# 5. SSE и heartbeat более 2 минут.
curl -s -N "${CKT[@]}" "$T/api/v1/events" > "$TMP/sse.log" &
SSE_PID=$!
sleep 130
kill "$SSE_PID" 2>/dev/null
HB=$(grep -c -i "heartbeat" "$TMP/sse.log")
[[ "$HB" -ge 2 ]] && pass "5 SSE alive 130s, heartbeats=$HB" || fail "5 SSE heartbeats=$HB"

# 6. HLS playlist и сегменты.
code=$(curl -s -o "$TMP/pl.m3u8" -w "%{http_code}" "${CKT[@]}" "$T/media/api/stream.m3u8?src=cam_$CAM_HEX&mp4")
SEG=$(python3 -c "
import sys
from urllib.parse import urljoin
lines = [l.strip() for l in open('$TMP/pl.m3u8') if l.strip() and not l.startswith('#')]
print(urljoin('$T/media/api/', lines[0]) if lines else '')
")
scode=$(curl -s -o "$TMP/seg.m4s" -w "%{http_code}" "${CKT[@]}" "$SEG")
[[ "$code" == "200" && "$scode" == "200" ]] && pass "6 HLS playlist+segment via tunnel: $code/$scode" || fail "6 HLS: $code/$scode seg=$SEG"

# 7 и 8. MJPEG не менее 2 минут, одновременно API.
curl -s -N -H "Authorization: Bearer $AI_TOKEN" "$T/api/v1/ai/cameras/$CAM_ID/stream.mjpeg" > "$TMP/mjpeg.bin" &
MJ_PID=$!
sleep 20
acode=$(curl -s -o /dev/null -w "%{http_code}" "${CKT[@]}" "$T/api/v1/cameras")
[[ "$acode" == "200" ]] && pass "8 API concurrent with MJPEG: $acode" || fail "8 API during MJPEG: $acode"
sleep 110
kill "$MJ_PID" 2>/dev/null
FRAMES=$(python3 -c "print(open('$TMP/mjpeg.bin','rb').read().count(b'\xff\xd8\xff'))")
[[ "$FRAMES" -ge 200 ]] && pass "7 MJPEG 130s frames=$FRAMES" || fail "7 MJPEG frames=$FRAMES"

# 10. Reconnect tunnel: маршрут пересоздаётся, сервис отвечает снова.
opentunnel route remove cctv >/dev/null 2>&1
sleep 2
opentunnel route add 8080 --name cctv > "$TMP/route.txt" 2>&1
sleep 3
rcode=$(curl -s -o /dev/null -w "%{http_code}" "$T/")
lcode=$(login "$T" "$TMP/ckT2" "$TMP/hT2")
curl -s -N -b "$TMP/ckT2" -H "Origin: $T" "$T/api/v1/events" > "$TMP/sse2.log" &
SSE2_PID=$!
sleep 25
kill "$SSE2_PID" 2>/dev/null
HB2=$(grep -c -i "heartbeat" "$TMP/sse2.log")
[[ "$rcode" == "200" && "$lcode" == "200" && "$HB2" -ge 1 ]] && pass "10 after tunnel reconnect: static=$rcode login=$lcode heartbeats=$HB2" || fail "10 reconnect: static=$rcode login=$lcode hb=$HB2"

echo "== Итог T-15 =="