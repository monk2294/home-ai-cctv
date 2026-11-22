import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import styles from './PageHeader.module.css';

/** Шапка экрана: заголовок 36px и правый блок. */
export function PageHeader({ title, right }: { title: ReactNode; right?: ReactNode }) {
  return (
    <header className={styles.header}>
      <h1 className={styles.title}>{title}</h1>
      {right && <div className={styles.right}>{right}</div>}
    </header>
  );
}

/** Часы из дизайна: время 22px и дата 13px. */
export function HeaderClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className={styles.clock}>
      <span className={styles.clockTime}>
        {now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
      </span>
      <span className={styles.clockDate}>
        {now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'long' })}
      </span>
    </div>
  );
}