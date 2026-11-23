import { createHash, randomBytes } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';

/** Проверка облачного пароля Tapo на локальном media-порту. */

const TAPO_MEDIA_PORT = 8800;
const BOUNDARY = '--client-stream-boundary--';

export type TapoAuthStatus = 'ok' | 'unauthorized' | 'unavailable';

interface HttpHead {
  status: number;
  headers: Record<string, string>;
}

function readHead(host: string, port: number, timeoutMs: number, authorization?: string): Promise<HttpHead> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const socket: Socket = createConnection({ host, port });
    const finish = (error: Error | null, value?: HttpHead): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value as HttpHead);
    };

    socket.setTimeout(timeoutMs, () => finish(new Error('Таймаут Tapo media-порта')));
    socket.on('error', (error) => finish(error));
    socket.on('close', () => {
      if (!settled) finish(new Error('Tapo media-порт закрыл соединение'));
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buffer.length > 65_536) finish(new Error('Слишком большой ответ Tapo'));
        return;
      }
      const lines = buffer.slice(0, end).split('\r\n');
      const match = /^HTTP\/\d\.\d\s+(\d{3})/.exec(lines[0] ?? '');
      if (!match) {
        finish(new Error('Tapo вернул некорректный HTTP-ответ'));
        return;
      }
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      finish(null, { status: Number(match[1]), headers });
    });

    socket.on('connect', () => {
      const headers = [
        'POST /stream HTTP/1.1',
        `Host: ${host}:${port}`,
        `Content-Type: multipart/mixed; boundary=${BOUNDARY}`,
        'Content-Length: 0',
        ...(authorization ? [`Authorization: ${authorization}`] : []),
        '',
        '',
      ].join('\r\n');
      socket.write(headers);
    });
  });
}

function authParam(challenge: string, name: string): string {
  for (const part of challenge.split(',')) {
    const equals = part.indexOf('=');
    if (equals < 0) continue;
    const key = part.slice(0, equals).trim().replace(/^Digest\s+/i, '');
    if (key.toLowerCase() === name.toLowerCase()) {
      return part.slice(equals + 1).trim().replace(/^"|"$/g, '');
    }
  }
  return '';
}

function digestAuthorization(username: string, password: string, challenge: string): string {
  const realm = authParam(challenge, 'realm');
  const nonce = authParam(challenge, 'nonce');
  const qop = authParam(challenge, 'qop') || 'auth';
  const opaque = authParam(challenge, 'opaque');
  const nc = '00000001';
  const cnonce = randomBytes(16).toString('hex');
  // codeql[js/weak-cryptographic-algorithm]: Tapo принимает здесь только HTTP Digest MD5; другой algorithm не работает.
  // codeql[js/insufficient-password-hash]: Это обязательный Digest derivation, а не хранение пароля.
  const ha1 = createHash('md5').update(`${username}:${realm}:${password}`).digest('hex');
  // codeql[js/weak-cryptographic-algorithm]: MD5 обязателен для совместимости с Tapo Digest.
  const ha2 = createHash('md5').update('POST:/stream').digest('hex');
  // codeql[js/weak-cryptographic-algorithm]: MD5 обязателен для совместимости с Tapo Digest.
  const response = createHash('md5').update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`).digest('hex');
  let value =
    `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="/stream", ` +
    `qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
  if (opaque) value += `, opaque="${opaque}", algorithm=MD5`;
  return value;
}

function hashed(password: string, algorithm: 'md5' | 'sha256'): string {
  return createHash(algorithm).update(password).digest('hex').toUpperCase();
}

/** Проверяет пароль так же, как его проверяет протокол Tapo для media-порта. */
export async function probeTapoAuth(
  host: string,
  cloudPassword: string,
  timeoutMs = 4000,
  port = TAPO_MEDIA_PORT,
): Promise<TapoAuthStatus> {
  let challenge: HttpHead;
  try {
    challenge = await readHead(host, port, timeoutMs);
  } catch {
    return 'unavailable';
  }
  if (challenge.status === 200) return 'ok';
  if (challenge.status !== 401) return 'unavailable';

  const www = challenge.headers['www-authenticate'] ?? '';
  if (!www.toLowerCase().startsWith('digest')) return 'unavailable';
  const advertised = www.slice('Digest'.length).trim();
  const preferred = authParam(advertised, 'encrypt_type') === '3'
    ? (['sha256', 'md5'] as const)
    : (['md5', 'sha256'] as const);

  for (const algorithm of preferred) {
    const authorization = digestAuthorization('admin', hashed(cloudPassword, algorithm), advertised);
    try {
      const result = await readHead(host, port, timeoutMs, authorization);
      if (result.status === 200) return 'ok';
    } catch {
      return 'unavailable';
    }
  }
  return 'unauthorized';
}
