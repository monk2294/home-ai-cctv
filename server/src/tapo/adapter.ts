import { createOnvifClient, LibOnvifSession } from '../onvif/adapter.js';
import {
  AdapterNotApplicableError,
  type CameraAdapter,
  type CameraConnection,
  type CameraSession,
  type ProbeResult,
} from '../cameras/adapter.js';
import { probeTapoAuth, type TapoAuthStatus } from './auth.js';

const TAPO_MODEL_MARKER = 'C520WS';

function isTapoModel(model: string | null): boolean {
  return model != null && model.trim().toUpperCase().includes(TAPO_MODEL_MARKER);
}

function tapoSource(conn: CameraConnection): string {
  return `tapo://${encodeURIComponent(conn.password)}@${conn.host}`;
}

/** Tapo использует ONVIF для видео, PTZ и событий, а динамик открывает через tapo://. */
export class TapoSession extends LibOnvifSession {
  constructor(client: ConstructorParameters<typeof LibOnvifSession>[0], conn: CameraConnection) {
    super(client, conn);
  }

  override async getMediaSources(profileToken: string): Promise<string[]> {
    return [await this.getRtspSource(profileToken), tapoSource(this.conn)];
  }

  override async ptzContinuousMove(pan: number, tilt: number, zoom: number, _timeoutMs: number): Promise<void> {
    // C520WS рвёт соединение на Timeout. Останавливает сервер по своему таймеру.
    await this.client.ptz.continuousMove({ velocity: { x: pan, y: tilt, zoom } });
  }
}

export class TapoC520wsAdapter implements CameraAdapter {
  readonly id = 'tapo-c520ws';
  readonly displayName = 'Tapo C520WS';

  constructor(
    private readonly onvif: CameraAdapter,
    private readonly auth: (host: string, password: string) => Promise<TapoAuthStatus> = probeTapoAuth,
  ) {}

  async probe(conn: CameraConnection): Promise<ProbeResult> {
    let result: ProbeResult;
    try {
      result = await this.onvif.probe(conn);
    } catch {
      throw new AdapterNotApplicableError('ONVIF не ответил');
    }
    if (!isTapoModel(result.device.model)) {
      throw new AdapterNotApplicableError('Модель не C520WS');
    }

    const auth = await this.auth(conn.host, conn.password);
    if (auth !== 'ok') {
      return {
        ...result,
        capabilities: { ...result.capabilities, audio_output: 'unsupported' },
        diagnostics: [
          ...result.diagnostics,
          {
            check: 'audio_output',
            status: 'error',
            message: auth === 'unauthorized'
              ? 'Tapo не принял пароль динамика. Проверьте облачный пароль и Third-Party Compatibility.'
              : 'Tapo media-порт 8800 недоступен. Проверьте сеть и настройки камеры.',
          },
        ],
      };
    }

    return {
      ...result,
      capabilities: { ...result.capabilities, audio_output: 'supported' },
      diagnostics: [
        ...result.diagnostics,
        { check: 'audio_output', status: 'ok', message: 'Динамик Tapo доступен через tapo://' },
      ],
    };
  }

  async open(conn: CameraConnection): Promise<CameraSession> {
    const client = createOnvifClient(conn);
    await client.connect();
    return new TapoSession(client, conn);
  }
}
