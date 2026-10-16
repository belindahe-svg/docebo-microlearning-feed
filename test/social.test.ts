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

import { contentTypeFor } from '../src/social';
describe('Docebo content types for uploads', () => {
  it('maps common files to Docebo asset types', () => {
    expect(contentTypeFor('video/mp4', 'a.mp4')).toBe(1);
    expect(contentTypeFor('image/png', 'a.png')).toBe(7);
    expect(contentTypeFor('application/pdf', 'a.pdf')).toBe(5);
    expect(contentTypeFor('', 'deck.pptx')).toBe(4);
    expect(contentTypeFor('', 'sheet.xlsx')).toBe(3);
    expect(contentTypeFor('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx')).toBe(2);
    expect(contentTypeFor('application/octet-stream', 'a.bin')).toBe(10);
  });
});

import { htmlToText } from '../src/social';
describe('Docebo HTML descriptions', () => {
  it('turns course HTML into readable text', () => {
    expect(htmlToText('<p>Our anti-corruption training&nbsp;provides the <b>skillset</b>.</p><ul><li>One</li><li>Two &amp; three</li></ul>'))
      .toBe('Our anti-corruption training provides the skillset.\nOne\nTwo & three');
  });
});

import { isDoceboUploadUrl, subfolderFor } from '../src/social';
describe('Docebo upload flow', () => {
  it('uses the subfolders of Docebo\'s own upload screen', () => {
    expect(subfolderFor(1)).toBe('video');
    expect(subfolderFor(7)).toBe('images');
    expect(subfolderFor(5)).toBe('pdf');
    expect(subfolderFor(10)).toBe('other');
  });
  it('only accepts upload URLs on Docebo storage', () => {
    expect(isDoceboUploadUrl('https://lmsfiles.s3.eu-west-1.amazonaws.com/files/a/t/x/app7020/video/h.mp4?X-Amz-Signature=1')).toBe(true);
    expect(isDoceboUploadUrl('https://evil.example.com/app7020/h.mp4')).toBe(false);
    expect(isDoceboUploadUrl('h.mp4')).toBe(false);
  });
});
