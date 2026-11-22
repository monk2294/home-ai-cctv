import type { Camera } from '../api/client';
import styles from './StatusPill.module.css';

const LABELS: Record<Camera['state'], string> = {
  online: 'В СЕТИ',
  connecting: 'ПОДКЛЮЧЕНИЕ',
  degraded: 'ОГРАНИЧЕННО',
  offline: 'НЕ В СЕТИ',
  disabled: 'ОТКЛЮЧЕНА',
};

/** Состояние камеры: цвет + текстовая метка (не только цвет, спецификация 20 §12). */
export function StatusPill({ state }: { state: Camera['state'] }) {
  return (
    <span className={`${styles.pill} ${styles[state]}`}>
      <span className={styles.dot} aria-hidden="true" />
      {LABELS[state]}
    </span>
  );
}
