import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiRequestError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Button } from '../components/Button';
import { TextField } from '../components/TextField';
import styles from './LoginScreen.module.css';

/** Экран входа из дизайна: бренд, форма, мета-строка. */
export function LoginScreen() {
  const { state, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state.status === 'authenticated') {
    return <Navigate to="/cameras" replace />;
  }

  // Только внутренние пути: внешние URL из query не принимаются.
  const params = new URLSearchParams(location.search);
  const nextParam = params.get('next');
  const target = nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/cameras';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(password);
      navigate(target, { replace: true });
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setError(err.status === 429 ? 'Слишком много попыток. Повторите через несколько минут.' : 'Неверный пароль');
      } else {
        setError('Нет связи с сервером');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className={styles.screen}>
      <div className={styles.col}>
        <div className={styles.brand}>
          <span className={styles.seal} aria-hidden="true" />
          <span className={styles.brandName}>Око дома</span>
        </div>
        <span className={styles.rule} aria-hidden="true" />
        <p className={styles.subtitle}>Локальная платформа видеонаблюдения</p>
        <form className={styles.form} onSubmit={submit}>
          <TextField label="Логин" value="admin" onChange={() => undefined} disabled autoComplete="username" />
          <TextField
            label="Пароль"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
          />
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <Button variant="primary" type="submit" className={styles.submit} disabled={busy || !password}>
            {busy ? 'Вход…' : 'Войти'}
          </Button>
        </form>
        <p className={styles.meta}>Доступ выдаёт администратор, регистрация не предусмотрена</p>
      </div>
    </main>
  );
}