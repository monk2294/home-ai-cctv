import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { PlatformClient } from './client.js';
import { buildMcpServer } from './server.js';

/** HTTP-обёртка MCP endpoint (спецификация 60). Stateless Streamable HTTP: сессии не используются. */

export const BODY_LIMIT_BYTES = 16 * 1024 * 1024;

export interface McpHttpServerOptions {
  aiApiToken: string;
  createClient: () => PlatformClient;
  logError?: (message: string) => void;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization ?? '';
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) {
    return false;
  }
  const provided = createHash('sha256').update(header.slice(prefix.length)).digest();
  const expected = createHash('sha256').update(token).digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Тело запроса превышает лимит'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function jsonRpcError(code: number, message: string): unknown {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

export function createMcpHttpServer(options: McpHttpServerOptions): Server {
  async function handleMcp(request: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, 400, jsonRpcError(-32700, 'Плохой JSON'));
      return;
    }

    const mcp = buildMcpServer(options.createClient());
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(request, res, parsed);
  }

  return createServer((request, res) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (url.pathname !== '/mcp') {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      if (request.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' });
        res.end();
        return;
      }
      if (!isAuthorized(request, options.aiApiToken)) {
        sendJson(res, 401, jsonRpcError(-32001, 'Нужен Authorization: Bearer <ai_api_token>'));
        return;
      }
      let body: Buffer;
      try {
        body = await readBody(request, BODY_LIMIT_BYTES);
      } catch {
        sendJson(res, 413, jsonRpcError(-32000, 'Тело запроса больше 16 МиБ'));
        return;
      }
      await handleMcp(request, res, body);
    })().catch((error: unknown) => {
      options.logError?.(error instanceof Error ? error.message : String(error));
      if (!res.headersSent) {
        sendJson(res, 500, jsonRpcError(-32603, 'Внутренняя ошибка'));
      } else {
        res.end();
      }
    });
  });
}
