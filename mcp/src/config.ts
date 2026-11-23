import { readFileSync } from 'node:fs';

export interface McpConfig {
  port: number;
  host: string;
  /** Базовый URL AI HTTP API server. */
  serverApiBaseUrl: string;
  /** Bearer-токен ИИ-агента: проверяет входящие запросы и ходит в server. */
  aiApiToken: string;
}

function readTokenFile(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    throw new Error(`Не удалось прочитать AI_API_TOKEN_FILE: ${path}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const token = env.AI_API_TOKEN ?? readTokenFile(env.AI_API_TOKEN_FILE ?? '/run/secrets/ai_api_token');
  if (!token) {
    throw new Error('AI_API_TOKEN пуст: задайте AI_API_TOKEN или AI_API_TOKEN_FILE');
  }
  const port = env.MCP_PORT !== undefined ? Number(env.MCP_PORT) : 3000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Некорректный MCP_PORT: ${env.MCP_PORT}`);
  }
  return {
    port,
    host: env.MCP_BIND ?? '0.0.0.0',
    serverApiBaseUrl: (env.SERVER_API_BASE_URL ?? 'http://server:8000').replace(/\/+$/, ''),
    aiApiToken: token,
  };
}
