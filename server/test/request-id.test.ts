import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { TestContext } from './helpers.js';
import { buildTestApp } from './helpers.js';

describe('X-Request-ID', () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await buildTestApp();
  });
  after(async () => {
    await ctx.close();
  });

  test('принимает валидный заголовок 1–128 символов и возвращает его', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/health/live',
      headers: { 'x-request-id': 'abc.DEF_123-xyz' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-request-id'], 'abc.DEF_123-xyz');
  });

  test('заменяет невалидный заголовок новым ID', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/health/live',
      headers: { 'x-request-id': 'плохой id!' },
    });
    assert.equal(response.statusCode, 200);
    const id = response.headers['x-request-id'];
    assert.match(String(id), /^req_[A-Za-z0-9._-]{1,128}$/);
    assert.notEqual(id, 'плохой id!');
  });

  test('отклоняет ID длиннее 128 символов', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/health/live',
      headers: { 'x-request-id': 'a'.repeat(129) },
    });
    const id = String(response.headers['x-request-id']);
    assert.notEqual(id, 'a'.repeat(129));
    assert.match(id, /^req_/);
  });

  test('request_id в теле ошибки совпадает с заголовком ответа', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/unknown',
      headers: { 'x-request-id': 'err_abc-123' },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers['x-request-id'], 'err_abc-123');
    const body = response.json() as { code: string; request_id: string };
    assert.equal(body.code, 'NOT_FOUND');
    assert.equal(body.request_id, 'err_abc-123');
  });
});
