# AGENTS.md

Agent instructions for home-ai-cctv. User-facing docs live in `docs/` (Russian). Keep this file in sync when structure or commands change.

## Project

Local IP-camera platform: Node.js 22 + Fastify + SQLite (Drizzle) server, React + Vite web client, Caddy reverse proxy, go2rtc media gateway. Up to 4 cameras, 1 admin, 1 AI agent (separate Bearer token). Source of truth for behavior: `docs/specs/` + `docs/specs/contracts/api-v1.openapi.yaml`.

## Layout

- `server/` — Fastify API. `src/db` (better-sqlite3 + Drizzle, migrations in `server/drizzle/`), `src/auth`, `src/http`. Camera stack: `src/onvif` (adapter interface + `onvif` lib impl), `src/cameras` (repository + manager), `src/media` (go2rtc client), `src/events` (store + SSE hub), `src/ptz`, `src/ai` (MJPEG registry), `src/audio` (AI WAV capture, file playback via go2rtc; ffprobe/ffmpeg pinned in the server image). Tests: `server/test/` (node:test + tsx, run via `node --import tsx --test`).
- `web/` — React 19 SPA (React Router 7, CSS Modules, hls.js). Screens per `docs/specs/20-web-client.md`: `src/screens/` (login, cameras grid, camera detail, add wizard, settings, events, 404), `src/player/VideoPlayer.tsx` (Auto/WebRTC/HLS with fallback), `src/ptz/PtzPanel.tsx`, `src/audio/AudioPanel.tsx` (push-to-talk mic + WAV/MP3 playback on camera speaker), `src/hooks/useSnapshotPolling.ts` (1 s snapshot polling with viewport/visibility gating), `src/events/EventsContext.tsx` (one EventSource per app), `src/api/client.ts` (typed fetch wrapper), `src/auth/AuthContext.tsx`. Mobile layout via CSS breakpoints (≤720 px). Theme tokens from Kimi Design in `src/theme.css`; icons extracted from the design in `src/assets/icons/`. API types generated into `src/generated/api-v1.d.ts`.
- `mcp/` — MCP-сервер для ИИ-агентов (спецификация 60): stateless Streamable HTTP (`@modelcontextprotocol/sdk`, zod). Тонкая обёртка над AI HTTP API: 10 инструментов (cameras_list, camera_get, camera_snapshot, camera_listen, camera_play_audio, camera_stop_audio, ptz_move, ptz_stop, ptz_presets, ptz_goto). Auth — тот же AI Bearer-токен (timing-safe проверка в `src/http-server.ts`); WAV на play принимается base64 (≤ 5 МиБ), декодируется и уходит в server как `audio/wav`. Tests: `mcp/test/` (node:test, мок fetch).
- `config/` — Caddyfile (route allowlist, forward_auth for media; маршрут `/mcp` с лимитом тела 8 МиБ для MCP) and go2rtc.example.yaml (`api.base_path: /media`, no streams). Runtime `go2rtc.yaml` is created by init-secrets (0600, gitignored); go2rtc persists camera streams with credentials into it.
- `scripts/init-secrets.sh` — generates `secrets/` (0600): admin_password, ai_api_token, camera_encryption_key; creates runtime `config/go2rtc.yaml` from the example (0600) if absent.
- `scripts/backup.sh` / `scripts/restore.sh` — WAL-consistent SQLite backup via backup API (inside server container, `server/scripts/backup.mjs`), key + configs + image versions; restore replaces DB and key, checks readiness. Tested on a separate compose project (T-16).
- `scripts/verify-stack.sh` — runs T-01–T-25 checks against the live stack, prints PASS/FAIL/BLOCKED; camera params are read from the running DB, no secrets in the script. Results matrix: `docs/verification.md`.
- `scripts/e2e-firefox.mjs` — interactive Firefox E2E over geckodriver/WebDriver (no Playwright): login, grid, WebRTC/HLS player, PTZ, presets, snapshot polling, push-to-talk audio panel, 390 px mobile layout, SSE, logout. Needs non-snap geckodriver and a mozilla Firefox build (`E2E_FIREFOX`); tooling notes in `docs/verification.md` §3.3.
- `scripts/verify-tunnel.sh` — T-15 network experiment through OpenTunnel (spec 30 §8.2): static, login/Secure cookie, JSON body, WSS, SSE, HLS, MJPEG, concurrency, cookie attributes, reconnect.
- `scripts/load-test.mjs` — T-17 load run: 2 headless Firefox viewers (WebRTC) + 1 MJPEG consumer per camera, per-minute RSS/fd/ffmpeg sampling, CSV in `docs/evidence/`, verdict LOAD_STATUS.
- `server/scripts/reset-admin-password.mjs` — admin password recovery via `docker compose exec server node scripts/reset-admin-password.mjs` (TTY, no echo, kills sessions).
- `docker-compose.yaml` — proxy, web, server, media, mcp; networks `edge` (proxy+web) and `backend` (proxy+server+media+mcp).

