# syntax=docker/dockerfile:1
# Сборка mcp-образа из корня монорепозитория (нужен package-lock.json).

FROM node:22.23.5-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY mcp/package.json mcp/
RUN npm ci --workspace mcp --include-workspace-root=false --no-audit --no-fund
COPY mcp/ mcp/
RUN npm run build --workspace mcp

FROM node:22.23.5-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY mcp/package.json mcp/
RUN npm ci --workspace mcp --include-workspace-root=false --omit=dev --no-audit --no-fund

FROM node:22.23.5-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/mcp
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/mcp/node_modules ./node_modules
COPY --from=build /app/mcp/dist ./dist
COPY mcp/package.json ./package.json
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
