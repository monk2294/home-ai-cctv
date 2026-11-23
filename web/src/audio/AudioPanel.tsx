import { useEffect, useRef, useState } from 'react';
import { api, ApiRequestError } from '../api/client';
import type { AudioPlayback, Camera } from '../api/client';
import { audioDataToWav, MAX_DURATION_MS } from './wav';
import { Icon } from '../components/Icon';
import styles from './AudioPanel.module.css';

/**
 * Панель «Звук» на экране камеры (спецификация 50, T-21):
 * push-to-talk микрофон и воспроизведение WAV/MP3-файла через динамик камеры.
 */

type Phase = 'idle' | 'recording' | 'sending';

const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function AudioPanel({ camera }: { camera: Camera }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [active, setActive] = useState<AudioPlayback | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const autoStopRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    return () => {
      cleanupMic();
      if (autoStopRef.current !== null) window.clearTimeout(autoStopRef.current);
    };
  }, []);

  function cleanupMic(): void {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  async function sendWav(data: ArrayBuffer): Promise<void> {
    setPhase('sending');
    setMessage(null);
    try {
      const { blob } = await audioDataToWav(data);
      const playback = await api.playCameraAudio(camera.id, blob, 'audio/wav');
      setActive(playback);
      window.setTimeout(() => {
        setActive((current) => (current?.playback_id === playback.playback_id ? null : current));
      }, playback.duration_ms + 1_000);
    } catch (error) {
      setMessage(error instanceof ApiRequestError ? error.message : 'Нет связи с сервером');
    } finally {
      cleanupMic();
      setPhase('idle');
    }
  }

  function stopRecording(cancelled: boolean): void {
    if (autoStopRef.current !== null) {
      window.clearTimeout(autoStopRef.current);
      autoStopRef.current = null;
    }
    cancelledRef.current = cancelled;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    } else {
      cleanupMic();
      setPhase('idle');
    }
  }

  async function startRecording(): Promise<void> {
    if (phase !== 'idle') return;
    setMessage(null);
    cancelledRef.current = false;
    if (!window.isSecureContext) {
      setMessage('Микрофон недоступен: нужен защищённый HTTPS-адрес');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setMessage('Микрофон недоступен в этом браузере');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks: Blob[] = [];
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
      recorder.addEventListener('stop', () => {
        cleanupMic();
        if (cancelledRef.current) {
          setPhase('idle');
          return;
        }
        void new Blob(chunks, { type: mimeType })
          .arrayBuffer()
          .then(sendWav)
          .catch(() => {
            setPhase('idle');
            setMessage('Не удалось обработать запись');
          });
      });
      recorderRef.current = recorder;
      recorder.start();
      setPhase('recording');
      autoStopRef.current = window.setTimeout(() => stopRecording(false), MAX_DURATION_MS);
    } catch {
      cleanupMic();
      setMessage('Нет доступа к микрофону');
      setPhase('idle');
    }
  }

  async function stopFile(): Promise<void> {
    if (!active) return;
    try {
      await api.stopCameraAudioPlayback(camera.id, active.playback_id);
    } catch {
      // воспроизведение могло уже завершиться на сервере
    }
    setActive(null);
  }

  async function onPickFile(file: File | undefined): Promise<void> {
    if (!file) return;
    setMessage(null);
    if (file.size > MAX_FILE_BYTES) {
      setMessage('AUDIO_TOO_LARGE: файл больше 5 МиБ');
      return;
    }
    try {
      await sendWav(await file.arrayBuffer());
    } catch {
      setMessage('INVALID_AUDIO: файл не читается');
    }
  }

  const disabled = !camera.enabled || phase === 'sending';
  const micLabel =
    phase === 'recording' ? 'Отпустите, чтобы отправить' : phase === 'sending' ? 'Отправка…' : 'Зажмите, чтобы говорить';

  return (
    <section className={styles.panel} aria-label="Звук">
      <h3 className={styles.title}>Звук</h3>
      {camera.capabilities.audio_output === 'unsupported' && (
        <p className={styles.hint}>Камера не поддерживает передачу звука на динамик.</p>
      )}
      {camera.capabilities.audio_output === 'unknown' && (
        <p className={styles.hint}>
          Передача звука не подтверждена: команда принимается, но звук может не играть.
        </p>
      )}
      <button
        type="button"
        className={`${styles.micButton} ${phase === 'recording' ? styles.micRecording : ''}`}
        disabled={disabled}
        aria-label="Говорить в динамик камеры"
        title={micLabel}
        onPointerDown={() => void startRecording()}
        onPointerUp={() => stopRecording(false)}
        onPointerLeave={() => stopRecording(true)}
        onPointerCancel={() => stopRecording(true)}
      >
        <Icon name="mic" size={16} />
        <span>{micLabel}</span>
      </button>
      <label className={styles.fileButton}>
        <input
          type="file"
          accept="audio/wav,audio/mpeg,.wav,.mp3"
          className={styles.fileInput}
          onChange={(event) => {
            void onPickFile(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <span>Или выбрать файл WAV/MP3 (до 30 с)</span>
      </label>
      {active && (
        <div className={styles.playing}>
          <span>
            Играет {Math.ceil(active.duration_ms / 1000)} с
          </span>
          <button type="button" className={styles.stopButton} onClick={() => void stopFile()}>
            Остановить
          </button>
        </div>
      )}
      {message && (
        <p className={styles.error} role="alert">
          {message}
        </p>
      )}
    </section>
  );
}
