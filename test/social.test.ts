import { describe, expect, it } from 'vitest';
import { mapDoceboComment } from '../src/social';

describe('Docebo comment mapping (confirmed /share/v1/comments item shape)', () => {
  const raw = { id: 812, title: 'Great clip', owner: { id: 13, full_name: 'Lee Learner', short_name: 'Lee' }, metadata: { created_at: '2026-10-15 08:30:00' } };
  it('maps text, author, time and a Docebo-namespaced id', () => {
    const c = mapDoceboComment(raw, '13');
    expect(c).toEqual({ id: 'd812', username: 'Lee Learner', body: 'Great clip', createdAt: Date.UTC(2026, 9, 15, 8, 30) / 1000, mine: true });
  });
  it('marks other people\'s comments as not mine', () => {
    expect(mapDoceboComment(raw, '99').mine).toBe(false);
  });
});
