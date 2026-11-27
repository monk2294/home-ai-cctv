// Home CCTV: свет в кабинете по присутствию.
// Включение: бортовое событие камеры. Камера должна видеть человека непрерывно
// ON_CONFIRM_MS (0,75 с). Tapo C520WS определяет людей сама; для камер без
// people используется motion. Motion не включает свет, только удерживает его.
// Выключение: сигналов нет OFF_DEBOUNCE_MS (10 с) -> запрос face-check
// (YuNet ищет лицо в свежем кадре). Лицо есть -> присутствие держится, отсчёт
// 10 с заново. Лица нет -> повтор через FACE_RETRY_MS (1 с). Два промотра подряд
// -> свет выключить. Ошибка face-check -> свет не трогать, перепроверка позже.
// Cron раз в минуту — страховка: свет включён и сигналов нет OFF_AFTER_MS -> гасим.
// Спека: docs/specs/55-face-presence-check.md, сервис: presence/.
var OFFICE_CAMERA = "dfeab160-5904-4bfe-9465-d1936b30a205";
var OFFICE_CAMERA_NAME = "Рабочее место";
var LIGHT_ITEM = "OfficeLight_Switch";
var PRESENT_ITEM = "HomeCCTV_OfficePresent";
var LAST_SEEN_ITEM = "HomeCCTV_OfficeLastSeen";
var EVENT_ITEM = "HomeCCTV_Event";
var FACE_CHECK_URL =
  "http://presence-check.home-ai-cctv.svc.cluster.local:8000/check?camera_id=" + OFFICE_CAMERA;
var ON_CONFIRM_MS = 750;
var OFF_DEBOUNCE_MS = 10000;
var OFF_AFTER_MS = 2 * 60 * 1000;
var FACE_RETRY_MS = 1000;

// В контексте script.ScriptAction нет executeHttpRequest и не работает require() из
// openhab-js — HTTP идёт напрямую через java.net.http (проверено пробным правилом).
function httpGet(url) {
  try {
    var HttpClient = Java.type("java.net.http.HttpClient");
    var HttpRequest = Java.type("java.net.http.HttpRequest");
    var HttpResponse = Java.type("java.net.http.HttpResponse");
    var URI = Java.type("java.net.URI");
    var Duration = Java.type("java.time.Duration");
    var client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    var req = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(8)).GET().build();
    var resp = client.send(req, HttpResponse.BodyHandlers.ofString());
    return { status: resp.statusCode(), body: String(resp.body()) };
  } catch (error) {
    logWarn("face-check запрос не удался: " + (error && error.message ? error.message : error));
    return null;
  }
}

function logInfo(message) {
  console.info("Office light: " + message);
}

function logWarn(message) {
  console.warn("Office light: " + message);
}

function readLastSeen() {
  var value = parseInt(String(items.getItem(LAST_SEEN_ITEM).state), 10);
  return isNaN(value) || value <= 0 ? null : value;
}

function clearOnTimer() {
  var timer = cache.private.get("onTimer");
  if (timer) {
    clearTimeout(timer);
    cache.private.put("onTimer", null);
  }
}

function clearOffTimer() {
  var timer = cache.private.get("offTimer");
  if (timer) {
    clearTimeout(timer);
    cache.private.put("offTimer", null);
  }
}

function clearFaceRetry() {
  var timer = cache.private.get("faceRetry");
  if (timer) {
    clearTimeout(timer);
    cache.private.put("faceRetry", null);
  }
}

function touchPresence() {
  var now = Date.now();
  cache.private.put("lastPresence", now);
  items.getItem(LAST_SEEN_ITEM).postUpdate(String(now));
}

function markPresent(reason) {
  cache.private.put("present", true);
  touchPresence();
  items.getItem(PRESENT_ITEM).postUpdate("ON");
  items.getItem(LIGHT_ITEM).sendCommandIfDifferent("ON");
  logInfo(OFFICE_CAMERA_NAME + ": присутствие подтверждено (" + reason + "), свет включён");
}

function markAbsent(reason) {
  cache.private.put("present", false);
  items.getItem(PRESENT_ITEM).postUpdate("OFF");
  items.getItem(LIGHT_ITEM).sendCommandIfDifferent("OFF");
  logInfo(OFFICE_CAMERA_NAME + ": присутствия нет (" + reason + "), свет выключен");
}

