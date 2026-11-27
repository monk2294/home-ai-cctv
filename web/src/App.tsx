import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { EventsProvider } from './events/EventsContext';
import { CameraNewScreen } from './screens/CameraNewScreen';
import { CameraScreen } from './screens/CameraScreen';
import { CameraSettingsScreen } from './screens/CameraSettingsScreen';
import { CamerasScreen } from './screens/CamerasScreen';
import { EventsScreen } from './screens/EventsScreen';
import { LoginScreen } from './screens/LoginScreen';
import { NotFoundScreen } from './screens/NotFoundScreen';

/** Защищённый маршрут: при 401 сохраняет целевой путь и открывает /login. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const location = useLocation();
  if (state.status === 'checking') {
    return null;
  }
  if (state.status === 'anonymous') {
    const target = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(target)}`} replace />;
  }
  return <>{children}</>;
}

export function App() {
  return (
    <BrowserRouter basename="/video">
      <AuthProvider>
        <EventsProvider>
          <Routes>
            <Route path="/login" element={<LoginScreen />} />
            <Route
              path="/cameras"
              element={
                <RequireAuth>
                  <CamerasScreen />
                </RequireAuth>
              }
            />
            <Route
              path="/cameras/new"
              element={
                <RequireAuth>
                  <CameraNewScreen />
                </RequireAuth>
              }
            />
            <Route
              path="/cameras/:cameraId"
              element={
                <RequireAuth>
                  <CameraScreen />
                </RequireAuth>
              }
            />
            <Route
              path="/cameras/:cameraId/settings"
              element={
                <RequireAuth>
                  <CameraSettingsScreen />
                </RequireAuth>
              }
            />
            <Route
              path="/events"
              element={
                <RequireAuth>
                  <EventsScreen />
                </RequireAuth>
              }
            />
            <Route path="/" element={<Navigate to="/cameras" replace />} />
            <Route path="*" element={<NotFoundScreen />} />
          </Routes>
        </EventsProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}