import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import styles from './Button.module.css';

type Variant = 'primary' | 'ghost' | 'danger' | 'clay';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  icon?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({ variant = 'ghost', icon, children, className, type = 'button', ref, ...rest }: Props) {
  return (
    <button ref={ref} type={type} className={`${styles.button} ${styles[variant]} ${className ?? ''}`} {...rest}>
      {icon}
      {children}
    </button>
  );
}
