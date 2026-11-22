import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiRequestError } from '../api/client';
import type { Camera, PtzPreset } from '../api/client';
import { Icon } from '../components/Icon';
import type { IconName } from '../components/Icon';
import styles from './PtzPanel.module.css';

interface Props {
  camera: Camera;
}

interface Direction {
  icon: IconName;
  label: string;
  pan: number;
  tilt: number;
  zoom: number;
}

const DIRECTIONS: Direction[] = [
  { icon: 'ptz-upleft', label: 'Вверх и влево', pan: -0.5, tilt: 0.5, zoom: 0 },
  { icon: 'ptz-up', label: 'Вверх', pan: 0, tilt: 0.5, zoom: 0 },
  { icon: 'ptz-upright', label: 'Вверх и вправо', pan: 0.5, tilt: 0.5, zoom: 0 },
  { icon: 'ptz-left', label: 'Влево', pan: -0.5, tilt: 0, zoom: 0 },
  { icon: 'ptz-home', label: 'Стоп', pan: 0, tilt: 0, zoom: 0 },
  { icon: 'ptz-right', label: 'Вправо', pan: 0.5, tilt: 0, zoom: 0 },
  { icon: 'ptz-downleft', label: 'Вниз и влево', pan: -0.5, tilt: -0.5, zoom: 0 },
  { icon: 'ptz-down', label: 'Вниз', pan: 0, tilt: -0.5, zoom: 0 },
  { icon: 'ptz-downright', label: 'Вниз и вправо', pan: 0.5, tilt: -0.5, zoom: 0 },
];

const MOVE_DURATION_MS = 5000;

