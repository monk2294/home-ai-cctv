import { ApiError } from './errors.js';

/** Парсит целый width из query с диапазоном (спецификация 9.1). */
export function parseWidth(raw: string, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ApiError(400, 'VALIDATION_ERROR', `width должен быть целым от ${min} до ${max}`);
  }
  return value;
}
