import { describe, expect, it } from 'vitest';
import { candidatePaths, describeBody, isDiscoveryUser } from '../src/discover';
import type { Env } from '../src/types';

describe('discovery', () => {
  it('only allows listed users, by ID or username, case-insensitive', () => {
    const env = { DISCOVERY_USERS: 'belinda, 12345' } as unknown as Env;
    expect(isDiscoveryUser(env, '1', 'Belinda')).toBe(true);
    expect(isDiscoveryUser(env, '12345', 'x')).toBe(true);
    expect(isDiscoveryUser(env, '9', 'someone')).toBe(false);
    expect(isDiscoveryUser({ DISCOVERY_USERS: '' } as unknown as Env, '9', '')).toBe(false);
  });

  it('adds channel paths only when a channel ID is set', () => {
    expect(candidatePaths('', '32').some(([, p]) => p.includes('/channels/'))).toBe(false);
    expect(candidatePaths('7', '32').some(([, p]) => p === '/learn/v1/channels/7/items')).toBe(true);
  });

  it('describes field names and the first row', () => {
    const d = describeBody({ data: { items: [{ id: 7, name: 'Bite-size Learning', visibility: 'all' }] } });
    expect(d).toContain('1 rows');
    expect(d).toContain('id, name, visibility');
    expect(d).toContain('#7 "Bite-size Learning"');
  });
});
