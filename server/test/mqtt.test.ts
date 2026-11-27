import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { MqttClient } from 'mqtt';
import { CAMERA_EVENT_TOPIC, MqttCameraEventPublisher } from '../src/events/mqtt.js';
import type { CameraEvent } from '../src/events/service.js';

const EVENT: CameraEvent = {
  id: '43',
  camera_id: 'camera-1',
  type: 'motion',
  state: 'active',
  occurred_at: '2026-11-23T20:00:00.000Z',
  received_at: '2026-11-23T20:00:00.100Z',
  source: 'onvif',
  topic: 'tns1:RuleEngine/CellMotionDetector/Motion',
};

describe('MqttCameraEventPublisher', () => {
  test('публикует CameraEvent в фиксированный топик QoS 1 без retain', () => {
    let published: { topic: string; payload: string; qos: number; retain: boolean } | null = null;
    const client = {
      publish(topic: string, payload: string, options: { qos: number; retain: boolean }, callback: (error?: Error) => void) {
        published = { topic, payload, qos: options.qos, retain: options.retain };
        callback(new Error('broker offline'));
      },
      on() {},
      end() {},
    } as unknown as MqttClient;
    const warnings: string[] = [];
    const publisher = new MqttCameraEventPublisher(client, {
      warn: (message: string) => warnings.push(message),
    });

    publisher.publish(EVENT);

    assert.deepEqual(published, {
      topic: CAMERA_EVENT_TOPIC,
      payload: JSON.stringify(EVENT),
      qos: 1,
      retain: false,
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /43/);
  });
});
