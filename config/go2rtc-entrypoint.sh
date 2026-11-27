#!/bin/sh
# Entrypoint медиашлюза: подставляет LAN-кандидат из WEBRTC_LAN_CANDIDATE и WEBRTC_LAN_PORT.
# Порт по умолчанию 8555; в microk8s внешний NodePort задаётся через WEBRTC_LAN_PORT.
# Без WEBRTC_LAN_CANDIDATE остаётся значение из config/go2rtc.yaml.
# Streams go2rtc дописывает в тот же файл через PatchConfig — они сохраняются.
set -eu
WEBRTC_LAN_PORT="${WEBRTC_LAN_PORT:-8555}"
if [ -n "${WEBRTC_LAN_CANDIDATE:-}" ]; then
  awk -v cand="$WEBRTC_LAN_CANDIDATE" -v port="$WEBRTC_LAN_PORT" '
    /^  candidates:/ { print; print "    - " cand ":" port; skip = 1; next }
    skip && /^    - / { next }
    skip && /^  - / { next }
    { skip = 0; print }
  ' /config/go2rtc.yaml > /config/go2rtc.yaml.tmp
  cat /config/go2rtc.yaml.tmp > /config/go2rtc.yaml
  rm -f /config/go2rtc.yaml.tmp
fi
exec /sbin/tini -- go2rtc -config /config/go2rtc.yaml