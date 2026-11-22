import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FpsThrottle } from '../src/http/routes/mjpeg.js';

function jpegFrame(size: number): Buffer {
  const header = Buffer.from('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + String(size) + '\r\n\r\n');
  const body = Buffer.alloc(size, 0xff);
  return Buffer.concat([header, body, Buffer.from('\r\n')]);
}

function collect(stream: FpsThrottle, chunks: Buffer[]): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
}

function countFrames(chunks: Buffer[]): number {
  return Buffer.concat(chunks).toString('latin1').split('--frame').length - 1;
}

describe('FpsThrottle', () => {
  test('не превышает fps при входном потоке 25 кадров/с', async () => {
    const throttle = new FpsThrottle(5);
    const chunks: Buffer[] = [];
    const done = collect(throttle, chunks);
    const frame = jpegFrame(10);
    const t0 = Date.now();
    const sender = setInterval(() => {
      throttle.write(frame);
      if (Date.now() - t0 > 1050) {
        clearInterval(sender);
        throttle.end();
      }
    }, 40); // 25 fps
    await done;
    const frames = countFrames(chunks);
    assert.ok(frames >= 3 && frames <= 7, `ожидалось ~5 кадров, получено ${frames}`);
  });

  test('выпускает последний кадр из пачки, а не первый', async () => {
    const throttle = new FpsThrottle(2);
    const chunks: Buffer[] = [];
    const done = collect(throttle, chunks);
    // Пачка из трёх кадров с разным размером; последний (Content-Length: 33) должен уйти первым.
    throttle.write(Buffer.concat([jpegFrame(10), jpegFrame(20), jpegFrame(33)]));
    await new Promise((r) => setTimeout(r, 700));
    throttle.end();
    await done;
    const out = Buffer.concat(chunks).toString('latin1');
    assert.match(out, /Content-Length: 33/);
  });

  test('сохраняет структуру кадра (boundary + Content-Length + JPEG)', async () => {
    const throttle = new FpsThrottle(1000);
    const chunks: Buffer[] = [];
    const done = collect(throttle, chunks);
    throttle.write(jpegFrame(20));
    throttle.end();
    await done;
    const out = Buffer.concat(chunks).toString('latin1');
    assert.match(out, /^--frame\r\nContent-Type: image\/jpeg\r\nContent-Length: 20\r\n\r\n/);
  });

  test('накопленный кусок без полного кадра не теряется', async () => {
    const throttle = new FpsThrottle(1000);
    const chunks: Buffer[] = [];
    const done = collect(throttle, chunks);
    const frame = jpegFrame(15);
    const half = Math.floor(frame.length / 2);
    throttle.write(frame.subarray(0, half));
    await new Promise((r) => setTimeout(r, 20));
    throttle.write(frame.subarray(half));
    throttle.end();
    await done;
    const out = Buffer.concat(chunks).toString('latin1');
    assert.match(out, /Content-Length: 15/);
  });
});
