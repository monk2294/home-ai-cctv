#!/bin/sh
# Entrypoint медиашлюза: подставляет LAN-кандидат WebRTC из WEBRTC_LAN_CANDIDATE (спецификация 40 §4).
# Без env остаётся значение из config/go2rtc.yaml (документированный ручной шаг).
# Streams go2rtc дописывает в тот же файл через PatchConfig — они сохраняются.
set -eu
if [ -n "${WEBRTC_LAN_CANDIDATE:-}" ]; then
  awk -v cand="$WEBRTC_LAN_CANDIDATE" '
    /^  candidates:/ { print; print "    - " cand ":8555"; skip = 1; next }
    skip && /^    - / { next }
    skip && /^  - / { next }
    { skip = 0; print }
  ' /config/go2rtc.yaml > /config/go2rtc.yaml.tmp
  cat /config/go2rtc.yaml.tmp > /config/go2rtc.yaml
  rm -f /config/go2rtc.yaml.tmp
fi
exec /sbin/tini -- go2rtc -config /config/go2rtc.yaml