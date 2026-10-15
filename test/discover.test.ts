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

import { firstChannelId as pickChannel } from '../src/discover';
describe('discovery channel choice and shapes', () => {
  it('prefers a custom channel over a predefined one', () => {
    expect(pickChannel({ data: { items: [{ id: 7, predefined_uid: 'continue' }, { id: 12, predefined_uid: null }] } })).toBe('12');
    expect(pickChannel({ data: { items: [{ id: 7, predefined_uid: 'x' }] } })).toBe('7');
  });
  it('reports nested field names without values', () => {
    const out = describeBody({ data: { items: [{ id: 7, name: 'A', sub_items: [] }, { id: 9, name: 'B', sub_items: [{ id: 1, title: 'secret title' }] }] } });
    expect(out).toContain('sub_items: 1 rows, fields: id, title');
    expect(out).toContain('channel #9');
    expect(out).not.toContain('secret title');
    expect(describeBody({ data: { id: 32, player: { url: 'x', type: 'video' } } })).toContain('player: object, fields: url, type');
  });
});

import { describePlayer, describeItemValues } from '../src/discover';
describe('value checks', () => {
  it('finds media file paths without printing URLs', () => {
    const out = describePlayer({ data: { kind: 'video', player: { player_type: 'video', content: { sources: [{ src: 'https://cdn/a/b.m3u8?t=1' }] } } } });
    expect(out).toContain('player.content.sources[0].src (.m3u8)');
    expect(out).not.toContain('https://cdn');
  });
  it('lists distinct item types', () => {
    expect(describeItemValues({ data: { items: [{ type_id: 1, content_type: 'video', uri: '/x' }, { type_id: 1, content_type: 'course' }] } })).toContain('content_type: video, course');
  });
});
