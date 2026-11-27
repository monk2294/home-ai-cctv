# Запуск в microk8s

Манифесты `deploy/microk8s/` создают шесть Deployment: `proxy`, `web`, `server`, `media`, `mcp`, `presence-check`. Все ресурсы находятся в namespace `home-ai-cctv`.

## Сеть и данные

- Caddy доступен на `30081/tcp`. Веб-клиент: `http://<server>:30081/video/`.
- WebRTC доступен на `30555/tcp+udp`.
- API go2rtc, server, web и MCP доступны только через ClusterIP.
- `proxy` слушает два порта: `8080` публикуется как NodePort `30081`, `8081` доступен только через ClusterIP Service `proxy-hooks`. Listener `8081` отдаёт `GET /api/v1/ai/cameras/*/snapshot.jpg` и подставляет токен AI API из Secret.
- NetworkPolicy `media-access` разрешает API go2rtc только для `server`, `proxy` и kubelet. WebRTC остаётся доступен браузерам.
- SQLite хранится в PVC `server-data`.
- Рабочий `go2rtc.yaml` хранится в PVC `media-config`. Файл содержит учётные данные камер и остаётся изменяемым для go2rtc.
- Перед запуском замените `WEBRTC_LAN_CANDIDATE` в `deploy/microk8s/workloads.yaml` на LAN IP сервера.

## Первичный запуск

Требования: microk8s с addons `dns` и `hostpath-storage`, Docker для сборки и импорта images.

1. Создайте секреты:

   ```bash
   ./scripts/init-secrets.sh
   ```

2. Соберите images и импортируйте их в containerd microk8s:

   ```bash
   docker compose build server web mcp
   docker build -t home-ai-cctv/presence-check:0.3.0 presence/
   docker save home-ai-cctv/server:0.3.0 home-ai-cctv/web:0.3.0 home-ai-cctv/mcp:0.3.0 home-ai-cctv/presence-check:0.3.0 | microk8s ctr images import -
   ```

   Если `microk8s ctr` запрашивает sudo, а пользователь входит в группу `microk8s`, используйте binary напрямую:

   ```bash
   docker save home-ai-cctv/server:0.3.0 home-ai-cctv/web:0.3.0 home-ai-cctv/mcp:0.3.0 home-ai-cctv/presence-check:0.3.0 | \
     /snap/microk8s/current/bin/ctr \
       --address /var/snap/microk8s/common/run/containerd.sock \
       --namespace k8s.io images import -
   ```

3. Создайте namespace, PVC, NetworkPolicy и ConfigMap go2rtc, затем ConfigMap Caddy из файла:

   ```bash
   microk8s kubectl apply -f deploy/microk8s/infra.yaml
   microk8s kubectl -n home-ai-cctv create configmap caddy-config \
     --from-file=Caddyfile=config/Caddyfile \
     --dry-run=client -o yaml | microk8s kubectl apply -f -
   ```

   Конфигурация Caddy живёт в одном файле `config/Caddyfile`; `infra.yaml` её не дублирует.

4. Создайте Kubernetes Secrets. Секрет `home-ai-cctv-mqtt` обязателен: `workloads.yaml` монтирует его в `server`. Если Mosquitto ещё не развёрнут, сгенерируйте временный пароль — сервер не сможет подключиться к broker и будет переподключаться, это не мешает остальным сервисам. Порядок настройки реального broker — в разделе «MQTT для openHAB» ниже.

   ```bash
   microk8s kubectl -n home-ai-cctv create secret generic home-ai-cctv-secrets \
     --from-file=admin_password=secrets/admin_password \
     --from-file=ai_api_token=secrets/ai_api_token \
     --from-file=camera_encryption_key=secrets/camera_encryption_key
   install -m 600 /dev/null secrets/mqtt_password
   openssl rand -base64 24 > secrets/mqtt_password
   microk8s kubectl -n home-ai-cctv create secret generic home-ai-cctv-mqtt \
     --from-file=password=secrets/mqtt_password
   ```

5. Запустите workloads:

   ```bash
   microk8s kubectl apply -f deploy/microk8s/workloads.yaml
   microk8s kubectl -n home-ai-cctv rollout status deployment/server --timeout=180s
   microk8s kubectl -n home-ai-cctv rollout status deployment/media --timeout=180s
   microk8s kubectl -n home-ai-cctv rollout status deployment/proxy --timeout=180s
   microk8s kubectl -n home-ai-cctv rollout status deployment/presence-check --timeout=180s
   ```

6. Проверьте HTTP и веб-клиент:

   ```bash
   curl http://127.0.0.1:30081/api/v1/health/live
   curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:30081/video/
   ```

## Обновление образов

Рабочий путь для удалённого сервера: сборка на рабочей станции, передача по SSH, `rollout restart`. Те же image tags при `imagePullPolicy: IfNotPresent` подхватываются новыми подами после импорта.

Образ `presence-check` не входит в compose, он собирается отдельно: `docker build -t home-ai-cctv/presence-check:0.3.0 presence/`.