function scheduleOffTimer() {
  clearOffTimer();
  clearFaceRetry();
  cache.private.put("silenceStart", Date.now());
  cache.private.put("offTimer", setTimeout(function () {
    cache.private.put("offTimer", null);
    if (cache.private.get("present") !== true) {
      return;
    }
    faceCheck(1);
  }, OFF_DEBOUNCE_MS));
}

function keepPresent(reason) {
  touchPresence();
  scheduleOffTimer();
  logInfo(OFFICE_CAMERA_NAME + ": " + reason + ", присутствие держим");
}

function faceCheck(attempt) {
  var silenceStart = cache.private.get("silenceStart") || 0;
  if (cache.private.get("present") !== true) {
    return;
  }
  var response = httpGet(FACE_CHECK_URL);
  var result = null;
  if (response && response.status === 200) {
    try {
      result = JSON.parse(response.body);
    } catch (error) {
      result = null;
    }
  }
  // Пока шёл HTTP, пришло активное событие — присутствие уже подтверждено, решение не нужно.
  if (cache.private.get("present") !== true || (cache.private.get("lastPresence") || 0) > silenceStart) {
    return;
  }
  if (result === null) {
    // Ошибка сервиса не подтверждает присутствие: lastPresence не продлеваем, иначе cron-страховка не сработает.
    logWarn("face-check не ответил корректно, свет не трогаем, перепроверка через " + Math.round(OFF_DEBOUNCE_MS / 1000) + " с");
    scheduleOffTimer();
    return;
  }
  if (result.face === true) {
    keepPresent("лицо есть (score " + result.score + ")");
    return;
  }
  if (attempt === 1) {
    cache.private.put("faceRetry", setTimeout(function () {
      cache.private.put("faceRetry", null);
      faceCheck(2);
    }, FACE_RETRY_MS));
    return;
  }
  markAbsent("лицо не найдено дважды");
}

function handleActive() {
  if (cache.private.get("present") === true) {
    clearOffTimer();
    clearFaceRetry();
    touchPresence();
    return;
  }
  if (cache.private.get("onTimer")) {
    return;
  }
  cache.private.put("onTimer", setTimeout(function () {
    cache.private.put("onTimer", null);
    markPresent("вижу " + ON_CONFIRM_MS + " мс подряд");
  }, ON_CONFIRM_MS));
}

function handleInactive() {
  clearOnTimer();
  if (cache.private.get("present") !== true) {
    return;
  }
  scheduleOffTimer();
}

function handlePresenceEvent() {
  var ev;
  try {
    ev = JSON.parse(String(items.getItem(EVENT_ITEM).state));
  } catch (error) {
    return;
  }
  if (!ev || ev.camera_id !== OFFICE_CAMERA || ["motion", "people"].indexOf(ev.type) < 0) {
    return;
  }
  if (ev.type === "people") {
    cache.private.put("peopleSeen", true);
  } else if (cache.private.get("peopleSeen")) {
    if (ev.state === "active" && cache.private.get("present") === true) {
      clearOffTimer();
      clearFaceRetry();
      touchPresence();
    }
    return;
  }
  if (ev.state === "active") {
    handleActive();
    return;
  }
  if (ev.state === "inactive") {
    handleInactive();
  }
}

function handleCron() {
  if (items.getItem(LIGHT_ITEM).state !== "ON") {
    return;
  }
  var last = Math.max(cache.private.get("lastPresence") || 0, readLastSeen() || 0);
  if (last === 0) {
    return;
  }
  var absentMs = Date.now() - last;
  if (absentMs >= OFF_AFTER_MS) {
    markAbsent("тишина " + Math.round(absentMs / 60000) + " мин");
  }
}

try {
  var triggerItem = (typeof event !== "undefined" && event && typeof event.itemName === "string") ? event.itemName : null;

  if (triggerItem === EVENT_ITEM) {
    handlePresenceEvent();
  } else {
    handleCron();
  }
} catch (error) {
  logWarn("обработка события не удалась: " + (error && error.message ? error.message : error));
}
