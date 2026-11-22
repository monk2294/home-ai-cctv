import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiRequestError } from '../api/client';
import type { ProbeResponse } from '../api/client';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { Layout } from '../components/Layout';
import { PageHeader } from '../components/PageHeader';
import { TextField } from '../components/TextField';
import styles from './CameraForm.module.css';

interface ConnectionFields {
  name: string;
  host: string;
  onvif_port: string;
  username: string;
  password: string;
  rtsp_url_override: string;
}

const EMPTY: ConnectionFields = {
  name: '',
  host: '',
  onvif_port: '80',
  username: '',
  password: '',
  rtsp_url_override: '',
};

type Step = 'connect' | 'probe' | 'snapshot';

function errorText(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.code === 'CAMERA_LIMIT_REACHED') {
      return 'Достигнут лимит: платформа поддерживает не более 4 камер. Удалите одну из существующих.';
    }
    return `${err.code}: ${err.message} (${err.requestId})`;
  }
  return 'Нет связи с сервером';
}

/** Мастер добавления: подключение → probe → профиль и снимок → сохранение. */
export function CameraNewScreen() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('connect');
  const [fields, setFields] = useState<ConnectionFields>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeResponse | null>(null);
  const [profileToken, setProfileToken] = useState<string>('');
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const snapshotRef = useRef<string | null>(null);

  const set = (key: keyof ConnectionFields) => (value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  };

  const probeBody = () => ({
    host: fields.host.trim(),
    onvif_port: Number(fields.onvif_port) || 80,
    username: fields.username,
    password: fields.password,
    ...(fields.rtsp_url_override.trim() ? { rtsp_url_override: fields.rtsp_url_override.trim() } : {}),
  });

  // Снимок очищается при закрытии мастера; пароль живёт только в состоянии компонента.
  useEffect(() => {
    return () => {
      if (snapshotRef.current) URL.revokeObjectURL(snapshotRef.current);
    };
  }, []);

  const replaceSnapshot = (url: string | null) => {
    if (snapshotRef.current) URL.revokeObjectURL(snapshotRef.current);
    snapshotRef.current = url;
    setSnapshot(url);
  };

  const runProbe = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.probe(probeBody());
      setProbe(result);
      setProfileToken(result.profiles[0]?.token ?? '');
      replaceSnapshot(null);
      setStep('probe');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const takeSnapshot = async () => {
    if (snapshotBusy || !profileToken) return;
    setSnapshotBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/v1/cameras/probe/snapshot.jpg?width=640', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...probeBody(), profile_token: profileToken }),
      });
      if (!response.ok) {
        let message = `Ошибка ${response.status}`;
        try {
          const body = (await response.json()) as { code?: string; message?: string };
          message = `${body.code ?? 'ERROR'}: ${body.message ?? message}`;
        } catch {
          // не JSON
        }
        throw new Error(message);
      }
      const blob = await response.blob();
      replaceSnapshot(URL.createObjectURL(blob));
    } catch (err) {
      replaceSnapshot(null);
      setError(err instanceof Error ? err.message : 'Не удалось получить снимок');
    } finally {
      setSnapshotBusy(false);
    }
  };

  const selectProfile = (token: string) => {
    setProfileToken(token);
    // После смены профиля прежний снимок считается устаревшим.
    replaceSnapshot(null);
  };

  const save = async () => {
    if (busy || !probe || !profileToken) return;
    setBusy(true);
    setError(null);
    try {
      const camera = await api.createCamera({
        ...probeBody(),
        name: fields.name.trim(),
        profile_token: profileToken,
        enabled: true,
      });
      navigate(`/cameras/${camera.id}`, { replace: true });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const connectValid =
    fields.name.trim() !== '' && fields.host.trim() !== '' && fields.username !== '' && fields.password !== '';

  return (
    <Layout
      header={
        <PageHeader
          title={
            <>
              <Link to="/cameras" className={styles.back}>
                <Icon name="back" size={14} />
                Камеры
              </Link>
              Новая камера
            </>
          }
        />
      }
    >
      <div className={styles.formWrap}>
        <ol className={styles.steps}>
          <li className={step === 'connect' ? styles.stepActive : styles.stepDone}>Подключение</li>
          <li className={step === 'probe' ? styles.stepActive : step === 'snapshot' ? styles.stepDone : ''}>
            Проверка
          </li>
          <li className={step === 'snapshot' ? styles.stepActive : ''}>Профиль и снимок</li>
        </ol>

        {step === 'connect' && (
          <form
            className={styles.form}
            onSubmit={(e) => {
              e.preventDefault();
              void runProbe();
            }}
          >
            <TextField label="Имя камеры" value={fields.name} onChange={set('name')} placeholder="Двор" />
            <div className={styles.row}>
              <TextField label="Host или IP" value={fields.host} onChange={set('host')} placeholder="192.168.1.10" />
              <TextField
                label="ONVIF port"
                value={fields.onvif_port}
                onChange={set('onvif_port')}
                inputMode="numeric"
                hint="По умолчанию 80"
              />
            </div>
            <div className={styles.row}>
              <TextField label="Логин камеры" value={fields.username} onChange={set('username')} autoComplete="off" />
              <TextField
                label="Пароль камеры"
                type="password"
                value={fields.password}
                onChange={set('password')}
                autoComplete="new-password"
              />
            </div>
            <TextField
              label="RTSP override (необязательно)"
              value={fields.rtsp_url_override}
              onChange={set('rtsp_url_override')}
              placeholder="rtsp://192.168.1.10:554/stream1"
              hint="Нужен только при несовместимости ONVIF GetStreamUri. Без логина и пароля в URL."
            />
            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
            <div className={styles.actions}>
              <Button variant="primary" type="submit" disabled={busy || !connectValid}>
                {busy ? 'Проверка…' : 'Проверить подключение'}
              </Button>
              <Button onClick={() => navigate('/cameras')}>Отмена</Button>
            </div>
          </form>
        )}

        {step === 'probe' && probe && (
          <div className={styles.form}>
            <section className={styles.probeBlock}>
              <h3 className={styles.blockTitle}>Камера</h3>
              <p className={styles.probeText}>
                {[probe.device.manufacturer, probe.device.model, probe.device.firmware]
                  .filter(Boolean)
                  .join(' · ') || 'Производитель и модель не сообщены'}
              </p>
            </section>
            <section className={styles.probeBlock}>
              <h3 className={styles.blockTitle}>Возможности</h3>
              <ul className={styles.capList}>
                <li>Звук: {capabilityLabel(probe.capabilities.audio)}</li>
                <li>События движения: {capabilityLabel(probe.capabilities.motion_events)}</li>
                <li>PTZ: {capabilityLabel(probe.capabilities.ptz_continuous)}</li>
                <li>Пресеты PTZ: {capabilityLabel(probe.capabilities.ptz_presets)}</li>
              </ul>
            </section>
            {probe.diagnostics.length > 0 && (
              <section className={styles.probeBlock}>
                <h3 className={styles.blockTitle}>Диагностика проверок</h3>
                <ul className={styles.capList}>
                  {probe.diagnostics.map((d) => (
                    <li key={d.check} className={d.status === 'error' ? styles.diagError : undefined}>
                      {d.check}: {d.message}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {probe.profiles.length === 0 ? (
              <p className={styles.error} role="alert">
                Рабочие профили не найдены. Продолжение невозможно.
              </p>
            ) : (
              <p className={styles.probeText}>
                Найдено профилей: {probe.profiles.length}. Выберите профиль на следующем шаге.
              </p>
            )}
            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
            <div className={styles.actions}>
              <Button variant="primary" disabled={probe.profiles.length === 0} onClick={() => setStep('snapshot')}>
                Далее
              </Button>
              <Button onClick={() => setStep('connect')}>Назад</Button>
            </div>
          </div>
        )}

        {step === 'snapshot' && probe && (
          <div className={styles.form}>
            <section className={styles.probeBlock}>
              <h3 className={styles.blockTitle}>Профиль</h3>
              <div className={styles.profileList} role="radiogroup" aria-label="Профиль камеры">
                {probe.profiles.map((profile) => (
                  <label key={profile.token} className={styles.profileOption}>
                    <input
                      type="radio"
                      name="profile"
                      value={profile.token}
                      checked={profileToken === profile.token}
                      onChange={() => selectProfile(profile.token)}
                    />
                    <span>
                      {profile.name}
                      {profile.width && profile.height ? ` · ${profile.width}×${profile.height}` : ''}
                      {profile.video_codec ? ` · ${profile.video_codec}` : ''}
                    </span>
                  </label>
                ))}
              </div>
            </section>
            <section className={styles.probeBlock}>
              <h3 className={styles.blockTitle}>Снимок</h3>
              <div className={styles.snapshotBox}>
                {snapshot ? (
                  <img className={styles.snapshotImage} src={snapshot} alt="Пробный снимок камеры" />
                ) : (
                  <span className={styles.snapshotPlaceholder}>
                    {snapshotBusy ? 'Получение снимка…' : 'Снимок не получен'}
                  </span>
                )}
              </div>
              <Button onClick={() => void takeSnapshot()} disabled={snapshotBusy || !profileToken}>
                {snapshot ? 'Повторить снимок' : 'Получить снимок'}
              </Button>
            </section>
            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
            <div className={styles.actions}>
              <Button variant="primary" onClick={() => void save()} disabled={busy || !profileToken}>
                {busy ? 'Сохранение…' : 'Сохранить камеру'}
              </Button>
              <Button onClick={() => setStep('probe')} disabled={busy}>
                Назад
              </Button>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}

function capabilityLabel(state: string): string {
  if (state === 'supported') return 'поддерживается';
  if (state === 'unsupported') return 'не поддерживается';
  return 'не подтверждено';
}