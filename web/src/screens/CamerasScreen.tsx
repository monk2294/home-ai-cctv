import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiRequestError } from '../api/client';
import type { Camera } from '../api/client';
import { AddCameraTile, CameraTile } from '../components/CameraTile';
import { DeleteDialog } from '../components/DeleteDialog';
import { Layout } from '../components/Layout';
import { HeaderClock, PageHeader } from '../components/PageHeader';
import { useCameras } from '../hooks/useCameras';
import styles from './CamerasScreen.module.css';

/** Обзор камер: сетка карточек и плитка добавления. */
export function CamerasScreen() {
  const { cameras, error, refresh } = useCameras();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState<Camera | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const onlineCount = cameras?.filter((c) => c.state === 'online').length ?? 0;

  const confirmDelete = async () => {
    if (!deleting || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await api.deleteCamera(deleting.id);
      setDeleting(null);
      refresh();
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setDeleteError(`${err.code}: ${err.message} (${err.requestId})`);
      } else {
        setDeleteError('Нет связи с сервером');
      }
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <Layout
      header={
        <PageHeader
          title="Камеры"
          right={
            <>
              {cameras && (
                <span className={styles.status}>
                  <span
                    className={`${styles.statusDot} ${onlineCount < cameras.length ? styles.statusDotWarn : ''}`}
                    aria-hidden="true"
                  />
                  {onlineCount} из {cameras.length} в сети
                </span>
              )}
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
      {!cameras && !error && <p className={styles.loading}>Загрузка…</p>}
      {cameras && (
        <div className={styles.grid}>
          {cameras.map((camera, index) => (
            <CameraTile
              key={camera.id}
              camera={camera}
              index={index}
              onEdit={(c) => navigate(`/cameras/${c.id}/settings`)}
              onDelete={(c) => {
                setDeleteError(null);
                setDeleting(c);
              }}
            />
          ))}
          {cameras.length < 4 && <AddCameraTile />}
        </div>
      )}
      {deleting && (
        <DeleteDialog
          cameraName={deleting.name}
          busy={deleteBusy}
          error={deleteError}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </Layout>
  );
}