// Home CCTV: типизированные вопросы к decision-модели d1 (llama.cpp, /v1/systemone).
// Снимок берётся через внутренний listener прокси (ClusterIP 8081), AI-токен подставляет прокси.
var CCTV_HOOK = "http://proxy-hooks.home-ai-cctv.svc.cluster.local:8081/api/v1/ai/cameras/";
var DECISION_URL = "http://192.168.1.233:8080/v1/systemone";
var DECISION_MODEL = "/home/deck/sd/d1/d1-2B-Q4_K_M.gguf";
var SNAPSHOT_TIMEOUT_SEC = 20;
var DECISION_TIMEOUT_SEC = 60;

var DANGER = {
  label: "нештатная ситуация",
  type: "noul",
  instructions: "Есть ли признаки нештатной ситуации: огонь, дым, вода, взлом или посторонние предметы?",
  "true": "признаки есть",
  "false": "признаков нет"
};

var CAMERAS = {
  "dfeab160-5904-4bfe-9465-d1936b30a205": {
    name: "Рабочее место",
    questions: {
      person: {
        label: "человек",
        type: "choice",
        instructions: "Есть ли на снимке человек?",
        criteria: { yes: "человек есть", no: "человека нет" }
      },
      people: {
        label: "людей",
        type: "score",
        instructions: "Сколько людей на снимке?",
        criteria: ["никого", "один", "два или больше"]
      },
      work: {
        label: "работа за столом",
        type: "choice",
        instructions: "Человек находится за рабочим столом?",
        criteria: { yes: "за столом", no: "не за столом" }
      },
      room: {
        label: "в кабинете",
        type: "choice",
        instructions: "Есть ли в помещении человек?",
        criteria: { yes: "человек или люди в помещении", no: "помещение пустое" }
      },
      danger: DANGER
    }
  },
  "c968560c-4609-4e07-99cf-11b5be2c05f7": {
    name: "Tapo C520WS 239",
    questions: {
      person: {
        label: "человек",
        type: "choice",
        instructions: "Есть ли на снимке человек?",
        criteria: { yes: "человек есть", no: "человека нет" }
      },
      people: {
        label: "людей",
        type: "score",
        instructions: "Сколько людей на снимке?",
        criteria: ["никого", "один", "два или больше"]
      },
      cook: {
        label: "готовка",
        type: "choice",
        instructions: "Человек готовит еду у столешницы?",
        criteria: { yes: "готовит", no: "не готовит" }
      },
      danger: DANGER
    }
  }
};

var DEFAULT_QUESTIONS = {
  person: CAMERAS["dfeab160-5904-4bfe-9465-d1936b30a205"].questions.person,
  people: CAMERAS["dfeab160-5904-4bfe-9465-d1936b30a205"].questions.people,
  danger: DANGER
};

function logInfo(message) {
  console.info("Home CCTV: " + message);
}

function logWarn(message) {
  console.warn("Home CCTV: " + message);
}

function javaClient() {
  var HttpClient = Java.type("java.net.http.HttpClient");
  var Duration = Java.type("java.time.Duration");
  return HttpClient.newBuilder()
    .connectTimeout(Duration.ofSeconds(5))
    .version(Java.type("java.net.http.HttpClient$Version").HTTP_1_1)
    .build();
}

function httpGetBytes(url, timeoutSec) {
  var HttpRequest = Java.type("java.net.http.HttpRequest");
  var URI = Java.type("java.net.URI");
  var Duration = Java.type("java.time.Duration");
  var BodyHandlers = Java.type("java.net.http.HttpResponse$BodyHandlers");
  var request = HttpRequest.newBuilder(URI.create(url))
    .timeout(Duration.ofSeconds(timeoutSec))
    .GET()
    .build();
  var response = javaClient().send(request, BodyHandlers.ofByteArray());
  if (response.statusCode() !== 200) {
    throw new Error("HTTP " + response.statusCode() + " для " + url);
  }
  return response.body();
}

function httpPostJson(url, bodyText, timeoutSec) {
  var HttpRequest = Java.type("java.net.http.HttpRequest");
  var URI = Java.type("java.net.URI");
  var Duration = Java.type("java.time.Duration");
  var BodyHandlers = Java.type("java.net.http.HttpResponse$BodyHandlers");
  var StandardCharsets = Java.type("java.nio.charset.StandardCharsets");
  var request = HttpRequest.newBuilder(URI.create(url))
    .timeout(Duration.ofSeconds(timeoutSec))
    .header("Content-Type", "application/json")
    .POST(HttpRequest.BodyPublishers.ofString(bodyText, StandardCharsets.UTF_8))
    .build();
  var response = javaClient().send(request, BodyHandlers.ofString(StandardCharsets.UTF_8));
  if (response.statusCode() !== 200) {
    throw new Error("Модель вернула HTTP " + response.statusCode());
  }
  return response.body();
}

