import type { RawCameraEvent } from '../cameras/adapter.js';

/** Топики стандартного движения ONVIF. Неизвестный топик движением не считается. */
const MOTION_TOPICS = [
  'tns1:RuleEngine/CellMotionDetector/Motion',
  'tns1:RuleEngine/MotionRegionDetector/Motion',
];

export function isMotionTopic(topic: string): boolean {
  return MOTION_TOPICS.includes(topic);
}

/** Приводит нормализованное событие адаптера к состоянию движения или null. */
export function normalizeMotion(event: RawCameraEvent): { state: 'active' | 'inactive' } | null {
  if (!isMotionTopic(event.topic)) {
    return null;
  }
  const value = (event.stateValue ?? '').toLowerCase();
  if (value === 'true' || value === '1') {
    return { state: 'active' };
  }
  if (value === 'false' || value === '0') {
    return { state: 'inactive' };
  }
  return null;
}
