import type { Env, Session } from './types';

/**
 * Docebo-backed social actions, all called with the LEARNER's own token so Docebo applies its
 * own permissions. Endpoints confirmed from the instance's API spec (/share/v1/swagger,
 * /learn/v1/swagger) on atalentdemo2, 2026-10-15:
 *   Asset comments   GET /share/v1/assets/{id}/comments, POST /share/v1/comments {title, id_asset},
 *                    DELETE /share/v1/comments/{id}
 *   Asset rating     GET/PUT /share/v1/assets/{id}/rating {rating} -> {rating, can_rate}
 *   Course rating    POST /learn/v1/courses/{id}/rating {rating}
 *   Playlists        GET /share/v1/playlists?type_content=asset|my-course[&id_content=],
 *                    POST /share/v1/playlists {id_content, channels, title, is_private, type_content},
 *                    PUT/DELETE /share/v1/playlists/{id}/item {id_asset | id_course}
 *   Invite to watch  GET /share/v1/assets/{id}/invitations/suggestions?invite_watch=true,
 *                    GET /share/v1/assets/{id}/invitations/users?search= (3+ chars),
 *                    POST /share/v1/assets/{id}/invitations {user_ids, invite_watch}
 *   View tracking    PUT /share/v1/assets/{id}/track
 *   Contribute       POST /share/v1/link | /share/v1/videolink {url, title, description, channels},
 *                    GET /share/v1/link/meta?url=, uploads: GET /manage/v1/upload/presigned_url
 *                    (collection app7020) then POST /share/v1/assets + PUT /share/v1/assets/{id}/channels
 */

type Json = Record<string, unknown>;

export class DoceboError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** First human-readable message from a Docebo error body. */
function doceboMessage(body: unknown): string | undefined {
  const b = body as Json;
  const m = b?.message;
  if (Array.isArray(m)) return m.map(String).join(' ');
  if (typeof m === 'string') return m;
  return undefined;
}

