#!/usr/bin/env node
// Интерактивные E2E в Firefox через geckodriver (WebDriver REST, без Playwright).
// Запуск: node scripts/e2e-firefox.mjs. Стенд должен быть поднят (docker compose up -d).
// Скриншоты шагов пишутся в docs/evidence/firefox-e2e-*.png.
// Нужен geckodriver вне snap confinement: snap-версия не видит /usr/bin/firefox.
// Бинарник mozilla кладётся в ~/.local/bin/geckodriver (или путь в E2E_GECKODRIVER).
// snap Firefox не принимает внешний -profile и не отдаёт Marionette порт:
// для E2E используется сборка mozilla (E2E_FIREFOX=/path/to/firefox).
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080';
const PORT = Number(process.env.E2E_GECKO_PORT ?? 4444);
const WD = `http://127.0.0.1:${PORT}`;
// snap Firefox не пишет профили в /tmp: временный каталог только в home.
const TMP = join(homedir(), '.cache', 'e2e-firefox');
mkdirSync(TMP, { recursive: true });
const EVIDENCE = join(ROOT, 'docs', 'evidence');
mkdirSync(EVIDENCE, { recursive: true });

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const results = [];
const pass = (name, fact) => {
  results.push(['PASS', name]);
  console.log(`PASS: ${name}${fact ? ` — ${fact}` : ''}`);
};

let driver = null;
let sessionId = null;