/** PTZ-панель по спецификации 20 §8: Move на удержание, Stop на отпускание. */
export function PtzPanel({ camera }: Props) {
  const capability = camera.capabilities.ptz_continuous;
  const presetsCapability = camera.capabilities.ptz_presets;
  const [presets, setPresets] = useState<PtzPreset[] | null>(null);
  const [pendingPreset, setPendingPreset] = useState<string | null>(null);
  const [ptzError, setPtzError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const movingRef = useRef(false);
  const cameraIdRef = useRef(camera.id);
  cameraIdRef.current = camera.id;

  const supported = capability === 'supported';

  const loadPresets = useCallback(() => {
    if (presetsCapability !== 'supported') return;
    api
      .ptzPresets(camera.id)
      .then(setPresets)
      .catch(() => setPresets([]));
  }, [camera.id, presetsCapability]);

  useEffect(() => {
    loadPresets();
  }, [loadPresets]);

  const stop = useCallback(() => {
    if (!movingRef.current) return;
    movingRef.current = false;
    setBusy(false);
    api.ptzStop(cameraIdRef.current).catch(() => undefined);
  }, []);

  // Best effort Stop при размонтировании.
  useEffect(() => stop, [stop]);

  const move = useCallback(
    (direction: Direction) => {
      if (movingRef.current) return;
      if (direction.icon === 'ptz-home') {
        movingRef.current = false;
        setBusy(false);
        api.ptzStop(cameraIdRef.current).catch(() => undefined);
        return;
      }
      movingRef.current = true;
      setBusy(true);
      setPtzError(null);
      api
        .ptzMove(cameraIdRef.current, direction.pan, direction.tilt, direction.zoom, MOVE_DURATION_MS)
        .catch((err: unknown) => {
          movingRef.current = false;
          setBusy(false);
          if (err instanceof ApiRequestError) {
            setPtzError(`${err.code}: ${err.message}`);
            if (err.code === 'CAPABILITY_UNSUPPORTED') {
              // возможности устарели — панель скроется после обновления камеры
            }
          } else {
            setPtzError('PTZ: нет связи с сервером');
          }
        });
    },
    [stop],
  );

  const gotoPreset = useCallback(
    (token: string) => {
      if (pendingPreset) return;
      setPendingPreset(token);
      setPtzError(null);
      api
        .ptzGotoPreset(camera.id, token)
        .catch((err: unknown) => {
          if (err instanceof ApiRequestError && err.code === 'PRESET_NOT_FOUND') {
            loadPresets();
          } else if (err instanceof ApiRequestError) {
            setPtzError(`${err.code}: ${err.message}`);
          } else {
            setPtzError('PTZ: нет связи с сервером');
          }
        })
        .finally(() => setPendingPreset(null));
    },
    [camera.id, pendingPreset, loadPresets],
  );

  if (capability === 'unsupported') {
    return null;
  }

  if (capability !== 'supported') {
    return (
      <section className={styles.panel} aria-label="PTZ">
        <h3 className={styles.title}>Поворот и наклон</h3>
        <p className={styles.diagnostic}>
          Поддержка PTZ не подтверждена камерой. Управление недоступно до подтверждения.
        </p>
      </section>
    );
  }

  return (
    <section className={styles.panel} aria-label="PTZ">
      <h3 className={styles.title}>Поворот и наклон</h3>
      <div className={styles.grid}>
        {DIRECTIONS.map((direction) => (
          <button
            key={direction.icon}
            type="button"
            className={`${styles.padButton} ${direction.icon === 'ptz-home' ? styles.stopButton : ''}`}
            aria-label={direction.label}
            disabled={busy && direction.icon !== 'ptz-home'}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              move(direction);
            }}
            onPointerUp={stop}
            onPointerCancel={stop}
            onLostPointerCapture={stop}
            onKeyDown={(e) => {
              if (e.repeat) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                move(direction);
              }
            }}
            onKeyUp={(e) => {
              if (e.key === 'Enter' || e.key === ' ') stop();
            }}
            onBlur={stop}
          >
            <Icon name={direction.icon} size={16} />
          </button>
        ))}
      </div>
      <div className={styles.zoomRow}>
        <button
          type="button"
          className={styles.zoomButton}
          aria-label="Уменьшить масштаб"
          disabled={busy}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            move({ icon: 'zoom-out', label: 'Уменьшить', pan: 0, tilt: 0, zoom: -0.5 });
          }}
          onPointerUp={stop}
          onPointerCancel={stop}
          onLostPointerCapture={stop}
          onKeyDown={(e) => {
            if (!e.repeat && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              move({ icon: 'zoom-out', label: 'Уменьшить', pan: 0, tilt: 0, zoom: -0.5 });
            }
          }}
          onKeyUp={(e) => {
            if (e.key === 'Enter' || e.key === ' ') stop();
          }}
          onBlur={stop}
        >
          <Icon name="zoom-out" size={14} />
        </button>
        <span className={styles.zoomLabel}>Масштаб</span>
        <button
          type="button"
          className={styles.zoomButton}
          aria-label="Увеличить масштаб"
          disabled={busy}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            move({ icon: 'zoom-in', label: 'Увеличить', pan: 0, tilt: 0, zoom: 0.5 });
          }}
          onPointerUp={stop}
          onPointerCancel={stop}
          onLostPointerCapture={stop}
          onKeyDown={(e) => {
            if (!e.repeat && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              move({ icon: 'zoom-in', label: 'Увеличить', pan: 0, tilt: 0, zoom: 0.5 });
            }
          }}
          onKeyUp={(e) => {
            if (e.key === 'Enter' || e.key === ' ') stop();
          }}
          onBlur={stop}
        >
          <Icon name="zoom-in" size={14} />
        </button>
      </div>
      {presetsCapability === 'supported' && presets && presets.length > 0 && (
        <div className={styles.presets}>
          <span className={styles.presetsLabel}>Пресеты</span>
          <div className={styles.presetList}>
            {presets.map((preset) => (
              <button
                key={preset.token}
                type="button"
                className={styles.presetButton}
                disabled={pendingPreset !== null}
                onClick={() => gotoPreset(preset.token)}
              >
                <Icon name="preset" size={12} />
                {pendingPreset === preset.token ? '…' : preset.name}
              </button>
            ))}
          </div>
        </div>
      )}
      {ptzError && (
        <p className={styles.error} role="alert">
          {ptzError}
        </p>
      )}
    </section>
  );
}