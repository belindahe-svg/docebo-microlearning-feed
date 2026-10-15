import type { Env } from './types';
import { getChannelItems } from './docebo';

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
  const results: Array<{ label: string; path: string; status: number | string; detail: string }> = [];
  const bodies: Record<string, unknown> = {};
  let channelId = env.DOCEBO_CHANNEL_ID;
  const probe = async (label: string, path: string) => {
    try {
      const res = await fetch(`https://${env.DOCEBO_DOMAIN}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      const body = res.ok ? await res.json().catch(() => ({})) : undefined;
      results.push({ label, path, status: res.status, detail: body === undefined ? '' : describeBody(body) });
      if (body !== undefined) bodies[path] = body;
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

  // Value checks: enum-like fields only (types, deep-link paths), never descriptions or user data.
  const itemsBody = channelId ? bodies[`/learn/v1/channels/${channelId}/assets`] : undefined;
  if (itemsBody !== undefined) results.push({ label: 'Channel item values', path: '', status: 'INFO', detail: describeItemValues(itemsBody) });
  const assetBody = bodies[`/share/v1/assets/${assetId}`];
  if (assetBody !== undefined) results.push({ label: `Asset #${assetId} player`, path: '', status: 'INFO', detail: describePlayer(assetBody) });

  // End-to-end: the cards the feed would actually build for this learner.
  try {
    const items = await getChannelItems({ ...env, DOCEBO_MODE: 'live' }, token);
    const kinds = items.reduce<Record<string, number>>((a, i) => ((a[i.kind] = (a[i.kind] ?? 0) + 1), a), {});
    const sample = items
      .slice(0, 4)
      .map((i) => `\n       ${i.key} [${i.subtype || '-'}] "${i.title}" -> ${i.doceboUrl}${i.thumbnailUrl ? ' (thumb)' : ''}`)
      .join('');
    const subtypes = (k: string) => [...new Set(items.filter((i) => i.kind === k).map((i) => i.subtype || '-'))].slice(0, 8).join(', ');
    const assetSample = items
      .filter((i) => i.kind === 'asset')
      .slice(0, 3)
      .map((i) => `\n       ${i.key} [${i.subtype || '-'}] "${i.title}" -> ${i.doceboUrl}`)
      .join('');
    results.push({
      label: 'Feed preview',
      path: '',
      status: 'INFO',
      detail: `${items.length} cards. Kinds: ${JSON.stringify(kinds)} | asset types: ${subtypes('asset')} | course types: ${subtypes('course')}${sample}${assetSample}`,
    });
    // Player check on real assets from the feed, videos first (asset #${assetId} above may be a document).
    const assets = items.filter((i) => i.kind === 'asset');
    const picks = [...assets.filter((i) => /video|mp4|media/i.test(i.subtype)), ...assets].filter((x, i, a) => a.indexOf(x) === i).slice(0, 2);
    for (const a of picks) {
      if (a.id === assetId) continue;
      const path = `/share/v1/assets/${encodeURIComponent(a.id)}`;
      const body = await probe(`Asset #${a.id} [${a.subtype || '-'}] detail`, path);
      if (body !== undefined) results.push({ label: `Asset #${a.id} player`, path: '', status: 'INFO', detail: describePlayer(body) });
    }
  } catch (e) {
    results.push({ label: 'Feed preview', path: '', status: 'FAIL', detail: (e as Error).message });
  }
  return results;
}

function rowsOf(body: unknown): Json[] {
  const b = body as Json;
  const data = (b?.data ?? b) as Json;
  const rows = (data?.items ?? data?.results ?? (Array.isArray(data) ? data : null)) as unknown;
  return Array.isArray(rows) ? (rows as Json[]) : [];
}

function distinct(rows: Json[], key: string): string {
  return [...new Set(rows.map((r) => r[key]).filter((v) => v !== undefined && v !== null && v !== '').map(String))].slice(0, 8).join(', ') || '(none)';
}

export function describeItemValues(body: unknown): string {
  const rows = rowsOf(body);
  const uris = rows.slice(0, 3).map((r) => String(r.uri ?? '')).filter(Boolean).join('  ');
  return `type_id: ${distinct(rows, 'type_id')} | content_type: ${distinct(rows, 'content_type')} | uri examples: ${uris || '(none)'}`;
}

/** Where (if anywhere) the player holds a direct media file. Reports key paths and extensions, not URLs. */
export function findMediaPaths(v: unknown, path = 'player', out: string[] = []): string[] {
  if (typeof v === 'string') {
    const m = /\.(mp4|m3u8|webm|mpd)(\?|$|")/i.exec(v);
    if (m) out.push(`${path} (.${m[1].toLowerCase()})`);
  } else if (Array.isArray(v)) {
    v.slice(0, 10).forEach((x, i) => findMediaPaths(x, `${path}[${i}]`, out));
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Json)) findMediaPaths(x, `${path}.${k}`, out);
  }
  return out;
}

export function describePlayer(body: unknown): string {
  const b = body as Json;
  const data = (b?.data ?? b) as Json;
  const p = (data?.player ?? {}) as Json;
  const keys = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v as Json).join(', ') : typeof v);
  const media = findMediaPaths(p);
  return (
    `kind: ${data?.kind && typeof data.kind === 'object' ? `{${keys(data.kind)}}` : String(data?.kind ?? '-')} | player_type: ${String(p.player_type ?? '-')} | content_type: ${String(p.content_type ?? '-')}` +
    ` | config: ${keys(p.config)} | content: ${keys(p.content)}` +
    ` | streamable file: ${media.length ? media.slice(0, 4).join('; ') : 'none found'}`
    + ` | URLs in player: ${urlShapes(p).slice(0, 6).join('; ') || 'none'}`
  );
}

/** Every URL-valued string under the player, reported as key path + host + extension (no path or query). */
export function urlShapes(v: unknown, path = 'player', out: string[] = []): string[] {
  if (typeof v === 'string') {
    if (/^(https?:)?\/\//i.test(v) || /^\/[\w-]/.test(v)) {
      let host = '(relative)';
      try { host = new URL(v, 'https://relative.invalid').host.replace('relative.invalid', '(relative)'); } catch { /* keep */ }
      const ext = /\.([a-z0-9]{2,5})(\?|$)/i.exec(v.split('#')[0].split('?')[0] + '?');
      out.push(`${path} -> ${host} [${ext ? '.' + ext[1].toLowerCase() : 'no ext'}${v.includes('?') ? ', signed/query' : ''}]`);
    }
  } else if (Array.isArray(v)) {
    v.slice(0, 5).forEach((x, i) => urlShapes(x, `${path}[${i}]`, out));
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Json)) urlShapes(x, `${path}.${k}`, out);
  }
  return out;
}
