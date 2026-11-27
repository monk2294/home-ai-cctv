import { useEffect, useState } from 'react';
import { api, ApiRequestError } from '../api/client';
import type { CameraEvent } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useEvents } from '../events/EventsContext';

export interface CameraEventsView {
  events: CameraEvent[];
  /**
   * Последнее событие движения: из несжимаемой карты SSE-контекста или из
   * REST-списка — берётся более свежее по ID. Движение не теряется при потоке других типов.
   */
  lastMotion: CameraEvent | undefined;
}

/**
 * События камеры: REST-список при открытии и после reconnect SSE,
 * новые события из SSE, дедупликация по ID (спецификация 20 §9).
 */
export function useCameraEvents(cameraId: string | undefined): CameraEventsView {
  const { markAnonymous } = useAuth();
  const { buffer, lastMotionByCamera, revision } = useEvents();
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

  if (!cameraId) return { events: [], lastMotion: undefined };
  const merged = [...buffer.filter((e) => e.camera_id === cameraId), ...rest];
  const seen = new Set<string>();
  const unique = merged.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
  unique.sort((a, b) => Number(b.id) - Number(a.id));
  const listMotion = unique.find((e) => e.type === 'motion');
  const sseMotion = lastMotionByCamera[cameraId];
  const lastMotion =
    sseMotion && (!listMotion || Number(sseMotion.id) >= Number(listMotion.id)) ? sseMotion : listMotion;
  return { events: unique.slice(0, 100), lastMotion };
}