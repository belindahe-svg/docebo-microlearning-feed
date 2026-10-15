import { describe, expect, it } from 'vitest';
import { expectedHash, readIframeParams, sha256Hex, timingSafeEqual, verifyIframeHash } from '../src/auth';

describe('Docebo iframe signature', () => {
  it('hashes "user_id,username,auth_code,salt" with SHA-256', async () => {
    const h = await expectedHash({ userId: '1', username: 'a', authCode: 'c' }, 's');
    expect(h).toBe(await sha256Hex('1,a,c,s'));
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  it('accepts a correct hash, including upper-case hex', async () => {
    const p = { userId: '12345', username: 'test.learner', authCode: 'abc' };
    const hash = await expectedHash(p, 'salt');
    expect(await verifyIframeHash({ ...p, hash }, 'salt')).toBe(true);
    expect(await verifyIframeHash({ ...p, hash: hash.toUpperCase() }, 'salt')).toBe(true);
  });

  it('rejects a wrong salt, a tampered user, or a missing salt', async () => {
    const p = { userId: '12345', username: 'test.learner', authCode: 'abc' };
    const hash = await expectedHash(p, 'salt');
    expect(await verifyIframeHash({ ...p, hash }, 'other')).toBe(false);
    expect(await verifyIframeHash({ ...p, userId: '1', hash }, 'salt')).toBe(false);
    expect(await verifyIframeHash({ ...p, hash }, '')).toBe(false);
  });

  it('reads common parameter spellings', () => {
    expect(readIframeParams({ user_id: '1', username: 'u', auth_code: 'c', hash: 'h' })).toEqual({
      userId: '1', username: 'u', authCode: 'c', hash: 'h',
    });
    expect(readIframeParams({ id_user: '2', code: 'x' }).userId).toBe('2');
  });

  it('compares strings in constant time semantics', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'ab')).toBe(false);
  });
});
