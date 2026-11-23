import { useNavigate } from 'react-router-dom';
import type { Camera } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useEvents } from '../events/EventsContext';
import { useSnapshotPolling } from '../hooks/useSnapshotPolling';
import { Icon } from './Icon';
import { StatusPill } from './StatusPill';
import styles from './CameraTile.module.css';

interface Props {
  camera: Camera;
  index: number;
  onEdit: (camera: Camera) => void;
  onDelete: (camera: Camera) => void;
}

function capabilityMark(state: string): string {
  if (state === 'supported') return '+';
  if (state === 'unsupported') return '−';
  return '?';
}

/** Карточка камеры: снимок (polling 1 с), бейдж CAM, имя, возможности, ошибка, состояние, правка/удаление. */
export function CameraTile({ camera, index, onEdit, onDelete }: Props) {
  const navigate = useNavigate();
  const { markAnonymous } = useAuth();
  const { buffer } = useEvents();
  const pollingActive = camera.enabled && camera.state === 'online';
  const { containerRef, blobUrl } = useSnapshotPolling({
    cameraId: camera.id,
    width: 640,
    active: pollingActive,
    onUnauthorized: markAnonymous,
  });

  const lastEvent = buffer.find((e) => e.camera_id === camera.id);
  const motionActive = lastEvent?.state === 'active';

  const showImage = pollingActive && blobUrl !== null;
  const camLabel = `CAM ${String(index + 1).padStart(2, '0')}`;
  const caps = camera.capabilities;

  return (
    <article
      className={styles.tile}
      onClick={() => navigate(`/cameras/${camera.id}`)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') navigate(`/cameras/${camera.id}`);
      }}
      role="link"
      tabIndex={0}
      aria-label={`Камера ${camera.name}`}
    >
      <div className={styles.media} ref={containerRef}>
        {showImage ? (
          <img
            className={styles.image}
            src={blobUrl ?? ''}
            alt={`Снимок камеры ${camera.name}`}
            loading="lazy"
          />
        ) : (
          <div className={styles.placeholder} aria-hidden="true" />
        )}
        <span className={styles.badge}>{camLabel}</span>
        {motionActive && <span className={styles.motionBadge}>Движение</span>}
      </div>
      <div className={styles.footer}>
        <div className={styles.info}>
          <h3 className={styles.name}>{camera.name}</h3>
          <p className={styles.meta}>
            Звук {capabilityMark(caps.audio)} · Движение {capabilityMark(caps.motion_events)} · PTZ{' '}
            {capabilityMark(caps.ptz_continuous)}
            {lastEvent
              ? ` · ${new Date(lastEvent.occurred_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
              : ''}
          </p>
          {camera.last_error && (
            <p className={styles.errorLine}>
              {camera.last_error.code}: {camera.last_error.message}
            </p>
          )}
        </div>
        <div className={styles.actions}>
          <StatusPill state={camera.state} />
          <button
            type="button"
            className={styles.iconButton}
            aria-label={`Изменить камеру ${camera.name}`}
            title="Настройки"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(camera);
            }}
          >
            <Icon name="edit" size={12} />
          </button>
          <button
            type="button"
            className={`${styles.iconButton} ${styles.deleteButton}`}
            aria-label={`Удалить камеру ${camera.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onDelete(camera);
            }}
          >
            <Icon name="delete" size={12} />
          </button>
        </div>
      </div>
    </article>
  );
}

/** Плитка «Добавить камеру» из дизайна. */
export function AddCameraTile() {
  const navigate = useNavigate();
  return (
    <button type="button" className={styles.addTile} onClick={() => navigate('/cameras/new')}>
      <span className={styles.addIcon}>
        <Icon name="plus" size={22} />
      </span>
      <span className={styles.addTitle}>Добавить камеру</span>
      <span className={styles.addMeta}>Подключение по RTSP или ONVIF</span>
    </button>
  );
}