async function wd(method, path, body) {
  const res = await fetch(WD + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json.value ?? json)}`);
  return json.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await sleep(400);
  }
}
const css = (value) => wd('POST', `/session/${sessionId}/element`, { using: 'css selector', value });
const xpath = (value) => wd('POST', `/session/${sessionId}/element`, { using: 'xpath', value });
const eid = (el) => el[ELEMENT_KEY];
const click = (el) => wd('POST', `/session/${sessionId}/element/${eid(el)}/click`, {});
const exec = (script) => wd('POST', `/session/${sessionId}/execute/sync`, { script, args: [] });
const tryCss = (value) => css(value).catch(() => null);
async function shot(name) {
  const b64 = await wd('GET', `/session/${sessionId}/screenshot`);
  writeFileSync(join(EVIDENCE, name), Buffer.from(b64, 'base64'));
}
const badge = () =>
  exec('const v = document.querySelector("video"); if (!v) return null; const s = v.parentElement.querySelector("span"); return s ? s.textContent : null;');
const videoState = () =>
  exec('const v = document.querySelector("video"); return v ? { rs: v.readyState, t: v.currentTime, w: v.videoWidth, h: v.videoHeight } : null;');

async function run() {
  await wd('POST', `/session/${sessionId}/url`, { url: `${BASE}/` });
  await waitFor(() => tryCss('input[type="password"]'), 20000, 'login form');
  await shot('firefox-e2e-1-login.png');
  pass('login screen rendered');

  const password = readFileSync(join(ROOT, 'secrets', 'admin_password'), 'utf8').trim();
  const pw = await css('input[type="password"]');
  await wd('POST', `/session/${sessionId}/element/${eid(pw)}/value`, { text: password });
  await click(await css('form button[type="submit"]'));
  await waitFor(() => tryCss('[aria-label^="Камера "]'), 20000, 'cameras grid');
  await shot('firefox-e2e-2-grid.png');
  pass('login -> cameras grid');

  await click(await css('[aria-label^="Камера "]'));
  await waitFor(() => tryCss('video'), 20000, 'video element');
  const play = await waitFor(async () => {
    const v = await videoState();
    return v && v.rs >= 2 && v.t > 0 ? v : null;
  }, 45000, 'video playing');
  await sleep(1200);
  const later = await videoState();
  if (!(later.t > play.t)) throw new Error('video currentTime not advancing');
  const mode = await badge();
  await shot('firefox-e2e-3-player.png');
  pass('player live', `mode=${mode}, ${play.w}x${play.h}`);

  // Move на удержание 800 мс через W3C actions, затем Stop кнопкой.
  const right = await css('section[aria-label="PTZ"] button[aria-label="Вправо"]');
  await wd('POST', `/session/${sessionId}/actions`, {
    actions: [
      {
        type: 'pointer',
        id: 'mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', origin: { [ELEMENT_KEY]: eid(right) }, x: 0, y: 0 },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 800 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ],
  });
  await sleep(400);
  await click(await css('section[aria-label="PTZ"] button[aria-label="Стоп"]'));
  await sleep(400);
  const ptzAlert = await exec('return document.querySelector(\'section[aria-label="PTZ"] [role="alert"]\') !== null;');
  if (ptzAlert) throw new Error('PTZ error alert visible');
  pass('PTZ move/hold/stop without error');

  const presetBtn = await xpath('//section[@aria-label="PTZ"]//button[contains(@class,"presetButton")]').catch(() => null);
  if (presetBtn) {
    await click(presetBtn);
    await sleep(1500);
    const presetAlert = await exec('return document.querySelector(\'section[aria-label="PTZ"] [role="alert"]\') !== null;');
    if (presetAlert) throw new Error('preset goto error alert visible');
    pass('preset goto without error');
  }

  await click(await xpath('//div[@role="group"][@aria-label="Режим воспроизведения"]/button[text()="HLS"]'));
  const hls = await waitFor(async () => {
    const b = await badge();
    return b && b.includes('HLS') ? b : null;
  }, 45000, 'HLS badge');
  await shot('firefox-e2e-4-hls.png');
  pass('manual HLS mode', hls);

  await click(await xpath('//div[@role="group"][@aria-label="Режим воспроизведения"]/button[text()="WebRTC"]'));
  const rtc = await waitFor(async () => {
    const b = await badge();
    return b && b.includes('WebRTC') ? b : null;
  }, 45000, 'WebRTC badge');
  pass('switch back to WebRTC', rtc);

  await wd('POST', `/session/${sessionId}/url`, { url: `${BASE}/events` });
  const sse = await waitFor(async () => {
    const s = await exec('const el = [...document.querySelectorAll("span")].find((x) => x.textContent.startsWith("SSE:")); return el ? el.textContent : null;');
    return s === 'SSE: подключено' ? s : null;
  }, 20000, 'SSE open');
  await shot('firefox-e2e-5-events.png');
  pass('events screen, SSE open', sse);

  await click(await xpath('//button[text()="Выйти"]'));
  await waitFor(() => tryCss('input[type="password"]'), 20000, 'login after logout');
  await shot('firefox-e2e-6-logout.png');
  pass('logout -> login screen');
}

async function main() {
  const gecko = process.env.E2E_GECKODRIVER ?? join(homedir(), '.local', 'bin', 'geckodriver');
  driver = spawn(gecko, ['--port', String(PORT), '--host', '127.0.0.1'], {
    env: { ...process.env, TMPDIR: TMP },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await waitFor(async () => {
    try {
      const s = await wd('GET', '/status');
      return s.ready === true;
    } catch {
      return false;
    }
  }, 30000, 'geckodriver ready');
  const session = await wd('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'firefox',
        'moz:firefoxOptions': {
          binary: process.env.E2E_FIREFOX ?? '/usr/bin/firefox',
          args: ['-headless'],
          prefs: { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 },
        },
      },
    },
  });
  sessionId = session.sessionId;
  try {
    await run();
  } catch (err) {
    results.push(['FAIL', 'e2e aborted']);
    console.log(`FAIL: e2e aborted — ${err.message}`);
    try {
      await shot('firefox-e2e-failure.png');
    } catch {
      /* скриншот недоступен — не маскируем исходную ошибку */
    }
  } finally {
    if (sessionId) await wd('DELETE', `/session/${sessionId}`).catch(() => undefined);
    driver?.kill('SIGTERM');
  }
  const failed = results.filter(([s]) => s === 'FAIL').length;
  console.log(`E2E_FIREFOX: ${failed === 0 ? 'PASS' : 'FAIL'} (${results.length - failed}/${results.length})`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();