```bash
docker compose build server web mcp
docker build -t home-ai-cctv/presence-check:0.3.0 presence/
docker save home-ai-cctv/server:0.3.0 home-ai-cctv/web:0.3.0 home-ai-cctv/mcp:0.3.0 home-ai-cctv/presence-check:0.3.0 | \
  ssh <server> "CONTAINERD_ADDRESS=/var/snap/microk8s/common/run/containerd.sock \
    /snap/microk8s/current/bin/ctr -n k8s.io images import -"
ssh <server> "microk8s kubectl -n home-ai-cctv rollout restart deployment/server deployment/web deployment/mcp deployment/presence-check && \
  microk8s kubectl -n home-ai-cctv rollout status deployment/server --timeout=180s"
```

Сборка непосредственно на сервере (`docker compose build` на самом узле) тоже работает, но медленнее и требует Docker.

ВНИМАНИЕ: при обновлении образа, тег которого недоступен из реестра (локальные теги `home-ai-cctv/*`), сначала гасите пода (`kubectl scale deploy/<name> --replicas=0`), удаляйте старый тег (`ctr -n k8s.io images rm <ref>`), затем импортируйте новый и поднимайте реплику. Иначе kubelet в цикле `ImagePullBackOff` сохраняет HTML-ответ прокси как манифест и перезаписывает импортированный тег. Так же отдельно от `kubectl apply` запускайте `ctr images import -`: `apply -f -` из той же stdin очереди получает пустой ввод.

## MQTT для openHAB

`server` публикует каждое новое событие камеры в `home-ai-cctv/events` через QoS 1. Payload содержит полный `CameraEvent`.

1. Создайте пользователя `home-cctv` в passwd-файле Mosquitto.
2. Сохраните его пароль в `secrets/mqtt_password` с правами `0600`.
3. Обновите Secret (перезапишет временный из первичного запуска):

   ```bash
   microk8s kubectl -n home-ai-cctv create secret generic home-ai-cctv-mqtt \
     --from-file=password=secrets/mqtt_password \
     --dry-run=client -o yaml | microk8s kubectl apply -f -
   ```

4. Примените `deploy/microk8s/workloads.yaml` и перезапустите `server`.

Адрес broker внутри кластера: `mqtt://mosquitto.smart-devices.svc.cluster.local:1883`. Пользователь и пароль настраиваются через `MQTT_USERNAME` и `MQTT_PASSWORD_FILE`.

## Снимок для openHAB

Правило openHAB берёт снимок камеры через внутренний listener `proxy`:

```text
http://proxy-hooks.home-ai-cctv.svc.cluster.local:8081/api/v1/ai/cameras/<camera_id>/snapshot.jpg
```

Правила:

- Токен AI API не нужен: Caddy подставляет его из переменной `CCTV_AI_TOKEN`, которую Deployment `proxy` читает из Secret `home-ai-cctv-secrets` (`ai_api_token`).
- Listener отвечает только на `GET` снимка; остальные пути получают `404`.
- Порт `8081` не публикуется на узле: вне кластера он недоступен.
- После изменения `config/Caddyfile` пересоздайте ConfigMap `caddy-config` и перезапустите `proxy`.

```bash
microk8s kubectl -n home-ai-cctv create configmap caddy-config \
  --from-file=Caddyfile=config/Caddyfile \
  --dry-run=client -o yaml | microk8s kubectl apply -f -
microk8s kubectl -n home-ai-cctv rollout restart deployment/proxy
```

## Перенос backup из Docker Compose на homesv

`deploy/microk8s/restore-compose-job.yaml` копирует SQLite и `go2rtc.yaml` в новые PVC. Job читает backup из `/home/homesv/home-ai-cctv/backups` и не запускает приложение.

1. Остановите Compose и создайте финальный backup через SQLite backup API.
2. Замените `REPLACE_WITH_BACKUP_TIMESTAMP` в Job на имя каталога backup.
3. Выполните `microk8s kubectl apply -f deploy/microk8s/restore-compose-job.yaml`.
4. Дождитесь `job/compose-restore` условия `Complete` и удалите Job.
5. Примените `workloads.yaml`.

Job предназначен для одноразового переноса. Не применяйте его к работающему стеку: он заменяет SQLite и рабочий config go2rtc.

## Обновление

1. Создайте backup.
2. Соберите и импортируйте images с новой точной версией.
3. Обновите теги в `deploy/microk8s/workloads.yaml`.
4. Выполните `microk8s kubectl apply -f deploy/microk8s/workloads.yaml`.
5. Проверьте камеры, JPEG, WebRTC/HLS, PTZ, SSE и MCP.

Не используйте `latest`. После изменения Secret пересоздайте его через `create secret generic --dry-run=client -o yaml | microk8s kubectl apply -f -` и перезапустите `server` и `mcp`.

`scripts/backup.sh`, `scripts/restore.sh` и `scripts/verify-stack.sh` сейчас используют `docker compose exec`. Для microk8s они требуют отдельной адаптации. Не копируйте SQLite файл во время активного WAL без SQLite backup API.
