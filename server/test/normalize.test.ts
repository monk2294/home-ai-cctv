import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { eventTypeForTopic, normalizeEvent } from '../src/events/normalize.js';
import { extractRawEvent } from '../src/onvif/adapter.js';
import { dedupHash } from '../src/events/service.js';

describe('topic → тип события', () => {
  test('подтверждённые топики распознаются', () => {
    assert.equal(eventTypeForTopic('tns1:RuleEngine/CellMotionDetector/Motion'), 'motion');
    assert.equal(eventTypeForTopic('tns1:RuleEngine/MotionRegionDetector/Motion'), 'motion');
    assert.equal(eventTypeForTopic('tns1:RuleEngine/PeopleDetector/People'), 'people');
    assert.equal(eventTypeForTopic('tns1:RuleEngine/TamperDetector/Tamper'), 'tamper');
    assert.equal(eventTypeForTopic('tns1:RuleEngine/IntrusionDetector/Intrusion'), 'intrusion');
    assert.equal(eventTypeForTopic('tns1:RuleEngine/LineCrossDetector/LineCross'), 'line_cross');
    assert.equal(eventTypeForTopic('tns1:RuleEngine/TPSmartEventDetector/TPSmartEvent'), 'smart_event');
  });

  test('похожий топик без явного правила событием не считается', () => {
    assert.equal(eventTypeForTopic('tns1:RuleEngine/MyCustomMotionThing'), null);
    assert.equal(eventTypeForTopic('tns1:VideoSource/MotionAlarm'), null);
    assert.equal(eventTypeForTopic('tns1:RuleEngine/LineDetector/Crossed'), null);
  });

  test('normalizeEvent возвращает тип и состояние', () => {
    const people = { topic: 'tns1:RuleEngine/PeopleDetector/People', utcTime: null, messageId: null, stateName: 'IsPeople', stateValue: 'true' };
    assert.deepEqual(normalizeEvent(people), { type: 'people', state: 'active' });
    const motion = { topic: 'tns1:RuleEngine/CellMotionDetector/Motion', utcTime: null, messageId: null, stateName: 'IsMotion', stateValue: 'false' };
    assert.deepEqual(normalizeEvent(motion), { type: 'motion', state: 'inactive' });
    assert.equal(normalizeEvent({ ...motion, stateValue: 'unknown' }), null);
    assert.equal(normalizeEvent({ topic: 'tns1:RuleEngine/LineDetector/Crossed', utcTime: null, messageId: null, stateName: null, stateValue: 'true' }), null);
  });
});

describe('extractRawEvent', () => {
  test('извлекает topic, UtcTime и IsMotion из NotificationMessage', () => {
    const raw = extractRawEvent({
      topic: { _: 'tns1:RuleEngine/CellMotionDetector/Motion' },
      message: {
        message: {
          $: { UtcTime: '2026-11-21T12:00:00Z' },
          data: { simpleItem: [{ name: 'IsMotion', value: 'true' }] },
        },
      },
    });
    assert.equal(raw.topic, 'tns1:RuleEngine/CellMotionDetector/Motion');
    assert.equal(raw.utcTime, '2026-11-21T12:00:00Z');
    assert.equal(raw.stateValue, 'true');
  });

  test('Tapo: simpleItem одиночный объект, значение boolean', () => {
    const raw = extractRawEvent({
      topic: { _: 'tns1:RuleEngine/CellMotionDetector/Motion' },
      message: {
        message: {
          $: { UtcTime: '2026-11-21T12:05:00Z' },
          data: { simpleItem: { value: true, name: 'IsMotion' } },
        },
      },
    });
    assert.equal(raw.topic, 'tns1:RuleEngine/CellMotionDetector/Motion');
    assert.equal(raw.stateName, 'IsMotion');
    assert.equal(raw.stateValue, 'true');
    assert.deepEqual(normalizeEvent(raw), { type: 'motion', state: 'active' });

    const inactive = extractRawEvent({
      topic: { _: 'tns1:RuleEngine/CellMotionDetector/Motion' },
      message: { message: { data: { simpleItem: { value: false, name: 'IsMotion' } } } },
    });
    assert.deepEqual(normalizeEvent(inactive), { type: 'motion', state: 'inactive' });
  });

  test('Tapo People: одиночный simpleItem IsPeople', () => {
    const raw = extractRawEvent({
      topic: { _: 'tns1:RuleEngine/PeopleDetector/People' },
      message: {
        message: {
          $: { UtcTime: '2026-11-24T12:00:00Z' },
          data: { simpleItem: { value: true, name: 'IsPeople' } },
        },
      },
    });
    assert.equal(raw.stateName, 'IsPeople');
    assert.deepEqual(normalizeEvent(raw), { type: 'people', state: 'active' });
  });

  test('несколько simpleItem: берётся первое boolean-like значение', () => {
    const raw = extractRawEvent({
      topic: { _: 'tns1:RuleEngine/IntrusionDetector/Intrusion' },
      message: {
        message: {
          data: {
            simpleItem: [
              { name: 'State', value: 'Active' },
              { name: 'IsIntrusion', value: 'true' },
              { name: 'IsTamper', value: 'false' },
            ],
          },
        },
      },
    });
    assert.equal(raw.stateName, 'IsIntrusion');
    assert.deepEqual(normalizeEvent(raw), { type: 'intrusion', state: 'active' });
  });

  test('небулевы значения simpleItem пропускаются', () => {
    const raw = extractRawEvent({
      topic: { _: 'tns1:RuleEngine/TPSmartEventDetector/TPSmartEvent' },
      message: { message: { data: { simpleItem: [{ name: 'State', value: 'BabyCry' }] } } },
    });
    assert.equal(raw.stateValue, null);
    assert.equal(normalizeEvent(raw), null);
  });
});

describe('dedupHash', () => {
  test('одинаковые входы дают один hash, разные — разные', () => {
    const a = dedupHash('cam1', 'topic', 'active', '2026-11-21T12:00:00Z', null);
    const b = dedupHash('cam1', 'topic', 'active', '2026-11-21T12:00:00Z', null);
    const c = dedupHash('cam1', 'topic', 'inactive', '2026-11-21T12:00:00Z', null);
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});
