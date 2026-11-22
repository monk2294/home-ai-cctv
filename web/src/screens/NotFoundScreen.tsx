import { Link } from 'react-router-dom';
import styles from './NotFoundScreen.module.css';

export function NotFoundScreen() {
  return (
    <main className={styles.screen}>
      <h1 className={styles.title}>Страница не найдена</h1>
      <p className={styles.meta}>
        <Link to="/cameras">Вернуться к списку камер</Link>
      </p>
    </main>
  );
}