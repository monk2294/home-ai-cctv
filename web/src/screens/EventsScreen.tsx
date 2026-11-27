import { useEffect, useState } from 'react';
import { api, ApiRequestError } from '../api/client';
import type { Camera, CameraEvent } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { EventRow } from '../components/EventRow';
import { Layout } from '../components/Layout';
import { HeaderClock, PageHeader } from '../components/PageHeader';
import { useEvents } from '../events/EventsContext';
import { useCameras } from '../hooks/useCameras';
import styles from './EventsScreen.module.css';

const SSE_LABELS = {
  idle: 'не подключено',
  connecting: 'подключение…',
  open: 'подключено',
  reconnecting: 'переподключение…',
} as const;

/** Экран событий из дизайна: лента событий всех камер. Архива записей нет — MVP. */
export function EventsScreen() {
  const { cameras } = useCameras();
  const { buffer, revision, status } = useEvents();
  const { markAnonymous } = useAuth();
  const [rest, setRest] = useState<CameraEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!cameras) return;
    let cancelled = false;
    Promise.all(
      cameras.map((camera) =>
        api.cameraEvents(camera.id, 50).catch((err: unknown) => {
          if (err instanceof ApiRequestError && err.status === 401) markAnonymous();
          return { items: [] as CameraEvent[] };
        }),
      ),
    ).then((lists) => {
      if (!cancelled) {
        setRest(lists.flatMap((list) => list.items));
        setError(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [cameras, revision, markAnonymous]);

  const names = new Map<string, string>((cameras ?? []).map((c: Camera) => [c.id, c.name]));
  const seen = new Set<string>();
  const events = [...buffer, ...rest]
    .filter((e) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    })
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(0, 100);

  return (
    <Layout
      header={
        <PageHeader
          title="События"
          right={
            <>
              <span className={styles.sse}>SSE: {SSE_LABELS[status]}</span>
              <HeaderClock />
            </>
          }
        />
      }
    >
      {error && (
        <p className={styles.banner} role="alert">
          {error}
        </p>
      )}
      {events.length === 0 ? (
        <p className={styles.empty}>Событий пока нет. Камеры сообщают о движении и о людях в кадре.</p>
      ) : (
        <div className={styles.list}>
          {events.map((event) => (
            <EventRow key={event.id} event={event} cameraName={names.get(event.camera_id)} />
          ))}
        </div>
      )}
    </Layout>
  );
}