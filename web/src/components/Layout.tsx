import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import styles from './Layout.module.css';

/** Каркас защищённых экранов: сайдбар + колонка контента. */
export function Layout({ header, children }: { header?: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <Sidebar />
      <div className={styles.column}>
        {header}
        <main className={styles.main}>{children}</main>
      </div>
    </div>
  );
}