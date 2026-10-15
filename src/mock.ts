import type { FeedItem } from './types';

/**
 * Real items captured from atalentdemo2.docebosaas.com on 2026-10-15 via the Docebo connector
 * (IDs, titles, types, subtypes, ratings and the demo learner's status).
 * Used when DOCEBO_MODE = "mock" so the feed runs before the Channel endpoint is confirmed.
 * No video URLs: add them with a media override (see README) to test playback.
 */
const BASE = 'https://atalentdemo2.docebosaas.com';

const raw: Array<[FeedItem['kind'], string, string, string, string?, number?]> = [
  ['asset', '32', 'Video', 'Best B2B Sales Strategies For Account Executive & Sales Consultant'],
  ['course', '44', 'E-Learning', 'Business Communication Skills', 'In progress'],
  ['asset', '31', 'Video', 'How to Be a Good Account Executive | 5 Keys to Success'],
  ['asset', '27', 'Video', 'The Law office', undefined, 5],
  ['course', '38', 'E-Learning', 'Introduction to Leadership', 'In progress'],
  ['asset', '24', 'Video', 'Floor 7 - The circuit room: How to pick the right learning tech for your needs'],
  ['course', '112', 'E-Learning', 'How to Have a Conversation about Mental Health (CPD certified)', 'Not started'],
  ['asset', '25', 'Video', 'Floor 8 - The architect’s office: LMS implementation the right way'],
  ['course', '126', 'E-Learning', 'Leadership', 'Not started', 5],
  ['asset', '26', 'Video', 'Floor 9 - The kitchen: Serving up the best e-learning content'],
];

const slugs: Record<string, string> = {
  '44': 'business-communication-skills',
  '38': 'introduction-to-leadership',
  '112': 'how-to-have-a-conversation-about-mental-health-cpd-certified',
  '126': 'leadership',
};

export const MOCK_ITEMS: FeedItem[] = raw.map(([kind, id, subtype, title, status, rating]) => ({
  key: `${kind}:${id}`,
  id,
  kind,
  subtype,
  title,
  status,
  rating,
  doceboUrl:
    kind === 'asset' ? `${BASE}/share/asset/view/${id}` : `${BASE}/learn/course/${id}/${slugs[id] ?? ''}`,
}));
