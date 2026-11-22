import { useCallback, useEffect, useRef, useState } from 'react';
import type HlsType from 'hls.js';
import { api, ApiRequestError } from '../api/client';
import type { PlaybackInfo } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import styles from './VideoPlayer.module.css';

type ModeChoice = 'auto' | 'webrtc' | 'hls';
type ActualMode = 'webrtc' | 'hls';
type Phase = 'idle' | 'connecting' | 'playing' | 'error';

interface Props {
  cameraId: string;
  /** Камера включена; для disabled плеер не запускается. */
  enabled: boolean;
}

const WEBRTC_TIMEOUT_MS = 8000;

function toWebSocketUrl(relative: string): string {
  const url = new URL(relative, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/**
 * Плеер камеры: Auto/WebRTC/HLS, fallback по спецификации 20 §7.
 * Один активный pipeline; размонтирование закрывает PC, WebSocket и HLS loader.
 */
export function VideoPlayer({ cameraId, enabled }: Props) {
  const { markAnonymous } = useAuth();
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [choice, setChoice] = useState<ModeChoice>('auto');
  const [actual, setActual] = useState<ActualMode | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(1);
  const [audioAvailable, setAudioAvailable] = useState<boolean | null>(null);

  // Громкость сохраняется в памяти страницы при переключении режимов.
  const soundRef = useRef({ muted: true, volume: 1 });
  soundRef.current = { muted, volume };

  const applySound = useCallback((video: HTMLVideoElement) => {
    video.muted = soundRef.current.muted;
    video.volume = soundRef.current.volume;
  }, []);

  useEffect(() => {
    if (!enabled) {
      setPhase('idle');
      setActual(null);
      return;
    }
    const video = videoRef.current;
    if (!video) return;

    let disposed = false;
    let pc: RTCPeerConnection | null = null;
    let ws: WebSocket | null = null;
    let hls: HlsType | null = null;
    let webrtcTimer: ReturnType<typeof setTimeout> | null = null;
    let playing = false;

    setPhase('connecting');
    setError(null);
    setActual(null);
    setAudioAvailable(null);

    const cleanup = () => {
      disposed = true;
      if (webrtcTimer) clearTimeout(webrtcTimer);
      if (ws) {
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
        ws = null;
      }
      if (pc) {
        pc.ontrack = null;
        pc.onicecandidate = null;
        pc.onconnectionstatechange = null;
        pc.close();
        pc = null;
      }
      if (hls) {
        hls.destroy();
        hls = null;
      }
      video.srcObject = null;
      video.removeAttribute('src');
      video.load();
    };

    const onPlaying = () => {
      if (disposed) return;
      playing = true;
      if (webrtcTimer) {
        clearTimeout(webrtcTimer);
        webrtcTimer = null;
      }
      setPhase('playing');
    };
    video.addEventListener('playing', onPlaying);

    const fail = (message: string) => {
      if (disposed) return;
      cleanup();
      video.removeEventListener('playing', onPlaying);
      setPhase('error');
      setError(message);
    };

    const startHls = async (playlistUrl: string) => {
      if (disposed) return;
      setActual('hls');
      applySound(video);
      // hls.js грузится отдельным chunk только при запуске HLS.
      const { default: Hls } = await import('hls.js');
      if (disposed) return;
      if (hls) {
        hls.destroy();
        hls = null;
      }
      if (Hls.isSupported()) {
        hls = new Hls({
          manifestLoadingMaxRetry: 2,
          levelLoadingMaxRetry: 2,
          fragLoadingMaxRetry: 2,
          liveDurationInfinity: true,
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            fail('HLS-поток недоступен. Повторите попытку.');
          }
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (disposed) return;
          const hasAudio = (hls?.audioTracks.length ?? 0) > 0;
          setAudioAvailable(hasAudio);
          void video.play().catch(() => {
            // autoplay policy: видео уже muted, ошибка редкая
          });
        });
        hls.loadSource(playlistUrl);
        hls.attachMedia(video);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = playlistUrl;
        setAudioAvailable(null);
        void video.play().catch(() => undefined);
      } else {
        fail('Браузер не поддерживает HLS.');
      }
    };

    const startWebRtc = (signalingUrl: string, fallback: (() => void) | null) => {
      if (disposed) return;
      setActual('webrtc');
      let ended = false;
      const giveUp = (message: string) => {
        if (disposed || ended) return;
        ended = true;
        if (webrtcTimer) {
          clearTimeout(webrtcTimer);
          webrtcTimer = null;
        }
        if (ws) {
          // Обработчики снимаются до close, чтобы onclose не запустил fallback повторно.
          ws.onmessage = null;
          ws.onclose = null;
          ws.onerror = null;
          ws.close();
          ws = null;
        }
        if (pc) {
          pc.ontrack = null;
          pc.onicecandidate = null;
          pc.onconnectionstatechange = null;
          pc.close();
          pc = null;
        }
        video.srcObject = null;
        if (fallback) {
          fallback();
        } else {
          fail(message);
        }
      };

      webrtcTimer = setTimeout(() => {
        if (!playing) giveUp('WebRTC не запустился за 8 секунд.');
      }, WEBRTC_TIMEOUT_MS);

      pc = new RTCPeerConnection();
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });

      pc.onicecandidate = (ev) => {
        if (disposed || !ws || ws.readyState !== WebSocket.OPEN) return;
        const candidate = ev.candidate ? ev.candidate.toJSON().candidate : '';
        ws.send(JSON.stringify({ type: 'webrtc/candidate', value: candidate }));
      };

      pc.ontrack = (ev) => {
        if (disposed) return;
        const stream = ev.streams[0] ?? new MediaStream([ev.track]);
        video.srcObject = stream;
        applySound(video);
        setAudioAvailable(stream.getAudioTracks().length > 0);
        void video.play().catch(() => undefined);
      };

      pc.onconnectionstatechange = () => {
        if (disposed || !pc) return;
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          giveUp('WebRTC-соединение разорвано.');
        }
      };

      ws = new WebSocket(toWebSocketUrl(signalingUrl));
      ws.onmessage = (message) => {
        if (disposed || !pc) return;
        let msg: { type: string; value?: string };
        try {
          msg = JSON.parse(String(message.data)) as { type: string; value?: string };
        } catch {
          return;
        }
        if (msg.type === 'webrtc/answer' && msg.value) {
          void pc.setRemoteDescription({ type: 'answer', sdp: msg.value }).catch(() => {
            giveUp('WebRTC: ошибка SDP-ответа.');
          });
        } else if (msg.type === 'webrtc/candidate' && msg.value) {
          void pc.addIceCandidate({ candidate: msg.value, sdpMid: '0' }).catch(() => undefined);
        } else if (msg.type === 'error') {
          giveUp('WebRTC: медиашлюз вернул ошибку.');
        }
      };
      ws.onerror = () => giveUp('WebRTC: ошибка signaling-соединения.');
      ws.onclose = () => {
        if (!playing) giveUp('WebRTC: signaling-соединение закрыто.');
      };
      ws.onopen = () => {
        if (disposed || !pc) return;
        void pc
          .createOffer()
          .then((offer) => pc!.setLocalDescription(offer))
          .then(() => {
            if (disposed || !ws || !pc) return;
            ws.send(JSON.stringify({ type: 'webrtc/offer', value: pc.localDescription?.sdp ?? '' }));
          })
          .catch(() => giveUp('WebRTC: не удалось создать offer.'));
      };
    };

    const run = async () => {
      let playback: PlaybackInfo;
      try {
        playback = await api.playback(cameraId);
      } catch (err) {
        if (disposed) return;
        if (err instanceof ApiRequestError && err.status === 401) {
          markAnonymous();
          return;
        }
        if (err instanceof ApiRequestError && err.status === 409) {
          fail('Камера отключена. Включите её в настройках.');
          return;
        }
        if (err instanceof ApiRequestError && err.status === 403) {
          fail('Нет прав доступа к воспроизведению.');
          return;
        }
        if (err instanceof ApiRequestError && [502, 503, 504].includes(err.status)) {
          fail('Медиашлюз временно недоступен. Повторите попытку.');
          return;
        }
        fail('Не удалось получить параметры воспроизведения.');
        return;
      }
      if (disposed) return;

      const webrtcUrl = playback.webrtc?.signaling_url ?? null;
      const hlsUrl = playback.hls?.playlist_url ?? null;

      const order: ActualMode[] =
        choice === 'webrtc'
          ? ['webrtc']
          : choice === 'hls'
            ? ['hls']
            : playback.preferred === 'webrtc'
              ? ['webrtc', 'hls']
              : ['hls', 'webrtc'];

      const tryMode = (mode: ActualMode, isLast: boolean) => {
        const nextMode = order[order.indexOf(mode) + 1];
        const fallback = isLast || !nextMode ? null : () => tryMode(nextMode, true);
        if (mode === 'webrtc') {
          if (!webrtcUrl) {
            if (fallback) fallback();
            else fail('WebRTC недоступен для этой камеры.');
            return;
          }
          startWebRtc(webrtcUrl, fallback);
        } else {
          if (!hlsUrl) {
            if (fallback) fallback();
            else fail('HLS недоступен для этой камеры.');
            return;
          }
          startHls(hlsUrl);
        }
      };

      // В Auto HLS — последний рубеж без fallback; WebRTC может упасть в HLS.
      const first = order[0] ?? 'hls';
      if (choice === 'auto' && first === 'hls') {
        tryMode('hls', true);
      } else {
        tryMode(first, order.length === 1);
      }
    };

    void run();

    return () => {
      video.removeEventListener('playing', onPlaying);
      cleanup();
    };
  }, [cameraId, enabled, choice, attempt, applySound, markAnonymous]);

  const toggleMute = () => {
    const video = videoRef.current;
    const next = !muted;
    setMuted(next);
    if (video) video.muted = next;
  };

  const changeVolume = (value: number) => {
    setVolume(value);
    const video = videoRef.current;
    if (video) video.volume = value;
    if (value > 0 && muted) {
      setMuted(false);
      if (video) video.muted = false;
    }
  };

  const toggleFullscreen = () => {
    const container = containerRef.current;
    if (!container) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void container.requestFullscreen().catch(() => undefined);
    }
  };

  const modeLabel = actual === 'webrtc' ? 'WebRTC' : actual === 'hls' ? 'HLS' : null;

  return (
    <div className={styles.player} ref={containerRef}>
      <div className={styles.screen}>
        <video ref={videoRef} className={styles.video} playsInline muted={muted} />
        {phase !== 'playing' && (
          <div className={styles.overlay}>
            {phase === 'connecting' && <span className={styles.overlayText}>Подключение…</span>}
            {phase === 'idle' && <span className={styles.overlayText}>Камера отключена</span>}
            {phase === 'error' && (
              <div className={styles.errorBox} role="alert">
                <span className={styles.overlayText}>{error}</span>
                <Button variant="primary" onClick={() => setAttempt((a) => a + 1)}>
                  Повторить
                </Button>
              </div>
            )}
          </div>
        )}
        {modeLabel && phase === 'playing' && <span className={styles.modeBadge}>{modeLabel}</span>}
      </div>
      <div className={styles.controls}>
        <div className={styles.modeSwitch} role="group" aria-label="Режим воспроизведения">
          {(['auto', 'webrtc', 'hls'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`${styles.modeButton} ${choice === mode ? styles.modeActive : ''}`}
              aria-pressed={choice === mode}
              onClick={() => setChoice(mode)}
            >
              {mode === 'auto' ? 'Auto' : mode === 'webrtc' ? 'WebRTC' : 'HLS'}
            </button>
          ))}
        </div>
        <div className={styles.sound}>
          <button
            type="button"
            className={styles.soundButton}
            onClick={toggleMute}
            disabled={audioAvailable === false}
            aria-label={muted ? 'Включить звук' : 'Выключить звук'}
            aria-pressed={!muted}
          >
            <Icon name="sound" size={14} />
            {audioAvailable === false ? 'Звук недоступен' : muted ? 'Звук выключен' : 'Звук включён'}
          </button>
          <input
            className={styles.volume}
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            disabled={audioAvailable === false}
            aria-label="Громкость"
            onChange={(e) => changeVolume(Number(e.target.value))}
          />
        </div>
        <button
          type="button"
          className={styles.soundButton}
          onClick={toggleFullscreen}
          aria-label="Полноэкранный режим"
        >
          Полный экран
        </button>
      </div>
    </div>
  );
}