function apiQuestions(questions) {
  var result = {};
  Object.keys(questions).forEach(function (key) {
    var question = questions[key];
    var api = {};
    Object.keys(question).forEach(function (field) {
      if (field !== "label") {
        api[field] = question[field];
      }
    });
    result[key] = api;
  });
  return result;
}

function formatProbability(value) {
  return typeof value === "number" ? " (" + Math.round(value * 100) + "%)" : "";
}

function formatAnswer(question, answer) {
  if (!answer) {
    return "нет ответа";
  }
  if (answer.type === "choice") {
    var description = question.criteria && question.criteria[answer.choice];
    return (description || String(answer.choice)) + formatProbability(answer.confidence);
  }
  if (answer.type === "score") {
    var level = answer.legend && answer.legend[String(answer.score)];
    return (level !== undefined ? level : String(answer.score)) + formatProbability(answer.confidence);
  }
  if (answer.type === "noul") {
    return typeof answer.noul === "number" ? Math.round(answer.noul * 100) + "%" : "нет ответа";
  }
  return JSON.stringify(answer);
}

function askDecisionModel(questions, imageBytes) {
  var Base64 = Java.type("java.util.Base64");
  var dataUrl = "data:image/jpeg;base64," + Base64.getEncoder().encodeToString(imageBytes);
  var body = {
    model: DECISION_MODEL,
    state: null,
    images: [dataUrl],
    questions: apiQuestions(questions)
  };
  var response = httpPostJson(DECISION_URL, JSON.stringify(body), DECISION_TIMEOUT_SEC);
  var parsed = JSON.parse(response);
  if (!parsed.answers) {
    throw new Error("Модель не вернула answers.");
  }
  return parsed.answers;
}

function analyze(event) {
  var profile = CAMERAS[event.camera_id] || { name: "Камера " + event.camera_id, questions: DEFAULT_QUESTIONS };
  var startedAt = Date.now();
  var image = httpGetBytes(CCTV_HOOK + encodeURIComponent(event.camera_id) + "/snapshot.jpg", SNAPSHOT_TIMEOUT_SEC);
  var answers = askDecisionModel(profile.questions, image);
  var seconds = Math.round((Date.now() - startedAt) / 1000);
  var parts = [];
  Object.keys(profile.questions).forEach(function (key) {
    parts.push(profile.questions[key].label + " — " + formatAnswer(profile.questions[key], answers[key]));
  });
  items.getItem("HomeCCTV_LastAnswer").postUpdate(profile.name + " (" + seconds + " с): " + parts.join("; "));
  items.getItem("HomeCCTV_LastDecision").postUpdate(JSON.stringify({
    camera_id: event.camera_id,
    camera: profile.name,
    event_id: event.id,
    occurred_at: event.occurred_at,
    answers: answers
  }));
  logInfo(profile.name + ": решения готовы за " + seconds + " с, событие " + event.id);
}

var payload = items.getItem("HomeCCTV_Event").state;

if (payload !== "NULL" && payload !== "UNDEF") {
  var cameraEvent = null;
  try {
    cameraEvent = JSON.parse(payload);
  } catch (error) {
    logWarn("событие не является JSON.");
  }

  if (cameraEvent && cameraEvent.type === "motion" && cameraEvent.camera_id && ["active", "inactive"].indexOf(cameraEvent.state) >= 0) {
    var eventId = String(cameraEvent.id);
    if (String(items.getItem("HomeCCTV_LastEventId").state) !== eventId) {
      items.getItem("HomeCCTV_LastEventId").postUpdate(eventId);
      logInfo(String(cameraEvent.camera_id) + " motion=" + String(cameraEvent.state) + " id=" + eventId);

      if (cameraEvent.state === "active" && String(items.getItem("HomeCCTV_LastAnalyzedId").state) !== eventId) {
        if (items.getItem("HomeCCTV_Analyzing").state === "ON") {
          logWarn("предыдущий анализ ещё идёт, событие " + eventId + " пропущено.");
        } else {
          items.getItem("HomeCCTV_Analyzing").postUpdate("ON");
          try {
            analyze(cameraEvent);
            items.getItem("HomeCCTV_LastAnalyzedId").postUpdate(eventId);
          } catch (error) {
            logWarn("ошибка анализа события " + eventId + ": " + (error && error.message ? error.message : error));
          } finally {
            items.getItem("HomeCCTV_Analyzing").postUpdate("OFF");
          }
        }
      }
    }
  }
}