## Commands

- `npm install` (workspaces: server, web, mcp)
- `npm test`, `npm run typecheck`, `npm run build`
- `npm run dev` — server hot-reload; `npm run dev --workspace web` — Vite on :5173 (proxies /api, /media to :8080)
- `npm run generate:api` — regenerate `server/src/generated/api-v1.d.ts` from the OpenAPI contract
- `npm run db:generate --workspace server` — Drizzle SQL migration after changing `server/src/db/schema.ts`
- `E2E_FIREFOX=$HOME/opt/firefox/firefox node scripts/e2e-firefox.mjs` — Firefox E2E against the live stack, screenshots to `docs/evidence/`
- `./scripts/verify-tunnel.sh <https-base>` — T-15 network experiment through OpenTunnel (spec 30 §8.2), ~5 min
- `node scripts/load-test.mjs [minutes]` — T-17 load run: 2 Firefox viewers + 1 MJPEG consumer per camera, RSS/fd sampling, CSV in `docs/evidence/`
- `./scripts/init-secrets.sh && docker compose build && docker compose up -d`

## Conventions

- Node.js pinned in `.nvmrc` and Dockerfiles; all dependency versions exact (no ranges, no `latest` images). Server production image pins `ffmpeg=7:5.1.9-0+deb12u1` (Debian bookworm) for the audio services.
- Server is strict TypeScript, ESM (`"type": "module"`, NodeNext). RFC 3339 UTC timestamps (`Z`). Every API response carries `X-Request-ID`; error bodies match the OpenAPI `Error` schema.
- Never log or return secrets: camera passwords, Bearer/session tokens, RTSP userinfo. Session tokens are stored as SHA-256; camera secrets as AES-256-GCM (key from `CAMERA_ENCRYPTION_KEY_FILE`).
- ONVIF library is `onvif` (agsh/onvif, Promise API) — business logic depends only on `src/cameras/adapter.ts`; adapters are selected automatically by `src/cameras/adapter-registry.ts` (Tapo first, generic ONVIF second).
- go2rtc stream names: `cam_<uuid-hex>` (per camera), `cam_<uuid-hex>_mjpeg` (AI transcoder, 1 consumer/camera), `probe_<random>` (temp, TTL 30 s). go2rtc config is writable — the streams API persists to `go2rtc.yaml` via PatchConfig. The runtime file carries camera credentials: mode 0600, gitignored; the repo keeps only `go2rtc.example.yaml`.
- Camera-name uniqueness is checked in code (`toLowerCase`) — SQLite COLLATE NOCASE does not cover Cyrillic.
- Admin guards for camera/PTZ/event routes run as `onRequest` hooks (before body validation, anonymous always gets 401).
- Web player: go2rtc WebRTC signaling V1 (`webrtc/offer` with raw SDP, candidates as strings, answer with `sdpMid: '0'`). go2rtc must advertise a LAN-reachable ICE candidate (`webrtc.candidates` in `config/go2rtc.yaml`), otherwise WebRTC falls back to HLS.
- Design source: `design/home-cctv.kui.fig` (Kimi Design export). Extracted spec and icons live in `web/src/theme.css` and `web/src/assets/icons/`; archive/recording UI from the design is out of MVP scope.
- Ajv validation failures map to 422 `VALIDATION_ERROR`; unknown routes to 404 `NOT_FOUND`.
- Run `npm test` and `npm run typecheck` before claiming anything works.
