import type { Env, FeedItem, ItemKind } from './types';
import { MOCK_ITEMS } from './mock';

/**
 * Thin Docebo API client. All calls use the LEARNER's access token, so Docebo's own
 * visibility rules decide what each person sees in the feed.
 *
 * The Channel items endpoint is not documented publicly. Its path is a config value
 * (DOCEBO_CHANNEL_ITEMS_PATH) and the response is read defensively below. Confirm the
 * real path and field names with `npm run discover`, then tighten `normalizeItem`.
 */

type Json = Record<string, unknown>;

function str(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function pick(o: Json, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
}

export function kindOf(o: Json): ItemKind {
  const t = String(pick(o, 'item_type', 'type', 'object_type', 'resource_type') ?? '').toLowerCase();
  if (t.includes('plan')) return 'learning_plan';
  if (t.includes('course')) return 'course';
  return 'asset';
}

/** Map one raw Docebo object to a FeedItem. Returns null if it has no usable ID or title. */
export function normalizeItem(o: Json, domain: string): FeedItem | null {
  const kind = kindOf(o);
  const id = str(pick(o, 'id', 'item_id', 'id_asset', 'id_course', 'idCourse', 'id_path', 'resource_id'));
  const title = str(pick(o, 'title', 'name', 'item_name', 'course_name'));
  if (!id || !title) return null;
  const base = `https://${domain}`;
  const slug = str(pick(o, 'slug', 'slug_name', 'item_slug')) ?? '';
  const link = str(pick(o, 'url', 'deeplink', 'item_url', 'link'));
  const doceboUrl =
    link && link.startsWith(base)
      ? link
      : kind === 'asset'
        ? `${base}/share/asset/view/${id}`
        : kind === 'course'
          ? `${base}/learn/course/${id}/${slug}`
          : `${base}/learn/learning-plans/${id}`;
  const subtype = str(pick(o, 'subtype', 'asset_type', 'content_type', 'course_type', 'type_label')) ?? '';
  // Only treat a URL as playable if it looks like a direct media file or stream.
  const media = str(pick(o, 'video_url', 'media_url', 'stream_url', 'file_url'));
  const videoUrl = media && /\.(mp4|m3u8|webm)(\?|$)/i.test(media) ? media : undefined;
  return {
    key: `${kind}:${id}`,
    id,
    kind,
    subtype,
    title,
    description: str(pick(o, 'short_description', 'description')),
    thumbnailUrl: str(pick(o, 'thumbnail', 'thumbnail_url', 'image', 'cover')),
    videoUrl,
    doceboUrl,
    status: str(pick(o, 'enrollment_status', 'user_status', 'status_label')),
    rating: num(pick(o, 'rating', 'average_rating')),
  };
}

/** Docebo list responses usually wrap rows as { data: { items: [...] } }. Accept a few shapes. */
export function extractRows(body: unknown): Json[] {
  const b = body as Json;
  const data = (b?.data ?? b) as Json;
  const rows = (data?.items ?? data?.results ?? data?.objects ?? data) as unknown;
  return Array.isArray(rows) ? (rows as Json[]) : [];
}

export async function doceboGet(env: Env, token: string, path: string): Promise<unknown> {
  const res = await fetch(`https://${env.DOCEBO_DOMAIN}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Docebo GET ${path} failed (${res.status})`);
  return res.json();
}

/** Pull a channel ID out of one row of a channel list. */
export function channelIdOf(o: Json): string | undefined {
  return str(pick(o, 'id', 'id_channel', 'channel_id', 'idChannel'));
}

/** IDs of every channel the learner can see. Docebo filters the list by the token's user. */
export async function listVisibleChannelIds(env: Env, token: string): Promise<string[]> {
  const path = env.DOCEBO_CHANNELS_LIST_PATH || '/learn/v1/channels';
  const ids: string[] = [];
  for (let page = 1; page <= 5; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const body = (await doceboGet(env, token, `${path}${sep}page=${page}&page_size=50`)) as Json;
    for (const row of extractRows(body)) {
      const id = channelIdOf(row);
      if (id && !ids.includes(id)) ids.push(id);
    }
    const data = (body?.data ?? {}) as Json;
    if (!data.has_more_data) break;
  }
  return ids;
}

/** Merge item lists, keeping the first occurrence of each item key. */
export function dedupeItems(lists: FeedItem[][]): FeedItem[] {
  const seen = new Set<string>();
  const out: FeedItem[] = [];
  for (const list of lists) for (const it of list) if (!seen.has(it.key)) { seen.add(it.key); out.push(it); }
  return out;
}

/**
 * Feed items. With DOCEBO_CHANNEL_ID set, reads that one channel. With it empty, reads every
 * channel visible to the learner and merges them (duplicates removed, channel order kept).
 */
export async function getChannelItems(env: Env, token: string | null): Promise<FeedItem[]> {
  if (env.DOCEBO_MODE !== 'live') return MOCK_ITEMS;
  if (!token) throw new Error('No Docebo token for this session');
  if (env.DOCEBO_CHANNEL_ID) return getItemsForChannel(env, token, env.DOCEBO_CHANNEL_ID);
  const channelIds = (await listVisibleChannelIds(env, token)).slice(0, 20);
  // One failing channel should not empty the whole feed.
  const lists = await Promise.all(channelIds.map((id) => getItemsForChannel(env, token, id).catch(() => [])));
  return dedupeItems(lists);
}

async function getItemsForChannel(env: Env, token: string, channelId: string): Promise<FeedItem[]> {
  const items: FeedItem[] = [];
  const pathTpl = env.DOCEBO_CHANNEL_ITEMS_PATH.replace('{channelId}', encodeURIComponent(channelId));
  // Follow Docebo-style pagination (page / page_size / has_more_data), capped for safety.
  for (let page = 1; page <= 10; page++) {
    const sep = pathTpl.includes('?') ? '&' : '?';
    const body = (await doceboGet(env, token, `${pathTpl}${sep}page=${page}&page_size=50`)) as Json;
    for (const row of extractRows(body)) {
      const it = normalizeItem(row, env.DOCEBO_DOMAIN);
      if (it) items.push(it);
    }
    const data = (body?.data ?? {}) as Json;
    if (!data.has_more_data) break;
  }
  return items;
}

/**
 * Record a completed video view in Docebo. Only runs when DOCEBO_ASSET_VIEW_PATH is set to a
 * confirmed endpoint. Until then the feed relies on "Open in Docebo" for tracked views.
 */
export async function recordAssetView(env: Env, token: string | null, assetId: string): Promise<boolean> {
  if (env.DOCEBO_MODE !== 'live' || !token || !env.DOCEBO_ASSET_VIEW_PATH) return false;
  const path = env.DOCEBO_ASSET_VIEW_PATH.replace('{assetId}', encodeURIComponent(assetId));
  const res = await fetch(`https://${env.DOCEBO_DOMAIN}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  return res.ok;
}
