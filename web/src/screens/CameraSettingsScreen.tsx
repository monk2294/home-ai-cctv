import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiRequestError } from '../api/client';
import type { Camera, MediaProfile } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Button } from '../components/Button';
import { DeleteDialog } from '../components/DeleteDialog';
import { Icon } from '../components/Icon';
import { Layout } from '../components/Layout';
import { PageHeader } from '../components/PageHeader';
import { TextField } from '../components/TextField';
import styles from './CameraForm.module.css';

function errorText(err: unknown): string {
  if (err instanceof ApiRequestError) {
    return `${err.code}: ${err.message} (${err.requestId})`;
  }
  return 'Нет связи с сервером';
}

/** Настройки и диагностика камеры (спецификация 20 §10). */
export function CameraSettingsScreen() {
  const { cameraId } = useParams<{ cameraId: string }>();
  const navigate = useNavigate();
  const { markAnonymous } = useAuth();

  const [camera, setCamera] = useState<Camera | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('80');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rtspOverride, setRtspOverride] = useState('');
  const [clearOverride, setClearOverride] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [profileToken, setProfileToken] = useState('');
  const [profiles, setProfiles] = useState<MediaProfile[] | null>(null);

  const [busy, setBusy] = useState(false);
  const [probeBusy, setProbeBusy] = useState(false);
  const [reconnectBusy, setReconnectBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!cameraId) return;
    try {
      const next = await api.getCamera(cameraId);
      setCamera(next);
      setName(next.name);
      setHost(next.host);
      setPort(String(next.onvif_port));
      setUsername(next.username);
      setEnabled(next.enabled);
      setProfileToken(next.profile_token);
      setLoadError(null);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) {
        markAnonymous();
        return;
      }
      setLoadError(err instanceof ApiRequestError && err.status === 404 ? 'Камера удалена или не существует.' : 'Нет связи с сервером');
    }
  }, [cameraId, markAnonymous]);

  useEffect(() => {
    void load();
  }, [load]);

  const validateOverride = (): string | null => {
    const value = rtspOverride.trim();
    if (!value) return null;
    if (!value.startsWith('rtsp://')) return 'RTSP override должен начинаться с rtsp://';
    if (value.includes('@')) return 'RTSP override не должен содержать логин и пароль. Введите их в отдельных полях.';
    return null;
  };

  const refreshProfiles = async () => {
    if (!cameraId || probeBusy) return;
    if (!password) {
      setError('Введите пароль камеры, чтобы получить список профилей.');
      return;
    }
    setProbeBusy(true);
    setError(null);
    try {
      const result = await api.probe({
        host: host.trim(),
        onvif_port: Number(port) || 80,
        username,
        password,
        ...(rtspOverride.trim() ? { rtsp_url_override: rtspOverride.trim() } : {}),
      });
      setProfiles(result.profiles);
      if (!result.profiles.some((p) => p.token === profileToken)) {
        setProfileToken(result.profiles[0]?.token ?? '');
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setProbeBusy(false);
    }
  };

  const save = async () => {
    if (!cameraId || busy) return;
    const overrideError = validateOverride();
    if (overrideError) {
      setError(overrideError);
      return;
    }
    if (rtspOverride.trim() && clearOverride) {
      setError('Нельзя одновременно задать новый RTSP override и очистить прежний.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        host: host.trim(),
        onvif_port: Number(port) || 80,
        username,
        enabled,
        clear_rtsp_override: clearOverride,
      };
      // Пустой пароль означает «не менять».
      if (password) body.password = password;
      if (rtspOverride.trim()) body.rtsp_url_override = rtspOverride.trim();
      if (profileToken && profileToken !== camera?.profile_token) body.profile_token = profileToken;
      const updated = await api.updateCamera(cameraId, body);
      setCamera(updated);
      setPassword('');
      setRtspOverride('');
      setClearOverride(false);
      setNotice('Настройки сохранены.');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const reconnect = async () => {
    if (!cameraId || reconnectBusy) return;
    setReconnectBusy(true);
    setError(null);
    try {
      const updated = await api.reconnect(cameraId);
      setCamera(updated);
      setNotice('Переподключение запущено.');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setReconnectBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!cameraId || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await api.deleteCamera(cameraId);
      navigate('/cameras', { replace: true });
    } catch (err) {
      setDeleteError(errorText(err));
      setDeleteBusy(false);
    }
  };

  if (loadError) {
    return (
      <Layout header={<PageHeader title="Настройки" />}>
        <p className={styles.error} role="alert">
          {loadError} <Link to="/cameras">К списку камер</Link>
        </p>
      </Layout>
    );
  }

  if (!camera) {
    return (
      <Layout header={<PageHeader title="Настройки" />}>
        <p className={styles.loading}>Загрузка…</p>
      </Layout>
    );
  }

  return (
    <Layout
      header={
        <PageHeader
          title={
            <>
              <Link to={`/cameras/${camera.id}`} className={styles.back}>
                <Icon name="back" size={14} />
                Камера
              </Link>
              {camera.name}
            </>
          }
        />
      }
    >
      <div className={styles.formWrap}>
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <TextField label="Имя камеры" value={name} onChange={setName} />
          <div className={styles.row}>
            <TextField label="Host или IP" value={host} onChange={setHost} />
            <TextField label="ONVIF port" value={port} onChange={setPort} inputMode="numeric" />
          </div>
          <div className={styles.row}>
            <TextField label="Логин камеры" value={username} onChange={setUsername} autoComplete="off" />
            <TextField
              label="Пароль камеры"
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              hint="Пустое поле — пароль не меняется"
            />
          </div>
          <TextField
            label="RTSP override"
            value={rtspOverride}
            onChange={(v) => {
              setRtspOverride(v);
              if (v.trim()) setClearOverride(false);
            }}
            placeholder={camera.has_rtsp_override ? 'Задан; введите новый для замены' : 'rtsp://… (необязательно)'}
            hint="Только при несовместимости ONVIF GetStreamUri. Без логина и пароля в URL."
          />
          {camera.has_rtsp_override && (
            <label className={styles.checkRow}>
              <input
                type="checkbox"
                checked={clearOverride}
                onChange={(e) => {
                  setClearOverride(e.target.checked);
                  if (e.target.checked) setRtspOverride('');
                }}
              />
              Очистить сохранённый RTSP override
            </label>
          )}
          <label className={styles.checkRow}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Камера включена
          </label>

          <section className={styles.probeBlock}>
            <h3 className={styles.blockTitle}>Профиль</h3>
            {profiles ? (
              <div className={styles.profileList} role="radiogroup" aria-label="Профиль камеры">
                {profiles.map((profile) => (
                  <label key={profile.token} className={styles.profileOption}>
                    <input
                      type="radio"
                      name="profile"
                      value={profile.token}
                      checked={profileToken === profile.token}
                      onChange={() => setProfileToken(profile.token)}
                    />
                    <span>
                      {profile.name}
                      {profile.width && profile.height ? ` · ${profile.width}×${profile.height}` : ''}
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <p className={styles.probeText}>Текущий профиль: {camera.profile_token}</p>
            )}
            <Button onClick={() => void refreshProfiles()} disabled={probeBusy}>
              {probeBusy ? 'Проверка…' : 'Обновить список профилей'}
            </Button>
          </section>

          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          {notice && <p className={styles.notice}>{notice}</p>}

          <div className={styles.actions}>
            <Button variant="primary" type="submit" disabled={busy || !name.trim() || !host.trim()}>
              {busy ? 'Сохранение…' : 'Сохранить'}
            </Button>
            <Button onClick={() => navigate(`/cameras/${camera.id}`)}>Отмена</Button>
            <Button onClick={() => void reconnect()} disabled={reconnectBusy || !camera.enabled}>
              {reconnectBusy ? 'Переподключение…' : 'Переподключить'}
            </Button>
          </div>
          {!camera.enabled && (
            <p className={styles.probeText}>Переподключение недоступно: сначала включите камеру и сохраните.</p>
          )}
        </form>

        <section className={styles.danger}>
          <span className={styles.dangerLine} aria-hidden="true" />
          <div className={styles.dangerRow}>
            <p className={styles.dangerText}>Записи камеры будут удалены вместе с ней</p>
            <Button variant="danger" icon={<Icon name="delete" size={13} />} onClick={() => setDeleting(true)}>
              Удалить камеру
            </Button>
          </div>
        </section>
      </div>
      {deleting && (
        <DeleteDialog
          cameraName={camera.name}
          busy={deleteBusy}
          error={deleteError}
          onCancel={() => setDeleting(false)}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </Layout>
  );
}