export async function doceboCall(env: Env, token: string, method: string, path: string, body?: unknown): Promise<Json> {
  const res = await fetch(`https://${env.DOCEBO_DOMAIN}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) throw new DoceboError(res.status, doceboMessage(json) ?? `Docebo ${method} ${path} failed (${res.status})`);
  return json;
}

const dataOf = (j: Json) => (j?.data ?? {}) as Json;
const itemsOf = (j: Json) => {
  const items = dataOf(j).items;
  return Array.isArray(items) ? (items as Json[]) : [];
};

function live(env: Env, s: Session): s is Session & { access_token: string } {
  return env.DOCEBO_MODE === 'live' && !!s.access_token;
}

// ---------- comments (assets) ----------

export interface FeedComment {
  id: string;
  username: string;
  body: string;
  createdAt: number; // unix seconds
  mine: boolean;
}

function toUnix(v: unknown): number {
  const t = Date.parse(String(v ?? '').replace(' ', 'T') + (String(v ?? '').match(/Z|[+-]\d\d:?\d\d$/) ? '' : 'Z'));
  return Number.isFinite(t) ? Math.floor(t / 1000) : Math.floor(Date.now() / 1000);
}

export function mapDoceboComment(c: Json, userId: string): FeedComment {
  const owner = (c.owner ?? {}) as Json;
  const meta = (c.metadata ?? {}) as Json;
  return {
    id: `d${c.id}`,
    username: String(owner.full_name ?? owner.short_name ?? 'Learner'),
    body: String(c.title ?? ''),
    createdAt: toUnix(meta.created_at),
    mine: String(owner.id ?? '') === String(userId),
  };
}

export async function listAssetComments(env: Env, s: Session, assetId: string): Promise<FeedComment[]> {
  if (!live(env, s)) return [];
  const j = await doceboCall(env, s.access_token, 'GET',
    `/share/v1/assets/${encodeURIComponent(assetId)}/comments?page_size=100&sort_attr=created_at&sort_dir=asc`);
  return itemsOf(j).map((c) => mapDoceboComment(c, s.user_id)).sort((a, b) => a.createdAt - b.createdAt);
}

export async function countAssetComments(env: Env, token: string, assetId: string): Promise<number | undefined> {
  try {
    const j = await doceboCall(env, token, 'GET', `/share/v1/assets/${encodeURIComponent(assetId)}/comments?page_size=1`);
    const d = dataOf(j);
    const n = Number(d.total_count ?? d.count);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

export async function addAssetComment(env: Env, s: Session, assetId: string, text: string): Promise<FeedComment> {
  if (!live(env, s)) throw new DoceboError(400, 'Docebo comments need live mode');
  const j = await doceboCall(env, s.access_token, 'POST', '/share/v1/comments', { title: text, id_asset: Number(assetId) });
  return { id: `d${dataOf(j).id}`, username: s.username, body: text, createdAt: Math.floor(Date.now() / 1000), mine: true };
}

export async function deleteDoceboComment(env: Env, s: Session, commentId: string): Promise<void> {
  if (!live(env, s)) throw new DoceboError(400, 'Docebo comments need live mode');
  await doceboCall(env, s.access_token, 'DELETE', `/share/v1/comments/${encodeURIComponent(commentId)}`);
}

// ---------- ratings ----------

export interface MyRating {
  rating: number;   // the learner's own rating, 0 = not rated
  canRate: boolean;
}

export async function getAssetRating(env: Env, token: string, assetId: string): Promise<MyRating | undefined> {
  try {
    const d = dataOf(await doceboCall(env, token, 'GET', `/share/v1/assets/${encodeURIComponent(assetId)}/rating`));
    return { rating: Number(d.rating) || 0, canRate: d.can_rate !== false };
  } catch {
    return undefined;
  }
}

export async function rateItem(env: Env, s: Session, kind: string, id: string, rating: number): Promise<MyRating> {
  if (!live(env, s)) throw new DoceboError(400, 'Docebo ratings need live mode');
  if (kind === 'asset') {
    const d = dataOf(await doceboCall(env, s.access_token, 'PUT', `/share/v1/assets/${encodeURIComponent(id)}/rating`, { rating }));
    return { rating: Number(d.rating) || rating, canRate: d.can_rate !== false };
  }
  if (kind === 'course') {
    await doceboCall(env, s.access_token, 'POST', `/learn/v1/courses/${encodeURIComponent(id)}/rating`, { rating });
    return { rating, canRate: true };
  }
  throw new DoceboError(400, 'Learning plans cannot be rated in Docebo');
}

// ---------- playlists ----------

const itemBody = (kind: string, id: string) => (kind === 'asset' ? { id_asset: Number(id) } : { id_course: Number(id) });

// ---------- invite to watch (assets) ----------

export interface InviteUser {
  id: number;
  name: string;
  username: string;
  avatar?: string;
}

function mapUser(u: Json): InviteUser {
  const name = [u.firstname, u.lastname].filter(Boolean).join(' ').trim();
  return {
    id: Number(u.id ?? u.id_user ?? u.user_id),
    name: name || String(u.full_name ?? u.username ?? ''),
    username: String(u.username ?? ''),
    avatar: typeof u.avatar === 'string' && u.avatar ? (u.avatar.startsWith('//') ? `https:${u.avatar}` : u.avatar) : undefined,
  };
}

/** Suggested colleagues (no search) or a search (3+ characters, Docebo's minimum). */
export async function inviteCandidates(env: Env, s: Session, assetId: string, search: string): Promise<InviteUser[]> {
  if (!live(env, s)) return [];
  const a = encodeURIComponent(assetId);
  const path = search.length >= 3
    ? `/share/v1/assets/${a}/invitations/users?invite_watch=true&page_size=20&search=${encodeURIComponent(search)}`
    : `/share/v1/assets/${a}/invitations/suggestions?invite_watch=true`;
  return itemsOf(await doceboCall(env, s.access_token, 'GET', path)).map(mapUser).filter((u) => Number.isFinite(u.id) && u.id > 0);
}

export async function sendInvites(env: Env, s: Session, assetId: string, userIds: number[]): Promise<number> {
  if (!live(env, s)) throw new DoceboError(400, 'Invitations need live mode');
  const j = await doceboCall(env, s.access_token, 'POST', `/share/v1/assets/${encodeURIComponent(assetId)}/invitations`, {
    user_ids: userIds,
    invite_watch: true,
  });
  return Number(dataOf(j).number_of_invited_users ?? userIds.length);
}

// ---------- view tracking ----------

export async function trackAssetView(env: Env, token: string | null, assetId: string): Promise<boolean> {
  if (env.DOCEBO_MODE !== 'live' || !token) return false;
  try {
    await doceboCall(env, token, 'PUT', `/share/v1/assets/${encodeURIComponent(assetId)}/track`);
    return true;
  } catch {
    return false;
  }
}

// ---------- Save -> Docebo "Add to playlist" (learner chooses the playlist) ----------

export interface PlaylistOption {
  id: number;
  title: string;
  private: boolean;
  contains: boolean; // this item is already in the playlist
}

const playlistType = (kind: string) => (kind === 'asset' ? 'asset' : 'my-course');

function mapPlaylist(p: Json): { id: number; title: string; private: boolean } {
  return {
    id: Number(p.id ?? p.id_playlist),
    title: String(p.title ?? p.name ?? `Playlist ${p.id}`),
    private: Number(p.is_private ?? 0) === 1 || p.is_private === true,
  };
}

/** The learner's playlists, flagged with whether this item is already in each. */
export async function listPlaylistsFor(env: Env, s: Session, kind: string, id: string): Promise<PlaylistOption[]> {
  if (!live(env, s)) return [];
  const type = playlistType(kind);
  const [all, containing] = await Promise.all([
    doceboCall(env, s.access_token, 'GET', `/share/v1/playlists?type_content=${type}&page_size=200&sort_attr=title&sort_dir=asc`),
    doceboCall(env, s.access_token, 'GET', `/share/v1/playlists?type_content=${type}&id_content=${encodeURIComponent(id)}&page_size=200`),
  ]);
  const inIds = new Set(itemsOf(containing).map((p) => Number(p.id ?? p.id_playlist)));
  return itemsOf(all)
    .map(mapPlaylist)
    .filter((p) => Number.isFinite(p.id) && p.id > 0)
    .map((p) => ({ ...p, contains: inIds.has(p.id) }));
}

export async function setPlaylistItem(env: Env, s: Session, kind: string, id: string, playlistId: number, on: boolean): Promise<void> {
  if (!live(env, s)) throw new DoceboError(400, 'Playlists need live mode');
  await doceboCall(env, s.access_token, on ? 'PUT' : 'DELETE', `/share/v1/playlists/${playlistId}/item`, itemBody(kind, id));
}

/** Docebo creates a playlist together with its first item. */
export async function createPlaylistWith(env: Env, s: Session, kind: string, id: string, title: string, isPrivate: boolean): Promise<number> {
  if (!live(env, s)) throw new DoceboError(400, 'Playlists need live mode');
  const j = await doceboCall(env, s.access_token, 'POST', '/share/v1/playlists', {
    id_content: Number(id),
    type_content: playlistType(kind),
    channels: [],
    title,
    is_private: isPrivate ? 1 : 0,
  });
  return Number(dataOf(j).id);
}

// ---------- Contribute (Docebo "Share content") ----------

/** Best-effort diagnostics for the contribute flow (status codes and short errors only). */
export async function logStep(env: Env, userId: string, step: string, ok: boolean, status?: number, detail?: string): Promise<void> {
  try {
    await env.DB.prepare('INSERT INTO contrib_log (user_id, step, ok, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(userId, step, ok ? 1 : 0, status ?? null, (detail ?? '').slice(0, 500), Math.floor(Date.now() / 1000)).run();
  } catch { /* diagnostics must never break the flow */ }
}

export interface ChannelOption {
  id: number;
  name: string;
}

/** Custom channels the learner can see. Docebo enforces upload permission when the asset is assigned. */
export async function contributableChannels(env: Env, s: Session): Promise<ChannelOption[]> {
  if (!live(env, s)) return [];
  const j = await doceboCall(env, s.access_token, 'GET', '/learn/v1/channels?page_size=100');
  return itemsOf(j)
    .filter((c) => !c.predefined_uid)
    .map((c) => ({ id: Number(c.id), name: String(c.name ?? `Channel ${c.id}`) }))
    .filter((c) => Number.isFinite(c.id) && c.id > 0);
}

export async function linkMeta(env: Env, s: Session, url: string): Promise<{ title?: string; description?: string; image?: string }> {
  if (!live(env, s)) return {};
  const d = dataOf(await doceboCall(env, s.access_token, 'GET', `/share/v1/link/meta?url=${encodeURIComponent(url)}`));
  const img = typeof d.image === 'string' && d.image ? (d.image.startsWith('//') ? `https:${d.image}` : d.image) : undefined;
  return { title: d.title ? String(d.title) : undefined, description: d.description ? String(d.description) : undefined, image: img };
}

const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|wistia\.(com|net))$/i;

/** Publish a link: YouTube/Vimeo/Wistia become video links (playable in Docebo), anything else a web link. */
export async function contributeLink(env: Env, s: Session, a: { url: string; title: string; description: string; thumbnail?: string; channels: number[] }): Promise<{ id?: number; published: boolean }> {
  if (!live(env, s)) throw new DoceboError(400, 'Contributing needs live mode');
  const host = new URL(a.url).hostname;
  const path = VIDEO_HOSTS.test(host) ? '/share/v1/videolink' : '/share/v1/link';
  const j = await doceboCall(env, s.access_token, 'POST', path, {
    url: a.url,
    title: a.title,
    description: a.description,
    ...(a.thumbnail ? { thumbnail_url: a.thumbnail } : {}),
    channels: a.channels,
  });
  const item = (dataOf(j).item ?? {}) as Json;
  const id = Number(item.id ?? item.id_asset);
  await logStep(env, s.user_id, 'link-create', Number.isFinite(id), 200, `id=${id}`);
  if (!Number.isFinite(id) || id <= 0) return { published: false };
  const pub = await publishAsset(env, s, id);
  return { id, published: pub.published };
}

/** Docebo asset content types (POST /share/v1/assets). */
export function contentTypeFor(mime: string, filename: string): number {
  const m = mime.toLowerCase();
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (m.startsWith('video/')) return 1;
  if (m.startsWith('image/')) return 7;
  if (m.startsWith('audio/')) return 12;
  if (m === 'application/pdf' || ext === 'pdf') return 5;
  if (/presentation|powerpoint/.test(m) || ['ppt', 'pptx', 'key', 'odp'].includes(ext)) return 4;
  if (/spreadsheet|excel/.test(m) || ['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return 3;
  if (/word|opendocument\.text|rtf/.test(m) || ['doc', 'docx', 'odt', 'rtf'].includes(ext)) return 2;
  if (m === 'text/plain' || ext === 'txt') return 6;
  if (/zip|compressed|x-7z|x-rar|tar/.test(m)) return 13;
  return 10;
}

/**
 * Store an uploaded file in Docebo's asset storage. Docebo hands out a presigned S3 URL
 * (GET /manage/v1/upload/presigned_url, collection "app7020", the Coach & Share store)
 * and the Worker streams the browser's upload to it, avoiding S3 CORS on a foreign origin.
 */
export async function uploadToDocebo(env: Env, s: Session, filename: string, mime: string, body: ReadableStream | null, length: string | null): Promise<string> {
  if (!live(env, s)) throw new DoceboError(400, 'Uploading needs live mode');
  if (!body) throw new DoceboError(400, 'No file received');
  const q = new URLSearchParams({ filename, mime, collection: 'app7020' });
  let d: Json;
  try {
    d = dataOf(await doceboCall(env, s.access_token, 'GET', `/manage/v1/upload/presigned_url?${q}`));
    await logStep(env, s.user_id, 'presign', true, 200, `mime=${mime}`);
  } catch (e) {
    await logStep(env, s.user_id, 'presign', false, (e as DoceboError).status, (e as Error).message);
    throw e;
  }
  const url = String(d.url ?? '');
  const stored = String(d.fileName ?? d.filename_hashed ?? '');
  if (!url || !stored) throw new DoceboError(502, 'Docebo did not return an upload URL');
  // S3 presigned PUTs need a known Content-Length (no chunked uploads), so stream through a
  // FixedLengthStream when the size is known, otherwise buffer the file.
  const len = Number(length);
  let payload: BodyInit;
  if (Number.isFinite(len) && len > 0) {
    const { readable, writable } = new FixedLengthStream(len);
    body.pipeTo(writable).catch(() => {});
    payload = readable;
  } else {
    payload = await new Response(body).arrayBuffer();
  }
  const res = await fetch(url.startsWith('//') ? `https:${url}` : url, {
    method: 'PUT',
    headers: { 'Content-Type': String(d.content_type ?? mime) },
    body: payload,
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ');
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
    const msg = /<Message>([^<]+)<\/Message>/.exec(text)?.[1];
    await logStep(env, s.user_id, 's3-put', false, res.status, `${code ?? ''} ${msg ?? text.slice(0, 200)} len=${length}`);
    throw new DoceboError(502, `Upload to Docebo storage failed (${res.status}${code ? ` ${code}` : ''})`);
  }
  await logStep(env, s.user_id, 's3-put', true, res.status, `len=${length}`);
  return stored;
}

/**
 * Docebo creates contributed assets as drafts; its own upload flow ends with "Publish"
 * (PUT /share/v1/publish/{id}). Channels that need expert review then hold it for approval.
 */
export async function publishAsset(env: Env, s: Session & { access_token: string }, id: number): Promise<{ published: boolean; rights: boolean }> {
  try {
    const d = dataOf(await doceboCall(env, s.access_token, 'PUT', `/share/v1/publish/${id}`));
    const r = { published: d.published === true || d.published === 1, rights: d.publishing_rights !== false };
    await logStep(env, s.user_id, 'publish', true, 200, JSON.stringify(r));
    return r;
  } catch (e) {
    await logStep(env, s.user_id, 'publish', false, (e as DoceboError).status, (e as Error).message);
    return { published: false, rights: false };
  }
}

/** Create the asset for an uploaded file, then place it in the chosen channels. */
export async function contributeFile(env: Env, s: Session, a: { storedName: string; originalName: string; mime: string; title: string; description: string; channels: number[] }): Promise<{ id: number; channelErrors?: string; published: boolean }> {
  if (!live(env, s)) throw new DoceboError(400, 'Contributing needs live mode');
  const j = await doceboCall(env, s.access_token, 'POST', '/share/v1/assets', {
    original_file_name: a.originalName,
    file_name: a.storedName,
    content_type: contentTypeFor(a.mime, a.originalName),
    id_source: 1,
    is_private: 0,
    title: a.title,
    description: a.description,
    tags: [],
    skill_codes: [],
  }).catch(async (e) => {
    await logStep(env, s.user_id, 'asset-create', false, (e as DoceboError).status, (e as Error).message);
    throw e;
  });
  const id = Number(dataOf(j).id);
  await logStep(env, s.user_id, 'asset-create', Number.isFinite(id) && id > 0, 200, `id=${id} body=${JSON.stringify(j).slice(0, 200)}`);
  if (!Number.isFinite(id) || id <= 0) throw new DoceboError(502, 'Docebo did not return the new asset');
  let channelErrors: string | undefined;
  if (a.channels.length) {
    try {
      const r = dataOf(await doceboCall(env, s.access_token, 'PUT', `/share/v1/assets/${id}/channels`, { channels: a.channels }));
      const errs = r.errors;
      if (errs && (Array.isArray(errs) ? errs.length : Object.keys(errs as Json).length)) channelErrors = JSON.stringify(errs).slice(0, 200);
      await logStep(env, s.user_id, 'channels', !channelErrors, 200, `${a.channels.join(',')} ${channelErrors ?? JSON.stringify(r).slice(0, 150)}`);
    } catch (e) {
      channelErrors = (e as Error).message;
      await logStep(env, s.user_id, 'channels', false, (e as DoceboError).status, channelErrors);
    }
  }
  const pub = await publishAsset(env, s, id);
  return { id, channelErrors, published: pub.published };
}

// ---------- My posts (the learner's own contributions) ----------

export interface MyPostStatus {
  label: string;                       // shown on the card badge
  tone: 'live' | 'wait' | 'bad' | 'draft';
  canDelete: boolean;
}

/**
 * The learner's contributions from Docebo's My Channel (GET /share/v1/user/myassets, including hidden
 * and still-converting items), each with a status that accounts for per-channel review: an asset can
 * be published yet still "waiting" for peer review in a channel (channels[].peer_review on the detail).
 */
export async function myContributions(env: Env, s: Session): Promise<Array<{ row: Json; status: MyPostStatus; channels: string[] }>> {
  if (!live(env, s)) return [];
  const j = await doceboCall(env, s.access_token, 'GET',
    '/share/v1/user/myassets?page_size=50&sort_attr=date&sort_dir=desc&with_visibility=both&show_loading=true');
  const rows = itemsOf(j)
    // My Channel can list items the learner was invited to; keep the learner's own.
    .filter((r) => !r.owner || String((r.owner as Json).id ?? '') === String(s.user_id) || !(r.inviter))
    .slice(0, 30); // each needs a detail call; stay well inside the Workers subrequest budget
  return Promise.all(rows.map(async (row) => {
    const of = (row.other_fields ?? {}) as Json;
    const actions = Array.isArray(row.actions) ? (row.actions as Json[]).map((a) => String(a.type)) : [];
    const canDelete = actions.includes('DeleteAsset');
    let channels: Json[] = [];
    let conversion: unknown;
    try {
      const d = dataOf(await doceboCall(env, s.access_token, 'GET', `/share/v1/assets/${encodeURIComponent(String(row.id))}`));
      channels = Array.isArray(d.channels) ? (d.channels as Json[]) : [];
      conversion = d.conversion_status;
    } catch { /* fall back to My Channel's own status */ }
    const names = channels.map((c) => String(c.name ?? `Channel ${c.channel_id}`));
    const statusKey = String(of.status ?? '').toLowerCase();
    const waiting = channels.filter((c) => String(c.peer_review ?? '').toLowerCase() === 'waiting').map((c) => String(c.name));
    const rejected = channels.filter((c) => String(c.peer_review ?? '').toLowerCase() === 'rejected').map((c) => String(c.name));
    let status: MyPostStatus;
    if (statusKey && statusKey !== 'published') {
      const label = String(of.status_label ?? statusKey);
      status = { label, tone: /review|wait|pending/i.test(label) ? 'wait' : /reject/i.test(label) ? 'bad' : /convert|process|upload/i.test(label) ? 'wait' : 'draft', canDelete };
    } else if (Number(conversion) > 0 && Number(conversion) < 20) {
      status = { label: 'Processing', tone: 'wait', canDelete };
    } else if (rejected.length && !waiting.length && rejected.length === channels.length) {
      status = { label: `Rejected in ${rejected.join(', ')}`, tone: 'bad', canDelete };
    } else if (waiting.length) {
      status = { label: `Waiting for review in ${waiting.join(', ')}`, tone: 'wait', canDelete };
    } else if (!channels.length) {
      status = { label: 'Published to your channel only', tone: 'live', canDelete };
    } else {
      status = { label: 'Published', tone: 'live', canDelete };
    }
    return { row, status, channels: names };
  }));
}

export async function deleteMyAsset(env: Env, s: Session, id: string): Promise<void> {
  if (!live(env, s)) throw new DoceboError(400, 'Deleting needs live mode');
  await doceboCall(env, s.access_token, 'DELETE', `/share/v1/assets/${encodeURIComponent(id)}`);
}

// ---------- Course / learning plan details for cards that open in Docebo ----------

export interface LearnDetails {
  description?: string;
  facts: string[];            // short facts shown as a line under the title
  status?: string;            // learner's status label
  progress?: number;          // 0-100 for learning plans
  courses?: string[];         // course names inside a learning plan
  courseCount?: number;
  thumbnailUrl?: string;
}

/** Plain text from Docebo's HTML descriptions. */
export function htmlToText(html: unknown): string {
  return String(html ?? '')
    .replace(/<\s*(br|\/p|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

const COURSE_TYPES: Record<string, string> = { elearning: 'E-learning', classroom: 'Classroom', webinar: 'Webinar' };
const STATUS_LABELS: Record<string, string> = {
  subscribed: 'Enrolled', enrolled: 'Enrolled', not_started: 'Not started', in_progress: 'In progress', 'in progress': 'In progress',
  completed: 'Completed', waiting: 'Waiting list', suspended: 'Suspended', overbooking: 'Overbooking',
};

function minutes(v: unknown): string | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 60 ? `${Math.round(n)} min` : `${Math.floor(n / 60)} h${n % 60 ? ` ${Math.round(n % 60)} min` : ''}`;
}

export async function learnDetails(env: Env, s: Session, kind: string, id: string): Promise<LearnDetails> {
  if (!live(env, s)) return { facts: [] };
  if (kind === 'course') {
    const d = dataOf(await doceboCall(env, s.access_token, 'GET', `/learn/v1/courses/${encodeURIComponent(id)}`));
    const los = Array.isArray(d.flat_los) ? (d.flat_los as Json[]) : [];
    const lessons = los.reduce((n, l) => n + (Number(l.items_count) || 0), 0) || (Array.isArray(d.tree) ? (d.tree as Json[]).filter((x) => !x.is_folder).length : 0);
    const credits = Number(d.credits);
    const category = (d.category as Json)?.name;
    const facts = [
      COURSE_TYPES[String(d.type)] ?? (d.type ? String(d.type) : undefined),
      lessons ? `${lessons} lesson${lessons === 1 ? '' : 's'}` : undefined,
      minutes(d.duration),
      d.lang_label ? String(d.lang_label) : undefined,
      credits > 0 ? `${credits} credit${credits === 1 ? '' : 's'}` : undefined,
      category ? String(category) : undefined,
    ].filter(Boolean) as string[];
    const st = String(d.status ?? '').toLowerCase();
    const bg = (d.background_image as Json)?.url;
    return {
      description: htmlToText(d.description) || htmlToText(d.short_description) || undefined,
      facts,
      status: STATUS_LABELS[st] ?? (st ? st.replace(/_/g, ' ') : undefined),
      thumbnailUrl: typeof bg === 'string' && bg ? (bg.startsWith('//') ? `https:${bg}` : bg) : undefined,
    };
  }
  if (kind === 'learning_plan') {
    const d = dataOf(await doceboCall(env, s.access_token, 'GET', `/learn/v1/lp/${encodeURIComponent(id)}`));
    const courses = Array.isArray(d.courses) ? (d.courses as Json[]) : [];
    const credits = Number(d.credits);
    const pct = Number(d.complete_percent);
    const st = String(d.status ?? '').toLowerCase();
    const facts = [
      courses.length ? `${courses.length} course${courses.length === 1 ? '' : 's'}` : undefined,
      minutes(d.total_duration),
      d.is_certification ? 'Certification' : undefined,
      credits > 0 ? `${credits} credit${credits === 1 ? '' : 's'}` : undefined,
    ].filter(Boolean) as string[];
    return {
      description: htmlToText(d.description) || htmlToText(d.short_description) || undefined,
      facts,
      status: STATUS_LABELS[st] ?? (st ? st.replace(/_/g, ' ') : undefined),
      progress: Number.isFinite(pct) && d.is_assigned !== false ? Math.max(0, Math.min(100, pct)) : undefined,
      courses: courses.map((c) => String(c.name ?? '')).filter(Boolean).slice(0, 8),
      courseCount: courses.length,
    };
  }
  return { facts: [] };
}
