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

/** Строки заголовков по типу события: [active, inactive]. */
const EVENT_TITLES: Record<string, [string, string]> = {
  motion: ['Движение началось', 'Движение закончилось'],
  people: ['Человек в кадре', 'Человека в кадре нет'],
  tamper: ['Камеру сдвинули или закрыли', 'Камера вернулась в покой'],
  intrusion: ['Вторжение в зону', 'В зоне пусто'],
  line_cross: ['Линия пересечена', 'Линия свободна'],
  smart_event: ['Смарт-событие', 'Смарт-событие завершено'],
};

/** Строка события: время, тип и состояние события, камера. Без архива — MVP. */
export function EventRow({ event, cameraName }: Props) {
  const active = event.state === 'active';
  const [activeTitle, inactiveTitle] = EVENT_TITLES[event.type] ?? EVENT_TITLES.motion!;
  return (
    <div className={styles.row}>
      <div className={styles.time}>
        <span className={styles.clock}>{formatTime(event.occurred_at)}</span>
        <span className={styles.date}>{formatDate(event.occurred_at)}</span>
      </div>
      <div className={styles.info}>
        <span className={styles.title}>
          {active ? activeTitle : inactiveTitle}
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