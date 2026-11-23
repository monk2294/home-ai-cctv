import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PlatformClient, UpstreamError } from './client.js';

/**
 * Инструменты MCP (спецификация 60 §2).
 * Описания содержат правила использования: MCP не только вызывает API, но и учит агента.
 */

/** Лимит WAV на воспроизведение — зеркало server/src/audio/playback.ts. */
const MAX_WAV_BYTES = 5 * 1024 * 1024;
const MAX_WAV_B64_CHARS = Math.ceil(MAX_WAV_BYTES / 3) * 4;

const cameraId = z.string().min(1).describe('ID камеры из cameras_list');

const AUDIO_OUTPUT_RULE =
  'Перед воспроизведением проверь capabilities.audio_output == "supported" через camera_get; ' +
  'иначе воспроизведение бесполезно (no-op). Платформа локальная: не играй звук ночью без запроса владельца.';

function toMcpError(error: unknown): McpError {
  if (error instanceof UpstreamError) {
    switch (error.status) {
      case 400:
      case 404:
      case 409:
      case 413:
      case 415:
      case 422:
        return new McpError(ErrorCode.InvalidParams, `${error.code}: ${error.message}`);
      default:
        return new McpError(ErrorCode.InternalError, `${error.code}: ${error.message}`);
    }
  }
  if (error instanceof McpError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new McpError(ErrorCode.InternalError, message);
}

function textResult(structuredContent: Record<string, unknown>): { content: { type: 'text'; text: string }[]; structuredContent: Record<string, unknown> } {
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
}

function decodeWavBase64(wavBase64: string): Buffer {
  if (wavBase64.length > MAX_WAV_B64_CHARS) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `WAV больше лимита ${MAX_WAV_BYTES} байт (base64 длиной ${wavBase64.length})`,
    );
  }
  const wav = Buffer.from(wavBase64, 'base64');
  if (wav.length === 0 || wav.toString('base64').replace(/=+$/, '') !== wavBase64.replace(/=+$/, '')) {
    throw new McpError(ErrorCode.InvalidParams, 'wav_base64 не является корректным base64');
  }
  if (wav.length > MAX_WAV_BYTES) {
    throw new McpError(ErrorCode.InvalidParams, `WAV больше лимита ${MAX_WAV_BYTES} байт`);
  }
  return wav;
}

