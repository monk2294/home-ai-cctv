import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { adminSessions, adminUsers } from '../src/db/schema.js';
import { hashToken, newSessionToken, tokensEqual } from '../src/auth/tokens.js';
import { AuthService } from '../src/auth/service.js';
import type { TestContext } from './helpers.js';
import { buildTestApp, TEST_ADMIN_PASSWORD } from './helpers.js';

describe('Session lifecycle', () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await buildTestApp();
  });
  after(async () => {
    await ctx.close();
  });

  test('bootstrap создаёт ровно одного администратора один раз', async () => {
    await ctx.auth.bootstrapAdmin();
    await ctx.auth.bootstrapAdmin();
    const rows = ctx.handle.db.select().from(adminUsers).all();
    assert.equal(rows.length, 1);
  });

  test('истёкшая сессия отклоняется и удаляется', async () => {
    const token = newSessionToken();
    const past = new Date(Date.now() - 1000).toISOString();
    ctx.handle.db.insert(adminSessions).values({
      tokenHash: hashToken(token),
      createdAt: past,
      expiresAt: past,
      absoluteExpiresAt: past,
    }).run();

    assert.equal(ctx.auth.verifySession(token), null);
    const rows = ctx.handle.db.select().from(adminSessions).where(eq(adminSessions.tokenHash, hashToken(token))).all();
    assert.equal(rows.length, 0);
  });

  test('активность продлевает сессию в пределах абсолютного потолка 24 часа', async () => {
    const session = await ctx.auth.login('admin', TEST_ADMIN_PASSWORD, '10.0.0.1');
    const nearExpiry = new Date(Date.now() + 60 * 1000).toISOString();
    ctx.handle.db
      .update(adminSessions)
      .set({ expiresAt: nearExpiry })
      .where(eq(adminSessions.tokenHash, hashToken(session.sessionToken)))
      .run();

    const verified = ctx.auth.verifySession(session.sessionToken);
    assert.ok(verified);
    const newExpiry = Date.parse(verified.expiresAt);
    assert.ok(newExpiry > Date.now() + 60 * 1000, 'срок должен быть продлён');
    assert.ok(newExpiry <= Date.now() + 24 * 60 * 60 * 1000 + 1000, 'не выше абсолютного потолка');
  });

  test('purgeExpiredSessions удаляет только истёкшие сессии', async () => {
    const expired = newSessionToken();
    const active = newSessionToken();
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    ctx.handle.db.insert(adminSessions).values([
      { tokenHash: hashToken(expired), createdAt: past, expiresAt: past, absoluteExpiresAt: past },
      { tokenHash: hashToken(active), createdAt: past, expiresAt: future, absoluteExpiresAt: future },
    ]).run();

    ctx.auth.purgeExpiredSessions();

    const rows = ctx.handle.db.select().from(adminSessions).all();
    const hashes = rows.map((row) => row.tokenHash);
    assert.ok(!hashes.includes(hashToken(expired)));
    assert.ok(hashes.includes(hashToken(active)));
  });
});

describe('Токены', () => {
  test('tokensEqual принимает совпадение и отклоняет различие', () => {
    assert.equal(tokensEqual('abc', 'abc'), true);
    assert.equal(tokensEqual('abc', 'abd'), false);
    assert.equal(tokensEqual('', 'abc'), false);
  });
});
