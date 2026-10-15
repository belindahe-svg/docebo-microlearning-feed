import type { Env, Session } from './types';
import { createSession, exchangeAuthCode, getSession, readIframeParams, timingSafeEqual, verifyIframeHash } from './auth';
import { getAssetMedia, getChannelItems, recordAssetView } from './docebo';
import { isDiscoveryUser, runDiscovery } from './discover';
import {
  ITEM_KEY_RE,
  addComment,
  deleteOwnComment,
  engagementFor,
  likeCount,
  listComments,
  mediaOverrides,
  recordProgress,
  setFlag,
  setMediaOverride,
} from './db';

const COMPLETE_AT = 90; // percent watched that counts as a completed view

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
const err = (status: number, message: string) => json({ error: message }, status);

/** Allow framing only by the configured Docebo origins. */
function withFrameHeaders(res: Response, env: Env): Response {
  const r = new Response(res.body, res);
  const ancestors = env.ALLOWED_FRAME_ANCESTORS.split(',').map((s) => s.trim()).filter(Boolean).join(' ');
  r.headers.set('Content-Security-Policy', `frame-ancestors ${ancestors || "'none'"}`);
  r.headers.delete('X-Frame-Options');
  r.headers.set('Referrer-Policy', 'no-referrer');
  r.headers.set('X-Content-Type-Options', 'nosniff');
  return r;
}

async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

async function handleSession(req: Request, env: Env): Promise<Response> {
  const body = (await readJson<Record<string, string>>(req)) ?? {};
  const p = readIframeParams(body);
  const ttl = Number(env.SESSION_TTL_SECONDS) || 3600;

  if (env.DOCEBO_MODE !== 'live') {
    // Mock mode: verify the hash when one is supplied (to test the handshake); otherwise open a demo session.
    if (p.hash) {
      if (!(await verifyIframeHash(p, env.DOCEBO_SALT_SECRET))) return err(401, 'Signature check failed');
      const s = await createSession(env, p.userId, p.username, null, ttl);
      return json({ token: s.id, user: { id: s.user_id, username: s.username }, mode: 'mock' });
    }
    const s = await createSession(env, 'demo', 'Demo learner', null, ttl);
    return json({ token: s.id, user: { id: s.user_id, username: s.username }, mode: 'mock' });
  }

  if (!p.userId || !p.authCode || !p.hash) {
    // Report which names arrived (never values) so the parameter mapping can be confirmed.
    return err(400, `Missing Docebo iframe parameters. Received: ${Object.keys(body).join(', ') || 'none'}`);
  }
  if (!(await verifyIframeHash(p, env.DOCEBO_SALT_SECRET))) return err(401, 'Signature check failed');
  let token;
  try {
    token = await exchangeAuthCode(env, p.authCode);
  } catch (e) {
    return err(502, (e as Error).message);
  }
  const s = await createSession(env, p.userId, p.username, token.access_token, Math.min(ttl, token.expires_in ?? ttl));
  return json({
    token: s.id,
    user: { id: s.user_id, username: s.username },
    mode: 'live',
    discovery: isDiscoveryUser(env, s.user_id, s.username),
    receivedParams: Object.keys(body),
  });
}

