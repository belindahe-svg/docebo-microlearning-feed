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
  // Channel items carry a `uri` deep link; its path is the most reliable signal of the kind.
  const uri = String(pick(o, 'uri', 'url', 'deeplink') ?? '').toLowerCase();
  if (/learning[-_]?plans?\b|\/lp\//.test(uri)) return 'learning_plan';
  if (/\/course\//.test(uri)) return 'course';
  if (/\/asset|\/share\//.test(uri)) return 'asset';
  const t = String(pick(o, 'item_type', 'type', 'object_type', 'resource_type', 'type_id', 'content_type') ?? '').toLowerCase();
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
  const rawLink = str(pick(o, 'uri', 'url', 'deeplink', 'item_url', 'link'));
  const link = rawLink && rawLink.startsWith('/') ? `${base}${rawLink}` : rawLink;
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
    thumbnailUrl: absUrl(pick(o, 'image_url', 'thumbnail', 'thumbnail_url', 'image', 'cover')),
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

export interface VisibleChannel {
  id: string;
  name: string;
  /** Preview of the channel's items that Docebo embeds in the channel list (first ~10). */
  preview: Json[];
}

/** Every channel the learner can see. Docebo filters the list by the token's user. */
export async function listVisibleChannels(env: Env, token: string): Promise<VisibleChannel[]> {
  const path = env.DOCEBO_CHANNELS_LIST_PATH || '/learn/v1/channels';
  const out: VisibleChannel[] = [];
  for (let page = 1; page <= 5; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const body = (await doceboGet(env, token, `${path}${sep}page=${page}&page_size=50`)) as Json;
    for (const row of extractRows(body)) {
      const id = channelIdOf(row);
      if (id && !out.some((c) => c.id === id)) {
        out.push({ id, name: str(pick(row, 'name', 'title')) ?? `Channel ${id}`, preview: Array.isArray(row.sub_items) ? (row.sub_items as Json[]) : [] });
      }
    }
    const data = (body?.data ?? {}) as Json;
    if (!data.has_more_data) break;
  }
  return out;
}

export async function listVisibleChannelIds(env: Env, token: string): Promise<string[]> {
  return (await listVisibleChannels(env, token)).map((c) => c.id);
}

/** Merge item lists, keeping the first occurrence of each item key and the union of its channel names. */
export function dedupeItems(lists: FeedItem[][]): FeedItem[] {
  const byKey = new Map<string, FeedItem>();
  for (const list of lists) {
    for (const it of list) {
      const prev = byKey.get(it.key);
      if (!prev) byKey.set(it.key, { ...it, channels: [...(it.channels ?? [])] });
      else for (const c of it.channels ?? []) if (!prev.channels!.includes(c)) prev.channels!.push(c);
    }
  }
  return [...byKey.values()];
}

/**
 * Feed items. With DOCEBO_CHANNEL_ID set, reads that one channel. With it empty, reads every
 * channel visible to the learner and merges them (duplicates removed, channel order kept).
 */
export async function getChannelItems(env: Env, token: string | null): Promise<FeedItem[]> {
  if (env.DOCEBO_MODE !== 'live') return MOCK_ITEMS;
  if (!token) throw new Error('No Docebo token for this session');
  if (env.DOCEBO_CHANNEL_ID) return getItemsForChannel(env, token, env.DOCEBO_CHANNEL_ID);
  const channels = (await listVisibleChannels(env, token)).slice(0, 20);
  // One failing channel should not empty the whole feed: fall back to the preview items
  // Docebo embeds in the channel list.
  const lists = await Promise.all(
    channels.map((c) =>
      getItemsForChannel(env, token, c.id).catch(() =>
        c.preview.map((row) => normalizeItem(row, env.DOCEBO_DOMAIN)).filter((x): x is FeedItem => x !== null),
      ),
    ),
  );
  return dedupeItems(lists.map((list, i) => list.map((it) => ({ ...it, channels: [channels[i].name] }))));
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

/** What the feed needs from an asset's detail record to play or preview it. */
/** Docebo writes CDN links protocol-relative ("//cdn1.dcbstatic.com/..."); make them absolute https. */
export function absUrl(u: unknown): string | undefined {
  const v = str(u);
  if (!v) return undefined;
  return v.startsWith('//') ? `https:${v}` : v;
}

export interface AssetMedia {
  youtubeId?: string;
  videoUrl?: string;      // direct file or HLS stream for uploaded videos
  thumbnailUrl?: string;
  subtype?: string;
}

/** YouTube video ID from watch, youtu.be, embed or shorts URLs. */
export function youtubeIdFrom(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let u: URL;
  try { u = new URL(url); } catch { return undefined; }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  let id: string | null | undefined;
  if (host === 'youtu.be') id = u.pathname.split('/')[1];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = u.searchParams.get('v') ?? /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(u.pathname)?.[1];
  }
  return id && /^[\w-]{11}$/.test(id) ? id : undefined;
}

/**
 * Read an asset detail (GET /share/v1/assets/{id}). Confirmed on atalentdemo2: video assets use
 * player_type "embeded" with the source URL in player.content.sources[0].url (YouTube there);
 * links use player_type "link_player"; thumbnails sit in player.content.thumbnail.
 */
export function assetMediaFrom(body: unknown): AssetMedia {
  const b = body as Json;
  const d = (b?.data ?? b) as Json;
  const p = (d?.player ?? {}) as Json;
  const c = (p.content ?? {}) as Json;
  const sources = Array.isArray(c.sources) ? (c.sources as Json[]) : [];
  const urls = [...sources.map((s) => absUrl(s?.url ?? s?.src)), absUrl(c.name_original)].filter(Boolean) as string[];
  const youtubeId = urls.map(youtubeIdFrom).find(Boolean);
  const thumb = (c.thumbnail ?? c.thumbnails ?? {}) as Json; // YouTube assets: thumbnail; uploads: thumbnails
  const thumbnailUrl =
    absUrl(thumb.cover) ?? absUrl(thumb.rectangular) ?? absUrl(thumb.original) ??
    (typeof d?.thumbnail === 'string' ? absUrl(d.thumbnail) : absUrl((d?.thumbnail as Json)?.url)) ??
    (youtubeId ? `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg` : undefined);
  const playerType = String(p.player_type ?? '').toLowerCase();
  const config = (p.config ?? {}) as Json;
  // Uploaded videos: a Docebo-hosted http(s) source on a non-link player, recognised by the file
  // extension of the source or of the original upload name, or by a video/media player type.
  const VIDEO_EXT = /\.(mp4|m4v|mov|webm|m3u8)(\?|#|$)/i;
  const isLink = playerType.includes('link');
  const nameLooksVideo = VIDEO_EXT.test(String(c.name_original ?? '')) || VIDEO_EXT.test(String(c.name_converted ?? ''));
  // Uploads (flowplayer) list an HLS stream and an MP4 on cdn1.dcbstatic.com. Prefer the MP4: it plays
  // everywhere without hls.js and is fine for short clips.
  const candidates = !youtubeId && !isLink
    ? [...sources.map((s) => absUrl(s?.src ?? s?.url ?? s?.file)), absUrl(c.name_converted)]
        .filter((u): u is string => !!u && /^https?:\/\//i.test(u) && !/youtu\.?be|vimeo\.com|wistia/i.test(u))
        .filter((u) => VIDEO_EXT.test(u) || nameLooksVideo || /video|media|flowplayer/.test(playerType))
    : [];
  const direct = candidates.find((u) => /\.(mp4|m4v|webm)(\?|#|$)/i.test(u)) ?? candidates[0];
  const subtype = youtubeId || direct || /vimeo|wistia|\.mp4|\.m3u8/i.test(urls.join(' '))
    ? 'Video'
    : playerType.includes('link')
      ? 'Link'
      : config.total_pages
        ? 'Document'
        : undefined;
  return { youtubeId, videoUrl: direct, thumbnailUrl, subtype };
}

// Per-isolate cache: asset media rarely changes, and this keeps repeat scrolls off the Docebo API.
const mediaCache = new Map<string, { at: number; v: AssetMedia }>();
const MEDIA_TTL_MS = 20 * 60 * 1000; // CDN paths carry an expiry timestamp; stay well inside it

export async function getAssetMedia(env: Env, token: string | null, assetId: string): Promise<AssetMedia> {
  if (env.DOCEBO_MODE !== 'live' || !token) return {};
  const key = `${env.DOCEBO_DOMAIN}:${assetId}`;
  const hit = mediaCache.get(key);
  if (hit && Date.now() - hit.at < MEDIA_TTL_MS) return hit.v;
  const v = assetMediaFrom(await doceboGet(env, token, `/share/v1/assets/${encodeURIComponent(assetId)}`));
  if (mediaCache.size > 2000) mediaCache.clear();
  mediaCache.set(key, { at: Date.now(), v });
  return v;
}
