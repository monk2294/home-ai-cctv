import { useEffect, useState } from 'react';
import { api, ApiRequestError } from '../api/client';
import type { CameraEvent } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useEvents } from '../events/EventsContext';

/**
 * События камеры: REST-список при открытии и после reconnect SSE,
 * новые события из SSE, дедупликация по ID (спецификация 20 §9).
 */
export function useCameraEvents(cameraId: string | undefined): CameraEvent[] {
  const { markAnonymous } = useAuth();
  const { buffer, revision } = useEvents();
  const [rest, setRest] = useState<CameraEvent[]>([]);

  useEffect(() => {
    if (!cameraId) return;
    let cancelled = false;
    api
      .cameraEvents(cameraId, 100)
      .then((list) => {
        if (!cancelled) setRest(list.items);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiRequestError && err.status === 401) markAnonymous();
      });
    return () => {
      cancelled = true;
    };
  }, [cameraId, revision, markAnonymous]);

  if (!cameraId) return [];
  const merged = [...buffer.filter((e) => e.camera_id === cameraId), ...rest];
  const seen = new Set<string>();
  const unique = merged.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
  unique.sort((a, b) => Number(b.id) - Number(a.id));
  return unique.slice(0, 100);
}