export function registerTools(server: McpServer, client: PlatformClient): void {
  server.registerTool(
    'cameras_list',
    {
      description:
        'Список камер: id, имя, состояние (online/offline/disabled/degraded/connecting), capabilities и last_error. ' +
        'Начни с этого инструмента: отсюда берутся camera_id и capabilities.',
    },
    async () => {
      try {
        return textResult({ cameras: await client.listCameras() });
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    'camera_get',
    {
      description:
        'Состояние одной камеры: state, capabilities, last_error. ' +
        'Проверяй capabilities.audio_output перед camera_play_audio и capabilities.ptz_* перед PTZ.',
      inputSchema: { camera_id: cameraId },
    },
    async ({ camera_id }) => {
      try {
        return textResult({ camera: await client.getCamera(camera_id) });
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    'camera_snapshot',
    {
      description:
        'Один кадр с камеры (JPEG) в ответе инструмента. ' +
        'Используй для разовой визуальной проверки; для длительного наблюдения открой MJPEG-стрим напрямую, не через MCP.',
      inputSchema: {
        camera_id: cameraId,
        width: z.number().int().min(64).max(1920).optional().describe('Ширина кадра, пиксели (64–1920)'),
      },
    },
    async ({ camera_id, width }) => {
      try {
        const jpeg = await client.snapshot(camera_id, width);
        const structuredContent = { camera_id, width: width ?? null, bytes: jpeg.length };
        return {
          content: [
            { type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' },
            { type: 'text', text: JSON.stringify(structuredContent) },
          ],
          structuredContent,
        };
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    'camera_listen',
    {
      description:
        'Записать фрагмент звука с микрофона камеры (WAV, base64 в ответе). ' +
        'Передай его STT или анализу. Не сохраняй файл без нужды. Не вызывай чаще, чем требует задача.',
      inputSchema: {
        camera_id: cameraId,
        duration_ms: z
          .number()
          .int()
          .min(1000)
          .max(15_000)
          .default(5000)
          .describe('Длительность записи, мс (1000–15000)'),
      },
    },
    async ({ camera_id, duration_ms }) => {
      try {
        const wav = await client.listen(camera_id, duration_ms);
        const structuredContent = { camera_id, duration_ms, bytes: wav.length };
        return {
          content: [
            {
              type: 'resource',
              resource: {
                uri: `cctv://cameras/${camera_id}/listen.wav`,
                blob: wav.toString('base64'),
                mimeType: 'audio/wav',
              },
            },
            { type: 'text', text: JSON.stringify(structuredContent) },
          ],
          structuredContent,
        };
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    'camera_play_audio',
    {
      description:
        'Воспроизвести готовый WAV на динамике камеры. Формат: WAV PCM; не более 5 МиБ и 30 секунд. ' +
        AUDIO_OUTPUT_RULE,
      inputSchema: {
        camera_id: cameraId,
        wav_base64: z
          .string()
          .min(1)
          .describe('Готовый WAV-файл в base64 (PCM). MCP генерацию не выполняет.'),
      },
    },
    async ({ camera_id, wav_base64 }) => {
      try {
        const playback = await client.playAudio(camera_id, decodeWavBase64(wav_base64));
        return textResult({ playback });
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    'camera_stop_audio',
    {
      description:
        'Прервать воспроизведение по playback_id из camera_play_audio. ' +
        'Завершившееся само воспроизведение остановке не подлежит (404 — норма).',
      inputSchema: { camera_id: cameraId, playback_id: z.string().min(1).describe('ID воспроизведения') },
    },
    async ({ camera_id, playback_id }) => {
      try {
        await client.stopAudio(camera_id, playback_id);
        return textResult({ stopped: playback_id });
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  const moveSchema = {
    camera_id: cameraId,
    pan: z.number().min(-1).max(1).describe('Горизонталь, -1..1'),
    tilt: z.number().min(-1).max(1).describe('Вертикаль, -1..1'),
    zoom: z.number().min(-1).max(1).describe('Зум, -1..1'),
    duration_ms: z.number().int().min(100).max(5000).default(1000).describe('Длительность движения, мс'),
  };

  server.registerTool(
    'ptz_move',
    {
      description:
        'Непрерывное движение PTZ. Требует capabilities.ptz_continuous == "supported". ' +
        'Движение останови через ptz_stop или дождись конца duration_ms.',
      inputSchema: moveSchema,
    },
    async ({ camera_id, pan, tilt, zoom, duration_ms }) => {
      try {
        await client.ptzMove(camera_id, { pan, tilt, zoom, durationMs: duration_ms });
        return textResult({ moved: camera_id, duration_ms });
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    'ptz_stop',
    {
      description: 'Остановить текущее PTZ-движение камеры.',
      inputSchema: { camera_id: cameraId },
    },
    async ({ camera_id }) => {
      try {
        await client.ptzStop(camera_id);
        return textResult({ stopped: camera_id });
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    'ptz_presets',
    {
      description: 'Список PTZ-пресетов камеры (token и имена). Используй с ptz_goto.',
      inputSchema: { camera_id: cameraId },
    },
    async ({ camera_id }) => {
      try {
        return textResult({ presets: await client.ptzPresets(camera_id) });
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    'ptz_goto',
    {
      description: 'Переместить камеру на PTZ-пресет по token из ptz_presets.',
      inputSchema: { camera_id: cameraId, preset_token: z.string().min(1).describe('Token пресета') },
    },
    async ({ camera_id, preset_token }) => {
      try {
        await client.ptzGoto(camera_id, preset_token);
        return textResult({ goto: preset_token });
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );
}
