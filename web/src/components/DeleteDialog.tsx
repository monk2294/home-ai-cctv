import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import styles from './DeleteDialog.module.css';

interface Props {
  cameraName: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Диалог удаления из дизайна. Спецификация 20 §10: подтверждение с именем камеры. */
export function DeleteDialog({ cameraName, busy, error, onCancel, onConfirm }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [typedName, setTypedName] = useState('');

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  const confirmed = typedName.trim() === cameraName;

  return (
    <div className={styles.overlay} role="presentation" onClick={() => !busy && onCancel()}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className={styles.title} id="delete-dialog-title">
          Удалить камеру?
        </h2>
        <p className={styles.body}>
          Камера «{cameraName}» будет отключена и удалена вместе с настройками и историей
          событий. Действие нельзя отменить. Введите имя камеры для подтверждения.
        </p>
        <input
          className={styles.input}
          value={typedName}
          onChange={(e) => setTypedName(e.target.value)}
          placeholder={cameraName}
          aria-label="Имя камеры для подтверждения"
          disabled={busy}
        />
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.actions}>
          <Button onClick={onCancel} disabled={busy}>
            Отмена
          </Button>
          <Button ref={confirmRef} variant="clay" onClick={onConfirm} disabled={busy || !confirmed}>
            {busy ? 'Удаление…' : 'Удалить'}
          </Button>
        </div>
      </div>
    </div>
  );
}