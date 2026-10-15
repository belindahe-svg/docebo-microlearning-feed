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
  return [
    ['List channels', '/learn/v1/channels'],
    ['List channels (share)', '/share/v1/channels'],
    ...((channelId
      ? [
          ['Channel detail', `/learn/v1/channels/${channelId}`],
          ['Channel items', `/learn/v1/channels/${channelId}/items`],
          ['Channel objects', `/learn/v1/channels/${channelId}/objects`],
          ['Channel assets (share)', `/share/v1/channels/${channelId}/assets`],
        ]
      : []) as Array<[string, string]>),
    ['Asset detail (share)', `/share/v1/assets/${assetId}`],
    ['Asset detail (learn)', `/learn/v1/assets/${assetId}`],
    ['My enrolments', '/learn/v1/enrollments?page_size=5'],
  ];
}

type Json = Record<string, unknown>;

export function describeBody(body: unknown): string {
  const b = body as Json;
  const data = (b?.data ?? b) as Json;
  const rows = (data?.items ?? data?.results ?? (Array.isArray(data) ? data : null)) as unknown;
  if (Array.isArray(rows)) {
    const first = (rows[0] ?? {}) as Json;
    const name = first.title ?? first.name;
    const id = first.id ?? first.id_channel ?? first.id_asset ?? first.id_course;
    return (
      `${rows.length} rows. Fields: ${Object.keys(first).join(', ') || '(empty)'}` +
      (name ? `. First: ${id !== undefined ? `#${id} ` : ''}"${name}"` : '')
    );
  }
  return `Object. Fields: ${Object.keys(data ?? {}).join(', ')}`;
}

/** First channel ID in a channel-list response, used to probe item endpoints when none is configured. */
export function firstChannelId(body: unknown): string | undefined {
  const b = body as Json;
  const data = (b?.data ?? b) as Json;
  const rows = (data?.items ?? data?.results ?? (Array.isArray(data) ? data : null)) as unknown;
  if (!Array.isArray(rows) || !rows.length) return undefined;
  const r = rows[0] as Json;
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
    await probe(channelId && !env.DOCEBO_CHANNEL_ID && path.includes('/channels/') ? `${label} (first visible channel #${channelId})` : label, path);
  }
  return results;
}
