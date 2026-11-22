import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiRequestError } from '../api/client';
import type { CameraEvent } from '../api/client';
import { useAuth } from '../auth/AuthContext';

export type SseStatus = 'idle' | 'connecting' | 'open' | 'reconnecting';

interface EventsContextValue {
  status: SseStatus;
  /** Буфер новых событий из SSE (новые сверху). */
  buffer: CameraEvent[];
  /** Растёт после каждого reconnect — экраны перезагружают REST-списки. */
  revision: number;
}

const EventsContext = createContext<EventsContextValue | null>(null);

const BUFFER_LIMIT = 200;

/** Один EventSource на авторизованное приложение (спецификация 20 §9). */
export function EventsProvider({ children }: { children: ReactNode }) {
  const { state, markAnonymous } = useAuth();
  const authenticated = state.status === 'authenticated';
  const [status, setStatus] = useState<SseStatus>('idle');
  const [buffer, setBuffer] = useState<CameraEvent[]>([]);
  const [revision, setRevision] = useState(0);
  const hadErrorRef = useRef(false);

  useEffect(() => {
    if (!authenticated) {
      setStatus('idle');
      setBuffer([]);
      return;
    }
    setStatus('connecting');
    const source = new EventSource('/api/v1/events');

    source.addEventListener('open', () => {
      setStatus('open');
      if (hadErrorRef.current) {
        hadErrorRef.current = false;
        setRevision((r) => r + 1);
      }
    });

    source.addEventListener('camera-event', (message) => {
      try {
        const event = JSON.parse((message as MessageEvent<string>).data) as CameraEvent;
        setBuffer((prev) => [event, ...prev.filter((e) => e.id !== event.id)].slice(0, BUFFER_LIMIT));
      } catch {
        // повреждённое сообщение пропускаем
      }
    });

    source.addEventListener('error', () => {
      if (source.readyState === EventSource.CLOSED) {
        // Сервер закрыл поток. Проверяем сессию: 401 означает выход.
        hadErrorRef.current = true;
        setStatus('reconnecting');
        api.listCameras().catch((error: unknown) => {
          if (error instanceof ApiRequestError && error.status === 401) {
            markAnonymous();
          }
        });
        source.close();
      } else {
        hadErrorRef.current = true;
        setStatus('reconnecting');
      }
    });

    return () => {
      source.close();
    };
  }, [authenticated, markAnonymous]);

  const value = useMemo(() => ({ status, buffer, revision }), [status, buffer, revision]);
  return <EventsContext.Provider value={value}>{children}</EventsContext.Provider>;
}

export function useEvents(): EventsContextValue {
  const ctx = useContext(EventsContext);
  if (!ctx) {
    throw new Error('useEvents вне EventsProvider');
  }
  return ctx;
}