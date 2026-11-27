"""face-check: отвечает, есть ли лицо человека в свежем кадре камеры.

GET /check?camera_id=<uuid>  -> 200 {"camera_id":..., "face": bool, "score": float}
GET /healthz                 -> 200 {"status": "ok"}

Кадр берётся у сервера (GET /api/v1/ai/cameras/{id}/snapshot.jpg) по AI-токену,
лицо ищет YuNet (OpenCV FaceDetectorYN). Сервис stateless: ничего не помнит.
Спецификация: docs/specs/55-face-presence-check.md.
"""

import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import cv2
import numpy
import requests

CAMERA_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

API_BASE = os.environ.get("CAMERA_API_BASE", "http://server:8000")
TOKEN_FILE = os.environ.get("AI_API_TOKEN_FILE", "/run/secrets/ai_api_token")
MODEL_PATH = os.environ.get("FACE_MODEL_FILE", "/app/models/face_detection_yunet_2023mar.onnx")
PORT = int(os.environ.get("FACE_CHECK_PORT", "8000"))

# 1920x1080: лицо сидящего в метре от камеры человека слишком мало для 1280x704
# (замер 24.11.2026: 1280 — пропуск, 1920 — score 0,84; docs/openhab.md §6).
INPUT_SIZE = (1920, 1080)
SNAPSHOT_WIDTH = 1920
SCORE_THRESHOLD = 0.6
NMS_THRESHOLD = 0.3
HTTP_TIMEOUT_S = 8.0

_detector = None
_token = None
# FaceDetectorYN не потокобезопасен: ThreadingHTTPServer может вызвать detect() параллельно.
_detect_lock = threading.Lock()


def detector():
    global _detector
    if _detector is None:
        _detector = cv2.FaceDetectorYN.create(
            MODEL_PATH, "", INPUT_SIZE, SCORE_THRESHOLD, NMS_THRESHOLD, 500
        )
    return _detector


def token() -> str:
    global _token
    if _token is None:
        with open(TOKEN_FILE, encoding="utf-8") as handle:
            _token = handle.read().strip()
    return _token


def check_face(camera_id: str) -> dict:
    response = requests.get(
        f"{API_BASE}/api/v1/ai/cameras/{camera_id}/snapshot.jpg",
        params={"width": SNAPSHOT_WIDTH},
        headers={"Authorization": f"Bearer {token()}"},
        timeout=HTTP_TIMEOUT_S,
    )
    response.raise_for_status()
    img = cv2.imdecode(numpy.frombuffer(response.content, dtype=numpy.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("snapshot decode failed")
    if img.shape[1] != INPUT_SIZE[0] or img.shape[0] != INPUT_SIZE[1]:
        img = cv2.resize(img, INPUT_SIZE)
    with _detect_lock:
        _, faces = detector().detect(img)
    best = 0.0
    for face in faces if faces is not None else []:
        best = max(best, float(face[14]))
    return {"camera_id": camera_id, "face": best >= SCORE_THRESHOLD, "score": round(best, 3)}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 (stdlib API)
        route = urlparse(self.path)
        if route.path == "/healthz":
            self._send(200, {"status": "ok"})
            return
        if route.path != "/check":
            self._send(404, {"error": "not_found"})
            return
        camera_id = (parse_qs(route.query).get("camera_id") or [""])[0]
        if not CAMERA_ID_RE.match(camera_id):
            self._send(400, {"error": "bad_camera_id"})
            return
        started = time.perf_counter()
        try:
            result = check_face(camera_id)
        except (requests.RequestException, ValueError, OSError) as error:
            print(f"check failed camera={camera_id}: {type(error).__name__}", flush=True)
            self._send(502, {"error": "snapshot_failed"})
            return
        took_ms = (time.perf_counter() - started) * 1000
        print(
            f"check camera={camera_id[:8]} face={result['face']} "
            f"score={result['score']} ms={took_ms:.0f}",
            flush=True,
        )
        self._send(200, result)

    def log_message(self, fmt: str, *args) -> None:
        return


def main() -> None:
    detector()
    print(f"face-check listening on :{PORT}, input={INPUT_SIZE}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