async function handleFeed(env: Env, s: Session): Promise<Response> {
  let items;
  try {
    items = await getChannelItems(env, s.access_token);
  } catch (e) {
    return err(502, (e as Error).message);
  }
  const keys = items.map((i) => i.key);
  const [eng, media] = await Promise.all([engagementFor(env, s.user_id, keys), mediaOverrides(env, keys)]);
  return json({
    mode: env.DOCEBO_MODE,
    items: items.map((i) => ({
      ...i,
      videoUrl: media[i.key]?.video_url ?? i.videoUrl,
      thumbnailUrl: media[i.key]?.poster_url ?? i.thumbnailUrl,
      engagement: eng[i.key],
    })),
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return withFrameHeaders(await route(req, env), env);
  },
};

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);

  if (path === '/api/health') return json({ ok: true, mode: env.DOCEBO_MODE });
  if (path === '/api/session' && req.method === 'POST') return handleSession(req, env);

  // Admin: attach a CDN copy of a video to a Docebo item.
  const adminMedia = /^\/api\/admin\/media\/([^/]+)$/.exec(path);
  if (adminMedia && req.method === 'PUT') {
    const auth = req.headers.get('Authorization') ?? '';
    if (!env.ADMIN_TOKEN || !timingSafeEqual(auth, `Bearer ${env.ADMIN_TOKEN}`)) return err(401, 'Admin token required');
    const key = decodeURIComponent(adminMedia[1]);
    if (!ITEM_KEY_RE.test(key)) return err(400, 'Invalid item key');
    const b = await readJson<{ video_url?: string; poster_url?: string }>(req);
    if (!b?.video_url || !/^https:\/\//.test(b.video_url)) return err(400, 'video_url must be an https URL');
    await setMediaOverride(env, key, b.video_url, b.poster_url ?? null);
    return json({ ok: true });
  }

  const s = await getSession(env, req);
  if (!s) return err(401, 'Session expired. Reload the page in Docebo.');

  if (path === '/api/feed' && req.method === 'GET') return handleFeed(env, s);

  if (path === '/api/discover' && req.method === 'GET') {
    if (!isDiscoveryUser(env, s.user_id, s.username)) return err(403, 'Discovery is not enabled for this user');
    if (!s.access_token) return err(400, 'Discovery needs live mode (a real Docebo session)');
    return json({ domain: env.DOCEBO_DOMAIN, channelId: env.DOCEBO_CHANNEL_ID || null, results: await runDiscovery(env, s.access_token) });
  }

  const assetMedia = /^\/api\/assets\/(\d+)\/media$/.exec(path);
  if (assetMedia && req.method === 'GET') {
    try {
      return json(await getAssetMedia(env, s.access_token, assetMedia[1]));
    } catch (e) {
      return err(502, (e as Error).message);
    }
  }

  const delComment = /^\/api\/comments\/(\d+)$/.exec(path);
  if (delComment && req.method === 'DELETE') {
    return (await deleteOwnComment(env, Number(delComment[1]), s.user_id)) ? json({ ok: true }) : err(404, 'Comment not found');
  }

  const m = /^\/api\/items\/([^/]+)\/(like|save|comments|progress)$/.exec(path);
  if (!m) return err(404, 'Not found');
  const key = decodeURIComponent(m[1]);
  if (!ITEM_KEY_RE.test(key)) return err(400, 'Invalid item key');
  const action = m[2];

  if ((action === 'like' || action === 'save') && req.method === 'POST') {
    const b = await readJson<{ on?: boolean }>(req);
    const on = b?.on !== false;
    await setFlag(env, action === 'like' ? 'likes' : 'saves', key, s.user_id, on);
    return json(action === 'like' ? { liked: on, likes: await likeCount(env, key) } : { saved: on });
  }

  if (action === 'comments' && req.method === 'GET') return json({ comments: await listComments(env, key, s.user_id) });
  if (action === 'comments' && req.method === 'POST') {
    const b = await readJson<{ body?: string }>(req);
    const text = (b?.body ?? '').trim();
    if (!text) return err(400, 'Comment is empty');
    if (text.length > 1000) return err(400, 'Comment is longer than 1000 characters');
    return json({ comment: await addComment(env, key, s.user_id, s.username, text) }, 201);
  }

  if (action === 'progress' && req.method === 'POST') {
    const b = await readJson<{ percent?: number }>(req);
    const pct = Math.max(0, Math.min(100, Math.round(Number(b?.percent) || 0)));
    const prev = await recordProgress(env, key, s.user_id, pct);
    let tracked = false;
    if (key.startsWith('asset:') && pct >= COMPLETE_AT && prev < COMPLETE_AT) {
      tracked = await recordAssetView(env, s.access_token, key.slice('asset:'.length));
    }
    return json({ percent: Math.max(prev, pct), trackedInDocebo: tracked });
  }

  return err(405, 'Method not allowed');
}
