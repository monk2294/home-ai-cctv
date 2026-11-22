import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isMotionTopic, normalizeMotion, extractRawEvent } from '../src/onvif/adapter.js';
import { dedupHash } from '../src/events/service.js';

describe('ONVIF motion topics', () => {
  test('стандартные топики движения распознаются', () => {
    assert.equal(isMotionTopic('tns1:RuleEngine/CellMotionDetector/Motion'), true);
    assert.equal(isMotionTopic('tns1:RuleEngine/MotionRegionDetector/Motion'), true);
  });

  test('похожий топик без явного правила движением не считается', () => {
    assert.equal(isMotionTopic('tns1:RuleEngine/MyCustomMotionThing'), false);
    assert.equal(isMotionTopic('tns1:VideoSource/MotionAlarm'), false);
    assert.equal(isMotionTopic('tns1:RuleEngine/LineDetector/Crossed'), false);
  });

  test('normalizeMotion по IsMotion', () => {
    const base = { topic: 'tns1:RuleEngine/CellMotionDetector/Motion', utcTime: null, messageId: null };
    assert.deepEqual(normalizeMotion({ ...base, stateName: 'IsMotion', stateValue: 'true' }), { state: 'active' });
    assert.deepEqual(normalizeMotion({ ...base, stateName: 'IsMotion', stateValue: 'false' }), { state: 'inactive' });
    assert.deepEqual(normalizeMotion({ ...base, stateName: 'IsMotion', stateValue: '1' }), { state: 'active' });
    assert.equal(normalizeMotion({ ...base, stateName: 'IsMotion', stateValue: 'unknown' }), null);
    assert.equal(normalizeMotion({ topic: 'tns1:RuleEngine/LineDetector/Crossed', utcTime: null, messageId: null, stateName: null, stateValue: 'true' }), null);
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
    assert.deepEqual(normalizeMotion(raw), { state: 'active' });

    const inactive = extractRawEvent({
      topic: { _: 'tns1:RuleEngine/CellMotionDetector/Motion' },
      message: { message: { data: { simpleItem: { value: false, name: 'IsMotion' } } } },
    });
    assert.deepEqual(normalizeMotion(inactive), { state: 'inactive' });
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
