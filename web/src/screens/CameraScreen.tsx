import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiRequestError } from '../api/client';
import type { Camera } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Button } from '../components/Button';
import { DeleteDialog } from '../components/DeleteDialog';
import { EventRow } from '../components/EventRow';
import { Icon } from '../components/Icon';
import { Layout } from '../components/Layout';
import { PageHeader } from '../components/PageHeader';
import { StatusPill } from '../components/StatusPill';
import { useEvents } from '../events/EventsContext';
import { useCameraEvents } from '../hooks/useCameraEvents';
import { VideoPlayer } from '../player/VideoPlayer';
import { PtzPanel } from '../ptz/PtzPanel';
import { AudioPanel } from '../audio/AudioPanel';
import styles from './CameraScreen.module.css';

const SSE_LABELS = {
  idle: 'не подключено',
  connecting: 'подключение…',
  open: 'подключено',
  reconnecting: 'переподключение…',
} as const;

/** Детальный экран камеры: плеер, PTZ, события. */
export function CameraScreen() {
  const { cameraId } = useParams<{ cameraId: string }>();
  const navigate = useNavigate();
  const { markAnonymous } = useAuth();
  const { status: sseStatus } = useEvents();
  const [camera, setCamera] = useState<Camera | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const { events, lastMotion } = useCameraEvents(cameraId);

  const load = useCallback(async () => {
    if (!cameraId) return;
    try {
      const next = await api.getCamera(cameraId);
      setCamera(next);
      setLoadError(null);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) {
        markAnonymous();
        return;
      }
      if (err instanceof ApiRequestError && err.status === 404) {
        setLoadError('Камера удалена или не существует.');
        return;
      }
      if (err instanceof ApiRequestError && err.status === 403) {
        setLoadError('Нет прав доступа к этой камере.');
        return;
      }
      setLoadError('Нет связи с сервером');
    }
  }, [cameraId, markAnonymous]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const confirmDelete = async () => {
    if (!cameraId || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await api.deleteCamera(cameraId);
      navigate('/cameras', { replace: true });
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setDeleteError(`${err.code}: ${err.message} (${err.requestId})`);
      } else {
        setDeleteError('Нет связи с сервером');
      }
      setDeleteBusy(false);
    }
  };

  if (loadError) {
    return (
      <Layout header={<PageHeader title="Камера" />}>
        <p className={styles.error} role="alert">
          {loadError} <Link to="/cameras">К списку камер</Link>
        </p>
      </Layout>
    );
  }

  if (!camera) {
    return (
      <Layout header={<PageHeader title="Камера" />}>
        <p className={styles.loading}>Загрузка…</p>
      </Layout>
    );
  }

  const playerEnabled = camera.enabled && camera.state !== 'disabled';

  return (
    <Layout
      header={
        <PageHeader
          title={
            <>
              <Link to="/cameras" className={styles.back} aria-label="Все камеры">
                <Icon name="back" size={14} />
                Все камеры
              </Link>
              {camera.name}
            </>
          }
          right={
            <>
              <StatusPill state={camera.state} />
              <Button icon={<Icon name="edit" size={13} />} onClick={() => navigate(`/cameras/${camera.id}/settings`)}>
                Изменить
              </Button>
              <Button variant="danger" icon={<Icon name="delete" size={13} />} onClick={() => setDeleting(true)}>
                Удалить
              </Button>
            </>
          }
        />
      }
    >
      <div className={styles.columns}>
        <div className={styles.playerCol}>
          <VideoPlayer cameraId={camera.id} enabled={playerEnabled} />
          {camera.state === 'disabled' && (
            <p className={styles.disabledBanner}>
              Камера отключена. <Link to={`/cameras/${camera.id}/settings`}>Включить в настройках</Link>
            </p>
          )}
          {camera.last_error && (
            <p className={styles.lastError}>
              Диагностика: {camera.last_error.code} — {camera.last_error.message}
            </p>
          )}
          <section className={styles.events} aria-label="События камеры">
            <div className={styles.eventsHeader}>
              <h3 className={styles.sectionTitle}>События</h3>
              <span className={styles.sse}>SSE: {SSE_LABELS[sseStatus]}</span>
            </div>
            {lastMotion ? (
              <p className={styles.lastMotion}>
                Последнее движение: {new Date(lastMotion.occurred_at).toLocaleString('ru-RU')} (
                {lastMotion.state === 'active' ? 'активно' : 'завершено'}). Состояние может быть устаревшим.
              </p>
            ) : (
              <p className={styles.lastMotion}>Событий движения пока нет</p>
            )}
            <div className={styles.eventList}>
              {events.slice(0, 20).map((event) => (
                <EventRow key={event.id} event={event} cameraName={camera.name} />
              ))}
            </div>
          </section>
        </div>
        <div className={styles.side}>
          <PtzPanel camera={camera} />
          <AudioPanel camera={camera} />
          <section className={styles.facts} aria-label="Сведения о камере">
            <h3 className={styles.sectionTitle}>Сведения</h3>
            <dl className={styles.factList}>
              <div className={styles.fact}>
                <dt>Адрес</dt>
                <dd>
                  {camera.host}:{camera.onvif_port}
                </dd>
              </div>
              <div className={styles.fact}>
                <dt>Профиль</dt>
                <dd>{camera.profile_token}</dd>
              </div>
              <div className={styles.fact}>
                <dt>Звук</dt>
                <dd>{capabilityLabel(camera.capabilities.audio)}</dd>
              </div>
              <div className={styles.fact}>
                <dt>Динамик</dt>
                <dd>{capabilityLabel(camera.capabilities.audio_output)}</dd>
              </div>
              <div className={styles.fact}>
                <dt>Движение</dt>
                <dd>{capabilityLabel(camera.capabilities.motion_events)}</dd>
              </div>
              <div className={styles.fact}>
                <dt>PTZ</dt>
                <dd>{capabilityLabel(camera.capabilities.ptz_continuous)}</dd>
              </div>
            </dl>
          </section>
        </div>
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

function capabilityLabel(state: string): string {
  if (state === 'supported') return 'поддерживается';
  if (state === 'unsupported') return 'не поддерживается';
  return 'не подтверждено';
}