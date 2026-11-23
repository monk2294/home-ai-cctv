import { useEffect, useRef, useState } from 'react';
import { ApiRequestError, snapshotBlob } from '../api/client';

/**
 * Опрос снимка камеры раз в секунду (спецификация 50, T-19):
 * пауза на скрытой вкладке и за пределами вьюпорта, backoff 5 с на ошибке,
 * остановка при 401 (logout) и 409 (CAMERA_DISABLED).
 */

const POLL_MS = 1_000;
const ERROR_BACKOFF_MS = 5_000;

export interface SnapshotPollingOptions {
  cameraId: string;
  width?: number;
  /** polling активен: камера включена и online. */
  active: boolean;
  onUnauthorized: () => void;
}

export function useSnapshotPolling({ cameraId, width, active, onUnauthorized }: SnapshotPollingOptions) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(true);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      setInView(entries[0]?.isIntersecting ?? true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!active || !inView) {
      return;
    }
    let cancelled = false;
    let stopped = false;
    let currentUrl: string | null = null;
    let timer: number;

    const schedule = (delayMs: number): void => {
      timer = window.setTimeout(() => void tick(), delayMs);
    };

    const adoptBlob = (blob: Blob): void => {
      const next = URL.createObjectURL(blob);
      if (currentUrl) {
        URL.revokeObjectURL(currentUrl);
      }
      currentUrl = next;
      setBlobUrl(next);
    };

    const tick = async (): Promise<void> => {
      if (cancelled || stopped) {
        return;
      }
      if (document.visibilityState !== 'visible') {
        schedule(POLL_MS);
        return;
      }
      try {
        adoptBlob(await snapshotBlob(cameraId, width));
        schedule(POLL_MS);
      } catch (error) {
        if (error instanceof ApiRequestError) {
          if (error.status === 401) {
            stopped = true;
            unauthorizedRef.current();
            return;
          }
          if (error.status === 409) {
            stopped = true;
            return;
          }
        }
        schedule(ERROR_BACKOFF_MS);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (currentUrl) {
        URL.revokeObjectURL(currentUrl);
        currentUrl = null;
      }
      setBlobUrl(null);
    };
  }, [cameraId, width, active, inView]);

  return { containerRef, blobUrl };
}
