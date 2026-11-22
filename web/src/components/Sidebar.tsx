import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { Icon } from './Icon';
import styles from './Sidebar.module.css';

/** Сайдбар из дизайна: бренд, навигация, выход. Блок «Хранилище» скрыт — архив не входит в MVP. */
export function Sidebar() {
  const { logout } = useAuth();
  return (
    <aside className={styles.sidebar}>
      <div className={styles.top}>
        <div className={styles.brand}>
          <div className={styles.brandRow}>
            <span className={styles.seal} aria-hidden="true" />
            <span className={styles.brandName}>Око дома</span>
          </div>
        </div>
        <nav className={styles.nav}>
          <NavLink
            to="/cameras"
            className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}
          >
            <Icon name="nav-cameras" size={15} />
            <span>Камеры</span>
          </NavLink>
          <NavLink
            to="/events"
            className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}
          >
            <Icon name="nav-events" size={15} />
            <span>События</span>
          </NavLink>
        </nav>
      </div>
      <button type="button" className={styles.logout} onClick={() => void logout()}>
        Выйти
      </button>
    </aside>
  );
}
