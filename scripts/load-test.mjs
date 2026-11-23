// T-17: нагрузочный прогон (спецификация 90 §7). Расчётный профиль — 4 источника,
// фактический стенд владельца — 2 камеры (запас 4 не воспроизводится, решение владельца 2026-11-22).
// Профиль: 2 зрителя (headless Firefox, WebRTC), 1 MJPEG consumer на камеру, ONVIF subscriptions включены сервером.
// geckodriver держит одну сессию на процесс: каждому зрителю — свой драйвер и порт.
// Запуск: node scripts/load-test.mjs [minutes]. Результат: локальный gitignored docs/evidence/load-<N>min.csv + вердикт LOAD_STATUS.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:8080';
const MINUTES = Number(process.argv[2] || 60);
const PORT_BASE = 4500 + (process.pid % 200);
const TMP = join(homedir(), '.cache', 'e2e-firefox');
mkdirSync(TMP, { recursive: true });
const EV = join(ROOT, 'docs', 'evidence');
const CSV = join(EV, 'load-' + String(MINUTES) + 'min.csv');
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

const wd = async (port, method, path, body) => {
  const res = await fetch('http://127.0.0.1:' + port + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const json = await res.json();
  if (!res.ok) {
    const detail = JSON.stringify(json && json.value ? json.value : json).slice(0, 160);
    throw new Error(method + ' ' + path + ' -> ' + res.status + ': ' + detail);
  }
  return json.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) =>
  new Promise((resolve) => {
    const p = spawn('bash', ['-c', cmd], { cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => resolve(out.trim()));
  });

const password = readFileSync(join(ROOT, 'secrets', 'admin_password'), 'utf8').trim();
const aiToken = readFileSync(join(ROOT, 'secrets', 'ai_api_token'), 'utf8').trim();

async function api(path, init) {
  return fetch(BASE + path, {
    ...(init || {}),
    headers: { 'Content-Type': 'application/json', Origin: BASE, ...((init && init.headers) || {}) },
  });
}
const loginRes = await api('/api/v1/auth/session', { method: 'POST', body: JSON.stringify({ username: 'admin', password }) });
const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
const cameras = await (await api('/api/v1/cameras', { headers: { Cookie: cookie } })).json();
if (cameras.length < 2) throw new Error('need 2 cameras for load profile');

const viewers = [];
const drivers = [];
const cleanup = async () => {
  for (const v of viewers) await wd(v.port, 'DELETE', '/session/' + v.id).catch(() => undefined);
  for (const d of drivers) d.kill('SIGTERM');
};
process.on('exit', () => {
  for (const d of drivers) d.kill('SIGTERM');
});

for (const [i, cam] of cameras.slice(0, 2).entries()) {
  const port = PORT_BASE + i;
  const logFd = openSync(join(TMP, 'gd-load-' + port + '.log'), 'a');
  const driver = spawn(join(homedir(), '.local', 'bin', 'geckodriver'), ['--port', String(port), '--host', '127.0.0.1'], {
    env: { ...process.env, TMPDIR: TMP },
    stdio: ['ignore', 'ignore', logFd],
  });
  drivers.push(driver);
  for (let t = 0; t < 20; t++) {
    const ready = await wd(port, 'GET', '/status').catch(() => null);
    if (ready && ready.ready) break;
    await sleep(500);
  }
  let session = null;
  for (let attempt = 0; attempt < 3 && !session; attempt++) {
    session = await wd(port, 'POST', '/session', {
      capabilities: {
        alwaysMatch: {
          browserName: 'firefox',
          'moz:firefoxOptions': {
            binary: process.env.E2E_FIREFOX || join(homedir(), 'opt', 'firefox', 'firefox'),
            args: ['-headless'],
            prefs: { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 },
          },
        },
      },
    }).catch((e) => {
      console.log('viewer ' + i + ' session attempt: ' + e.message);
      return null;
    });
    if (!session) await sleep(3000);
  }
  if (!session) {
    await cleanup();
    throw new Error('viewer ' + i + ': firefox session failed');
  }
  const sid = session.sessionId;
  viewers.push({ port, id: sid, cam });
  await wd(port, 'POST', '/session/' + sid + '/url', { url: BASE + '/login' });
  await sleep(1200);
  const input = await wd(port, 'POST', '/session/' + sid + '/element', { using: 'css selector', value: 'input[type="password"]' });
  await wd(port, 'POST', '/session/' + sid + '/element/' + input[ELEMENT_KEY] + '/value', { text: password });
  const btn = await wd(port, 'POST', '/session/' + sid + '/element', { using: 'css selector', value: 'form button[type="submit"]' });
  await wd(port, 'POST', '/session/' + sid + '/element/' + btn[ELEMENT_KEY] + '/click', {});
  await sleep(1500);
  await wd(port, 'POST', '/session/' + sid + '/url', { url: BASE + '/cameras/' + cam.id });
  await sleep(4000);
  console.log('viewer ' + i + ' up: ' + cam.name);
}

// MJPEG consumers: по одному на камеру, счётчики кадров.
const mjpeg = cameras.slice(0, 2).map((cam) => ({ cam: cam.id, frames: 0, bytes: 0, controller: new AbortController() }));
for (const m of mjpeg) {
  (async () => {
    try {
      const res = await fetch(BASE + '/api/v1/ai/cameras/' + m.cam + '/stream.mjpeg', {
        headers: { Authorization: 'Bearer ' + aiToken },
        signal: m.controller.signal,
      });
      const reader = res.body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value = chunk.value;
        m.bytes += value.length;
        for (let i = 0; i + 2 < value.length; i++) {
          if (value[i] === 0xff && value[i + 1] === 0xd8 && value[i + 2] === 0xff) m.frames++;
        }
      }
    } catch {
      // abort в конце прогона
    }
  })();
}

writeFileSync(CSV, 'minute,server_cpu_pct,media_cpu_pct,server_rss_mb,media_rss_mb,server_pids,media_pids,server_net_io,media_net_io,server_fds,ffmpeg_procs,viewers_playing,mjpeg_frames_1,mjpeg_frames_2\n');
let serverCpuMax = 0;
let mediaCpuMax = 0;
const sample = async (minute) => {
  const stats = await sh("docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}|{{.PIDs}}' | grep -E 'server|media'");
  const rss = {};
  const cpu = { server: 0, media: 0 };
  const pids = { server: 0, media: 0 };
  const net = { server: '', media: '' };
  for (const line of stats.split('\n')) {
    const parts = line.split('|');
    const key = (parts[0] || '').includes('server') ? 'server' : 'media';
    const mb = parseFloat(parts[2] || '0') || 0;
    const raw = parts[2] || '';
    rss[key] = raw.includes('GiB') ? mb * 1024 : raw.includes('KiB') ? mb / 1024 : mb;
    cpu[key] = parseFloat(parts[1] || '0') || 0;
    net[key] = parts[3] || '';
    pids[key] = parseInt(parts[4] || '0', 10) || 0;
  }
  serverCpuMax = Math.max(serverCpuMax, cpu.server);
  mediaCpuMax = Math.max(mediaCpuMax, cpu.media);
  const fds = await sh("docker compose exec -T server sh -c 'ls /proc/1/fd | wc -l'");
  const ffmpeg = await sh("docker compose exec -T media sh -c 'ps -o comm | grep -c ffmpeg || true'");
  let playing = 0;
  for (const v of viewers) {
    const ok = await wd(v.port, 'POST', '/session/' + v.id + '/execute/sync', {
      script: 'const v = document.querySelector("video"); return v ? v.readyState >= 2 && v.currentTime > 0 : false;',
      args: [],
    }).catch(() => false);
    if (ok) playing++;
  }
  const row = [
    minute,
    cpu.server.toFixed(2),
    cpu.media.toFixed(2),
    rss.server ? rss.server.toFixed(1) : '',
    rss.media ? rss.media.toFixed(1) : '',
    pids.server,
    pids.media,
    net.server,
    net.media,
    fds,
    ffmpeg,
    playing,
    mjpeg[0].frames,
    mjpeg[1].frames,
  ].join(',');
  appendFileSync(CSV, row + '\n');
  console.log(row);
  return { server: rss.server || 0, media: rss.media || 0, fds: Number(fds), ffmpeg: Number(ffmpeg), playing };
};

try {
  const first = await sample(0);
  for (let m = 1; m <= MINUTES; m++) {
    await sleep(60000);
    await sample(m);
  }
  const last = await sample(MINUTES);
  for (const m of mjpeg) m.controller.abort();
  await cleanup();
  await sleep(10000);
  const ffmpegAfter = Number(await sh("docker compose exec -T media sh -c 'ps -o comm | grep -c ffmpeg || true'"));
  const growth = (a, b) => (a > 0 ? ((b - a) / a) * 100 : 0);
  const serverGrowth = growth(first.server, last.server);
  const mediaGrowth = growth(first.media, last.media);
  const fdDelta = last.fds - first.fds;
  const ok = serverGrowth <= 25 && mediaGrowth <= 25 && fdDelta <= 20 && ffmpegAfter === 0 && last.playing === 2;
  console.log(
    'server RSS growth ' + serverGrowth.toFixed(1) +
      '%, media RSS growth ' + mediaGrowth.toFixed(1) +
      '%, fd delta ' + fdDelta + ', ffmpeg after stop ' + ffmpegAfter + ', viewers ' + last.playing + ', max CPU server ' + serverCpuMax.toFixed(1) + '%, media ' + mediaCpuMax.toFixed(1) + '%',
  );
  console.log('LOAD_STATUS: ' + (ok ? 'GREEN' : 'RED'));
  process.exit(ok ? 0 : 1);
} finally {
  for (const m of mjpeg) m.controller.abort();
  await cleanup();
}