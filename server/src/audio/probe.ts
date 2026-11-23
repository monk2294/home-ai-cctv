import { spawn } from 'node:child_process';

/** Файл на диске, а не pipe: ffprobe 5.1 отдаёт format.duration только при ищущем вводе. */

/** Длительность аудио в мс по ffprobe; null — файл не декодируется. */
export async function probeDurationMs(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(
      'ffprobe',
      ['-hide_banner', '-loglevel', 'error', '-show_format', '-of', 'json', file],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const out: Buffer[] = [];
    let settled = false;
    const finish = (value: number | null): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, 10_000);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.resume();
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish(null);
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(out).toString('utf8')) as { format?: { duration?: string } };
        const seconds = Number(parsed.format?.duration);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          finish(null);
          return;
        }
        finish(Math.round(seconds * 1000));
      } catch {
        finish(null);
      }
    });
  });
}
