import { loadConfig } from './config.js';
import { PlatformClient } from './client.js';
import { createMcpHttpServer } from './http-server.js';

const config = loadConfig();

const httpServer = createMcpHttpServer({
  aiApiToken: config.aiApiToken,
  createClient: () => new PlatformClient(config.serverApiBaseUrl, config.aiApiToken),
  logError: (message) => console.error('mcp: необработанная ошибка:', message),
});

httpServer.listen(config.port, config.host, () => {
  console.log(`mcp: слушает http://${config.host}:${config.port}/mcp`);
});
