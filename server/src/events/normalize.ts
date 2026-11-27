import type { RawCameraEvent } from '../cameras/adapter.js';

/** Типы нормализованных событий. Неизвестный топик событием не считается. */
export type CameraEventType = 'motion' | 'people' | 'tamper' | 'intrusion' | 'line_cross' | 'smart_event';

/**
 * Подтверждённые топики. Движение — профиль ONVIF; People/Tamper/Intrusion/LineCross/TPSmartEvent
 * подтверждены на эталонной камере Tapo C520WS (fw 1.3.5) подпиской и живым перехватом.
 */
const TOPIC_TYPES: Record<string, CameraEventType> = {
  'tns1:RuleEngine/CellMotionDetector/Motion': 'motion',
  'tns1:RuleEngine/MotionRegionDetector/Motion': 'motion',
  'tns1:RuleEngine/PeopleDetector/People': 'people',
  'tns1:RuleEngine/TamperDetector/Tamper': 'tamper',
  'tns1:RuleEngine/IntrusionDetector/Intrusion': 'intrusion',
  'tns1:RuleEngine/LineCrossDetector/LineCross': 'line_cross',
  'tns1:RuleEngine/TPSmartEventDetector/TPSmartEvent': 'smart_event',
};

export function eventTypeForTopic(topic: string): CameraEventType | null {
  return TOPIC_TYPES[topic] ?? null;
}

/** Приводит нормализованное событие адаптера к типу и состоянию или null. */
export function normalizeEvent(event: RawCameraEvent): { type: CameraEventType; state: 'active' | 'inactive' } | null {
  const type = eventTypeForTopic(event.topic);
  if (!type) {
    return null;
  }
  const value = (event.stateValue ?? '').toLowerCase();
  if (value === 'true' || value === '1') {
    return { type, state: 'active' };
  }
  if (value === 'false' || value === '0') {
    return { type, state: 'inactive' };
  }
  return null;
}
