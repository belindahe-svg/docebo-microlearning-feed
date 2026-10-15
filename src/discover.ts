import type { Env } from './types';

/**
 * Discovery mode: probes candidate Docebo endpoints with the signed-in learner's own token
 * and reports status codes and field names (no values beyond IDs and titles).
 * Only runs for users listed in DISCOVERY_USERS. Read-only: GET requests only.
 * The paths are guesses to check, not confirmed endpoints.
 */
export function isDiscoveryUser(env: Env, userId: string, username: string): boolean {
  const allow = (env.DISCOVERY_USERS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return allow.includes(userId.toLowerCase()) || allow.includes(username.toLowerCase());
}

export function candidatePaths(channelId: string, assetId: string): Array<[string, string]> {
  const c = channelId;
  return [
    ['List channels', '/learn/v1/channels'],
    ['List channels (share)', '/share/v1/channels'],
    ...((c
      ? [
          ['Channel detail', `/learn/v1/channels/${c}`],
          ['Channel items', `/learn/v1/channels/${c}/items`],
          ['Channel objects', `/learn/v1/channels/${c}/objects`],
          ['Channel contents', `/learn/v1/channels/${c}/contents`],
          ['Channel content', `/learn/v1/channels/${c}/content`],
          ['Channel assets (learn)', `/learn/v1/channels/${c}/assets`],
          ['Channel sub_items', `/learn/v1/channels/${c}/sub_items`],
          ['Channel items (query)', `/learn/v1/channels/items?id_channel=${c}`],
          ['Channel list filtered', `/learn/v1/channels?id_channel=${c}`],
          ['Channel detail (share)', `/share/v1/channels/${c}`],
          ['Channel assets (share)', `/share/v1/channels/${c}/assets`],
          ['Assets by channel (share)', `/share/v1/assets?channel_id=${c}`],
          ['Assets by channel (share, alt)', `/share/v1/assets?id_channel=${c}`],
        ]
      : []) as Array<[string, string]>),
    ['Asset detail (share)', `/share/v1/assets/${assetId}`],
    ['Asset detail (learn)', `/learn/v1/assets/${assetId}`],
    ['My enrolments', '/learn/v1/enrollments?page_size=5'],
  ];
}

type Json = Record<string, unknown>;

/** Field names of a nested object or of the first row of a nested array (names only, no values). */
function nestedShape(name: string, v: unknown): string {
  if (Array.isArray(v)) {
    const first = (v[0] ?? {}) as Json;
    return ` | ${name}: ${v.length} rows, fields: ${typeof v[0] === 'object' && v[0] ? Object.keys(first).join(', ') : typeof v[0]}`;
  }
  if (v && typeof v === 'object') return ` | ${name}: object, fields: ${Object.keys(v as Json).join(', ')}`;
  return '';
}

const NESTED = ['sub_items', 'player', 'info', 'playlist', 'channels'];

export function describeBody(body: unknown): string {
  const b = body as Json;
  const data = (b?.data ?? b) as Json;
  const rows = (data?.items ?? data?.results ?? (Array.isArray(data) ? data : null)) as unknown;
  if (Array.isArray(rows)) {
    const first = (rows[0] ?? {}) as Json;
    const name = first.title ?? first.name;
    const id = first.id ?? first.id_channel ?? first.id_asset ?? first.id_course;
    // For sub_items, report the first row that actually has some, so an empty first channel does not hide the shape.
    const withSub = (rows as Json[]).find((r) => Array.isArray(r.sub_items) && (r.sub_items as unknown[]).length) ?? first;
    return (
      `${rows.length} rows. Fields: ${Object.keys(first).join(', ') || '(empty)'}` +
      (name ? `. First: ${id !== undefined ? `#${id} ` : ''}"${name}"` : '') +
      NESTED.map((k) => nestedShape(k, (k === 'sub_items' ? withSub : first)[k])).join('') +
      (withSub !== first && withSub.id !== undefined ? ` (sub_items shape from channel #${withSub.id})` : '')
    );
  }
  return `Object. Fields: ${Object.keys(data ?? {}).join(', ')}` + NESTED.map((k) => nestedShape(k, data?.[k])).join('');
}

/** Channel to probe: the first custom channel in a channel-list response (else the first channel), used to probe item endpoints when none is configured. */
export function firstChannelId(body: unknown): string | undefined {
  const b = body as Json;
  const data = (b?.data ?? b) as Json;
  const rows = (data?.items ?? data?.results ?? (Array.isArray(data) ? data : null)) as unknown;
  if (!Array.isArray(rows) || !rows.length) return undefined;
  // Prefer a custom channel: predefined system channels (predefined_uid set) may have no item endpoint.
  const r = ((rows as Json[]).find((x) => !x.predefined_uid) ?? rows[0]) as Json;
  const id = r.id ?? r.id_channel ?? r.channel_id ?? r.idChannel;
  return id === undefined || id === null || id === '' ? undefined : String(id);
}

export async function runDiscovery(env: Env, token: string) {
  const assetId = env.DISCOVERY_ASSET_ID || '32';
  const results: Array<{ label: string; path: string; status: number; detail: string }> = [];
  let channelId = env.DOCEBO_CHANNEL_ID;
  const probe = async (label: string, path: string) => {
    try {
      const res = await fetch(`https://${env.DOCEBO_DOMAIN}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      const body = res.ok ? await res.json().catch(() => ({})) : undefined;
      results.push({ label, path, status: res.status, detail: body === undefined ? '' : describeBody(body) });
      return body;
    } catch (e) {
      results.push({ label, path, status: 0, detail: (e as Error).message });
      return undefined;
    }
  };
  // Channel lists first, so the item endpoints can be tried on a real channel the learner can see.
  for (const [label, path] of candidatePaths('', assetId).filter(([, p]) => p.endsWith('/channels'))) {
    const body = await probe(label, path);
    if (!channelId && body !== undefined) channelId = firstChannelId(body) ?? '';
  }
  for (const [label, path] of candidatePaths(channelId, assetId).filter(([, p]) => !p.endsWith('/channels'))) {
    await probe(channelId && !env.DOCEBO_CHANNEL_ID && path.includes('/channels/') ? `${label} (visible channel #${channelId})` : label, path);
  }
  return results;
}
