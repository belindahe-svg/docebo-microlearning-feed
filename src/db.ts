import type { Engagement, Env } from './types';

const now = () => Math.floor(Date.now() / 1000);

export const ITEM_KEY_RE = /^(asset|course|learning_plan):[A-Za-z0-9_-]{1,64}$/;

/** Engagement for many items in three queries, regardless of feed length. */
export async function engagementFor(env: Env, userId: string, keys: string[]): Promise<Record<string, Engagement>> {
  const out: Record<string, Engagement> = {};
  for (const k of keys) out[k] = { likes: 0, liked: false, saved: false, comments: 0 };
  if (!keys.length) return out;
  const ph = keys.map(() => '?').join(',');
  const [likes, saves, comments] = await env.DB.batch([
    env.DB.prepare(
      `SELECT item_key, COUNT(*) AS n, SUM(user_id = ?) AS mine FROM likes WHERE item_key IN (${ph}) GROUP BY item_key`,
    ).bind(userId, ...keys),
    env.DB.prepare(`SELECT item_key FROM saves WHERE user_id = ? AND item_key IN (${ph})`).bind(userId, ...keys),
    env.DB.prepare(
      `SELECT item_key, COUNT(*) AS n FROM comments WHERE deleted = 0 AND item_key IN (${ph}) GROUP BY item_key`,
    ).bind(...keys),
  ]);
  for (const r of likes.results as Array<{ item_key: string; n: number; mine: number }>) {
    out[r.item_key].likes = r.n;
    out[r.item_key].liked = r.mine > 0;
  }
  for (const r of saves.results as Array<{ item_key: string }>) out[r.item_key].saved = true;
  for (const r of comments.results as Array<{ item_key: string; n: number }>) out[r.item_key].comments = r.n;
  return out;
}

export async function setFlag(env: Env, table: 'likes' | 'saves', key: string, userId: string, on: boolean) {
  if (on) {
    await env.DB.prepare(`INSERT OR IGNORE INTO ${table} (item_key, user_id, created_at) VALUES (?, ?, ?)`)
      .bind(key, userId, now())
      .run();
  } else {
    await env.DB.prepare(`DELETE FROM ${table} WHERE item_key = ? AND user_id = ?`).bind(key, userId).run();
  }
}

export async function likeCount(env: Env, key: string): Promise<number> {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM likes WHERE item_key = ?').bind(key).first<{ n: number }>();
  return r?.n ?? 0;
}

export async function listComments(env: Env, key: string, userId: string) {
  const r = await env.DB.prepare(
    'SELECT id, username, body, created_at, user_id FROM comments WHERE item_key = ? AND deleted = 0 ORDER BY created_at ASC LIMIT 200',
  )
    .bind(key)
    .all<{ id: number; username: string; body: string; created_at: number; user_id: string }>();
  return r.results.map((c) => ({
    id: c.id,
    username: c.username,
    body: c.body,
    createdAt: c.created_at,
    mine: c.user_id === userId,
  }));
}

export async function addComment(env: Env, key: string, userId: string, username: string, body: string) {
  const r = await env.DB.prepare(
    'INSERT INTO comments (item_key, user_id, username, body, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id, created_at',
  )
    .bind(key, userId, username, body, now())
    .first<{ id: number; created_at: number }>();
  return { id: r!.id, username, body, createdAt: r!.created_at, mine: true };
}

export async function deleteOwnComment(env: Env, id: number, userId: string): Promise<boolean> {
  const r = await env.DB.prepare('UPDATE comments SET deleted = 1 WHERE id = ? AND user_id = ?').bind(id, userId).run();
  return (r.meta.changes ?? 0) > 0;
}

/** Store the highest percent watched. Returns the previous value. */
export async function recordProgress(env: Env, key: string, userId: string, percent: number): Promise<number> {
  const prev = await env.DB.prepare('SELECT max_percent FROM views WHERE item_key = ? AND user_id = ?')
    .bind(key, userId)
    .first<{ max_percent: number }>();
  await env.DB.prepare(
    `INSERT INTO views (item_key, user_id, max_percent, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(item_key, user_id) DO UPDATE SET max_percent = MAX(max_percent, excluded.max_percent), updated_at = excluded.updated_at`,
  )
    .bind(key, userId, percent, now())
    .run();
  return prev?.max_percent ?? 0;
}

export async function mediaOverrides(env: Env, keys: string[]) {
  const out: Record<string, { video_url: string; poster_url: string | null }> = {};
  if (!keys.length) return out;
  const ph = keys.map(() => '?').join(',');
  const r = await env.DB.prepare(`SELECT item_key, video_url, poster_url FROM media_overrides WHERE item_key IN (${ph})`)
    .bind(...keys)
    .all<{ item_key: string; video_url: string; poster_url: string | null }>();
  for (const m of r.results) out[m.item_key] = m;
  return out;
}

export async function setMediaOverride(env: Env, key: string, videoUrl: string, posterUrl: string | null) {
  await env.DB.prepare(
    `INSERT INTO media_overrides (item_key, video_url, poster_url, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(item_key) DO UPDATE SET video_url = excluded.video_url, poster_url = excluded.poster_url, updated_at = excluded.updated_at`,
  )
    .bind(key, videoUrl, posterUrl, now())
    .run();
}
