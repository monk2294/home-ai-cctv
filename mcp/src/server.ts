import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlatformClient } from './client.js';
import { registerTools } from './tools.js';

export const MCP_SERVER_NAME = 'home-ai-cctv';
export const MCP_SERVER_VERSION = '0.1.0';

/** Stateless-сервер: вызывающий код создаёт новый экземпляр на каждый запрос. */
export function buildMcpServer(client: PlatformClient): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
  registerTools(server, client);
  return server;
}
