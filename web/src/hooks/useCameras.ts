import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiRequestError } from '../api/client';
import type { Camera } from '../api/client';
import { useAuth } from '../auth/AuthContext';

interface CamerasState {
  cameras: Camera[] | null;
  error: string | null;
  refresh: () => void;
}

/** Список камер с polling 15 секунд; на скрытой вкладке polling приостановлен. */
export function useCameras(): CamerasState {
  const { state, markAnonymous } = useAuth();
  const authenticated = state.status === 'authenticated';
  const [cameras, setCameras] = useState<Camera[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const load = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const list = await api.listCameras();
      setCameras(list);
      setError(null);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) {
        markAnonymous();
        return;
      }
      setError(err instanceof Error ? err.message : 'Нет связи с сервером');
    } finally {
      inFlightRef.current = false;
    }
  }, [markAnonymous]);

  useEffect(() => {
    if (!authenticated) return;
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 15_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [authenticated, load]);

  return { cameras, error, refresh: () => void load() };
}