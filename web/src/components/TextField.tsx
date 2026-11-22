import { useId } from 'react';
import styles from './TextField.module.css';

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'password' | 'number';
  hint?: string;
  error?: string;
  placeholder?: string;
  autoComplete?: string;
  disabled?: boolean;
  inputMode?: 'text' | 'numeric';
}

export function TextField({
  label,
  value,
  onChange,
  type = 'text',
  hint,
  error,
  placeholder,
  autoComplete,
  disabled,
  inputMode,
}: Props) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={`${styles.input} ${error ? styles.invalid : ''}`}
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        disabled={disabled}
        inputMode={inputMode}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? errorId : hint ? hintId : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? (
        <p className={styles.error} id={errorId} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className={styles.hint} id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
