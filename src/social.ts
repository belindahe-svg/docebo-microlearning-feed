import type { Env, Session } from './types';

/**
 * Docebo-backed social actions, all called with the LEARNER's own token so Docebo applies its
 * own permissions. Endpoints confirmed from the instance's API spec (/share/v1/swagger,
 * /learn/v1/swagger) on atalentdemo2, 2026-10-15:
 *   Asset comments   GET /share/v1/assets/{id}/comments, POST /share/v1/comments {title, id_asset},
 *                    DELETE /share/v1/comments/{id}
 *   Asset rating     GET/PUT /share/v1/assets/{id}/rating {rating} -> {rating, can_rate}
 *   Course rating    POST /learn/v1/courses/{id}/rating {rating}
 *   Playlists        GET /share/v1/playlists?type_content=asset|my-course,
 *                    POST /share/v1/playlists {id_content, channels, title, is_private, type_content},
 *                    PUT/DELETE /share/v1/playlists/{id}/item {id_asset | id_course}
 *   Invite to watch  GET /share/v1/assets/{id}/invitations/suggestions?invite_watch=true,
 *                    GET /share/v1/assets/{id}/invitations/users?search= (3+ chars),
 *                    POST /share/v1/assets/{id}/invitations {user_ids, invite_watch}
 *   View tracking    PUT /share/v1/assets/{id}/track
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

// ---------- save -> Docebo playlist ----------

export const PLAYLIST_TITLE = 'Saved from Feed';

/** Find (or remember) the learner's private "Saved from Feed" playlist. Returns undefined if none yet. */
async function findPlaylist(env: Env, s: Session & { access_token: string }): Promise<number | undefined> {
  const cached = await env.DB.prepare('SELECT playlist_id FROM user_playlists WHERE user_id = ?').bind(s.user_id).first<{ playlist_id: number }>();
  if (cached) return cached.playlist_id;
  for (const type of ['asset', 'my-course']) {
    const j = await doceboCall(env, s.access_token, 'GET',
      `/share/v1/playlists?type_content=${type}&search_text=${encodeURIComponent(PLAYLIST_TITLE)}&page_size=50`).catch(() => ({} as Json));
    const hit = itemsOf(j).find((p) => String(p.title ?? p.name ?? '') === PLAYLIST_TITLE);
    if (hit?.id) {
      await rememberPlaylist(env, s.user_id, Number(hit.id));
      return Number(hit.id);
    }
  }
  return undefined;
}

async function rememberPlaylist(env: Env, userId: string, id: number) {
  await env.DB.prepare(
    'INSERT INTO user_playlists (user_id, playlist_id, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET playlist_id = excluded.playlist_id',
  ).bind(userId, id, Math.floor(Date.now() / 1000)).run();
}

const itemBody = (kind: string, id: string) => (kind === 'asset' ? { id_asset: Number(id) } : { id_course: Number(id) });

/**
 * Mirror a save into Docebo. Assets and courses only (Docebo playlists hold nothing else).
 * Returns 'synced', 'skipped' (kind not supported / mock mode) or throws DoceboError.
 */
export async function syncSaveToPlaylist(env: Env, s: Session, kind: string, id: string, on: boolean): Promise<'synced' | 'skipped'> {
  if (!live(env, s) || (kind !== 'asset' && kind !== 'course')) return 'skipped';
  let pl = await findPlaylist(env, s);
  if (!on) {
    if (!pl) return 'synced';
    await doceboCall(env, s.access_token, 'DELETE', `/share/v1/playlists/${pl}/item`, itemBody(kind, id)).catch((e) => {
      // Removing something that is not in the playlist is fine; a deleted playlist is forgotten.
      if (e instanceof DoceboError && e.status === 404) return env.DB.prepare('DELETE FROM user_playlists WHERE user_id = ?').bind(s.user_id).run();
      throw e;
    });
    return 'synced';
  }
  if (pl) {
    try {
      await doceboCall(env, s.access_token, 'PUT', `/share/v1/playlists/${pl}/item`, itemBody(kind, id));
      return 'synced';
    } catch (e) {
      if (!(e instanceof DoceboError && e.status === 404)) throw e;
      await env.DB.prepare('DELETE FROM user_playlists WHERE user_id = ?').bind(s.user_id).run();
      pl = undefined; // playlist was deleted in Docebo: recreate below
    }
  }
  // Docebo creates a playlist together with its first item.
  const j = await doceboCall(env, s.access_token, 'POST', '/share/v1/playlists', {
    id_content: Number(id),
    type_content: kind === 'asset' ? 'asset' : 'my-course',
    channels: [],
    title: PLAYLIST_TITLE,
    description: 'Items saved from the micro-learning feed',
    is_private: 1,
  });
  const newId = Number(dataOf(j).id);
  if (Number.isFinite(newId) && newId > 0) await rememberPlaylist(env, s.user_id, newId);
  return 'synced';
}

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
