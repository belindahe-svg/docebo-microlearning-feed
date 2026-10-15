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

import { channelIdOf, dedupeItems } from '../src/docebo';
import { firstChannelId } from '../src/discover';

describe('all visible channels', () => {
  it('reads channel IDs from common field names', () => {
    expect(channelIdOf({ id: 7 })).toBe('7');
    expect(channelIdOf({ id_channel: '12' })).toBe('12');
    expect(channelIdOf({ name: 'x' })).toBeUndefined();
  });
  it('merges channels without duplicates, keeping order', () => {
    const a = { key: 'asset:1', id: '1', kind: 'asset', subtype: '', title: 'A', doceboUrl: '' } as const;
    const b = { ...a, key: 'course:2', id: '2', kind: 'course', title: 'B' } as const;
    expect(dedupeItems([[a, b], [b, a]]).map((i) => i.key)).toEqual(['asset:1', 'course:2']);
  });
  it('finds the first channel in a list response', () => {
    expect(firstChannelId({ data: { items: [{ id: 5, name: 'Bite-size' }] } })).toBe('5');
    expect(firstChannelId({ data: { items: [] } })).toBeUndefined();
  });
});

describe('channel asset rows (confirmed shape)', () => {
  const row = { id: 39, type_id: 1, title: 'Time Management', content_type: 'video', image_url: 'https://cdn/x.jpg', uri: '/learn/course/39/time-management', rating: 4 };
  it('maps uri, image_url and content_type', () => {
    const it = normalizeItem(row, 'atalentdemo2.docebosaas.com')!;
    expect(it.kind).toBe('course');
    expect(it.doceboUrl).toBe('https://atalentdemo2.docebosaas.com/learn/course/39/time-management');
    expect(it.thumbnailUrl).toBe('https://cdn/x.jpg');
    expect(it.subtype).toBe('video');
  });
  it('detects assets and learning plans from the uri', () => {
    expect(normalizeItem({ ...row, uri: '/share/asset/view/32' }, 'd')!.kind).toBe('asset');
    expect(normalizeItem({ ...row, uri: '/learn/learning-plans/5' }, 'd')!.kind).toBe('learning_plan');
  });
});

import { assetMediaFrom, youtubeIdFrom } from '../src/docebo';
describe('asset media', () => {
  it('parses YouTube IDs from common URL forms', () => {
    expect(youtubeIdFrom('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3')).toBe('dQw4w9WgXcQ');
    expect(youtubeIdFrom('https://youtu.be/dQw4w9WgXcQ?si=x')).toBe('dQw4w9WgXcQ');
    expect(youtubeIdFrom('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeIdFrom('https://hbr.org/2020/01/x')).toBeUndefined();
  });
  it('reads the confirmed Docebo asset detail shape', () => {
    const yt = assetMediaFrom({ data: { player: { player_type: 'embeded', config: { total_pages: 1 }, content: {
      sources: [{ url: 'https://youtu.be/dQw4w9WgXcQ?si=abc' }], thumbnail: { cover: 'https://cdn1.dcbstatic.com/c.jpg' } } } } });
    expect(yt).toEqual({ youtubeId: 'dQw4w9WgXcQ', thumbnailUrl: 'https://cdn1.dcbstatic.com/c.jpg', subtype: 'Video' });
    const link = assetMediaFrom({ data: { player: { player_type: 'link_player', content: { sources: [{ url: 'https://hbr.org/x' }] } } } });
    expect(link.subtype).toBe('Link');
    expect(link.youtubeId).toBeUndefined();
  });
});

describe('uploaded video assets', () => {
  it('returns a direct video URL from a Docebo-hosted source', () => {
    const m = assetMediaFrom({ data: { player: { player_type: 'video', content: {
      name_original: 'personality.mp4', sources: [{ url: 'https://media.docebosaas.com/abc/stream?sig=1' }] } } } });
    expect(m.videoUrl).toBe('https://media.docebosaas.com/abc/stream?sig=1');
    expect(m.subtype).toBe('Video');
  });
  it('never treats links or YouTube as direct video', () => {
    expect(assetMediaFrom({ data: { player: { player_type: 'link_player', content: { sources: [{ url: 'https://x.com/a.mp4' }] } } } }).videoUrl).toBeUndefined();
    expect(assetMediaFrom({ data: { player: { player_type: 'embeded', content: { sources: [{ url: 'https://youtu.be/dQw4w9WgXcQ' }] } } } }).videoUrl).toBeUndefined();
  });
});

describe('confirmed flowplayer upload shape (asset #75)', () => {
  it('prefers the MP4 and reads thumbnails (plural)', () => {
    const m = assetMediaFrom({ data: { player: { player_type: 'flowplayer', content_type: 1, content: {
      name_original: 'p.mp4', name_converted: 'p.mp4',
      sources: [{ src: 'https://cdn1.dcbstatic.com/v/p.m3u8' }, { src: 'https://cdn1.dcbstatic.com/v/p.mp4' }],
      thumbnails: { cover: 'https://cdn1.dcbstatic.com/t/c.jpg' } } } } });
    expect(m.videoUrl).toBe('https://cdn1.dcbstatic.com/v/p.mp4');
    expect(m.thumbnailUrl).toBe('https://cdn1.dcbstatic.com/t/c.jpg');
    expect(m.subtype).toBe('Video');
  });
});

describe('protocol-relative Docebo CDN links (real asset #75 shape)', () => {
  it('turns //cdn1.dcbstatic.com links into https and picks the MP4', () => {
    const m = assetMediaFrom({ data: { player: { player_type: 'flowplayer', content: {
      sources: [
        { src: '//cdn1.dcbstatic.com/files/a/t/x/1792062000/k/app7020/video/h/h.m3u8', type: 'application/x-mpegurl' },
        { src: '//cdn1.dcbstatic.com/files/a/t/x/1792062000/k/app7020/video/h/h.mp4', type: 'video/mp4' },
      ],
      thumbnails: { cover: '//cdn1.dcbstatic.com/t/c.jpg' } } } } });
    expect(m.videoUrl).toBe('https://cdn1.dcbstatic.com/files/a/t/x/1792062000/k/app7020/video/h/h.mp4');
    expect(m.thumbnailUrl).toBe('https://cdn1.dcbstatic.com/t/c.jpg');
  });
});
