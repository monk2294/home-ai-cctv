import { Link } from 'react-router-dom';
import type { CameraEvent } from '../api/client';
import styles from './EventRow.module.css';

interface Props {
  event: CameraEvent;
  cameraName?: string;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

/** Строка события: время, состояние движения, камера. Без архива — MVP. */
export function EventRow({ event, cameraName }: Props) {
  const active = event.state === 'active';
  return (
    <div className={styles.row}>
      <div className={styles.time}>
        <span className={styles.clock}>{formatTime(event.occurred_at)}</span>
        <span className={styles.date}>{formatDate(event.occurred_at)}</span>
      </div>
      <div className={styles.info}>
        <span className={styles.title}>
          {active ? 'Движение началось' : 'Движение закончилось'}
        </span>
        <Link className={styles.camera} to={`/cameras/${event.camera_id}`}>
          {cameraName ?? 'Камера'}
        </Link>
      </div>
      <span className={`${styles.state} ${active ? styles.active : ''}`}>
        {active ? 'АКТИВНО' : 'ЗАВЕРШЕНО'}
      </span>
    </div>
  );
}