# syntax=docker/dockerfile:1
# Сборка server-образа из корня монорепозитория (нужен package-lock.json).

FROM node:22.16.0-bookworm-slim AS build
WORKDIR /app
# Сборка нативных модулей (better-sqlite3, argon2), если prebuild недоступен.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY mcp/package.json mcp/
RUN npm ci --workspace server --include-workspace-root=false --no-audit --no-fund
COPY server/ server/
RUN npm run build --workspace server

FROM node:22.16.0-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY mcp/package.json mcp/
RUN npm ci --workspace server --include-workspace-root=false --omit=dev --no-audit --no-fund

FROM node:22.16.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/server
# FFmpeg/ffprobe нужны звуковым сервисам сервера (захват WAV для ИИ, проверка длительности).
# Версия зафиксирована под bookworm (конвенция: точные версии зависимостей).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg=7:5.1.9-0+deb12u1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/server/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
COPY server/drizzle ./drizzle
COPY server/scripts ./scripts
COPY server/package.json ./package.json
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 8000
CMD ["node", "dist/index.js"]
