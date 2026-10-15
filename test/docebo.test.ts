import { describe, expect, it } from 'vitest';
import { extractRows, normalizeItem } from '../src/docebo';
import { MOCK_ITEMS } from '../src/mock';

const D = 'atalentdemo2.docebosaas.com';

describe('normalizeItem', () => {
  it('maps a video asset and builds the Docebo deep link', () => {
    const it_ = normalizeItem({ id: 32, item_type: 'asset', title: 'Sales video', subtype: 'Video' }, D);
    expect(it_).toMatchObject({ key: 'asset:32', kind: 'asset', subtype: 'Video', doceboUrl: `https://${D}/share/asset/view/32` });
  });

  it('maps a course with status and slug', () => {
    const it_ = normalizeItem({ id_course: 44, type: 'course', name: 'Comms', slug_name: 'comms', enrollment_status: 'In progress' }, D);
    expect(it_).toMatchObject({ key: 'course:44', status: 'In progress', doceboUrl: `https://${D}/learn/course/44/comms` });
  });

  it('only keeps direct media files as playable video URLs', () => {
    expect(normalizeItem({ id: 1, title: 'a', video_url: 'https://cdn.x/v.mp4' }, D)?.videoUrl).toBe('https://cdn.x/v.mp4');
    expect(normalizeItem({ id: 1, title: 'a', video_url: 'https://youtube.com/watch?v=1' }, D)?.videoUrl).toBeUndefined();
  });

  it('drops rows without an id or title', () => {
    expect(normalizeItem({ title: 'no id' }, D)).toBeNull();
    expect(normalizeItem({ id: 3 }, D)).toBeNull();
  });
});

describe('extractRows', () => {
  it('reads Docebo-style { data: { items } } and plain arrays', () => {
    expect(extractRows({ data: { items: [{ id: 1 }] } })).toHaveLength(1);
    expect(extractRows([{ id: 1 }, { id: 2 }])).toHaveLength(2);
    expect(extractRows({ data: {} })).toEqual([]);
  });
});

describe('mock items', () => {
  it('has 10 items with unique keys and Docebo links', () => {
    expect(MOCK_ITEMS).toHaveLength(10);
    expect(new Set(MOCK_ITEMS.map((i) => i.key)).size).toBe(10);
    for (const i of MOCK_ITEMS) expect(i.doceboUrl).toMatch(/^https:\/\/atalentdemo2\.docebosaas\.com\//);
  });
});
