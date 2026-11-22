# syntax=docker/dockerfile:1

FROM node:22.16.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --workspace web --include-workspace-root=false --no-audit --no-fund
COPY web/ web/
RUN npm run build --workspace web

FROM nginx:1.27.4-alpine
COPY --from=build /app/web/dist /usr/share/nginx/html
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
