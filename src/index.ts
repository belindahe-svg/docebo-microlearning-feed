import type { Env, Session } from './types';
import { createSession, exchangeAuthCode, getSession, readIframeParams, timingSafeEqual, verifyIframeHash } from './auth';
import { getAssetMedia, getChannelItems, normalizeItem } from './docebo';
import {
  DoceboError,
  addAssetComment,
  countAssetComments,
  deleteDoceboComment,
  getAssetRating,
  inviteCandidates,
  listAssetComments,
  rateItem,
  sendInvites,
  contributableChannels,
  contributeFile,
  contributeLink,
  createPlaylistWith,
  answerQuestion,
  askQuestion,
  countQuestions,
  deleteMyAsset,
  listAnswers,
  listQuestions,
  isDoceboUploadUrl,
  learnDetails,
  linkMeta,
  logStep,
  myContributions,
  listPlaylistsFor,
  setPlaylistItem,
  trackAssetView,
  uploadToDocebo,
} from './social';
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


function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
const err = (status: number, message: string) => json({ error: message }, status);

/** Accept only absolute https links (contributed links, thumbnails). */
function safeUrl(v: unknown): string | null {
  try {
    const u = new URL(String(v ?? '').trim());
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Pass Docebo's own refusal (e.g. permissions, comments disabled) through to the learner. */
function doceboErr(e: unknown): Response {
  if (e instanceof DoceboError) return err(e.status === 401 ? 401 : e.status >= 500 ? 502 : e.status, e.message);
  return err(502, (e as Error).message);
}

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
  // Channel chips: each channel that contributed at least one item, in Docebo's order.
  const channels: string[] = [];
  for (const i of items) for (const c of i.channels ?? []) if (!channels.includes(c)) channels.push(c);
  return json({
    mode: env.DOCEBO_MODE,
    channels,
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

  // Device and container info (no personal data) to tune behaviour on the web vs Go.Learn.
  if (path === '/api/client-info' && req.method === 'POST') {
    const b = await readJson<Record<string, unknown>>(req);
    await logStep(env, s.user_id, 'client', true, undefined, JSON.stringify(b ?? {}).slice(0, 480));
    return json({ ok: true });
  }

  if (path === '/api/discover' && req.method === 'GET') {
    if (!isDiscoveryUser(env, s.user_id, s.username)) return err(403, 'Discovery is not enabled for this user');
    if (!s.access_token) return err(400, 'Discovery needs live mode (a real Docebo session)');
    return json({ domain: env.DOCEBO_DOMAIN, channelId: env.DOCEBO_CHANNEL_ID || null, results: await runDiscovery(env, s.access_token) });
  }

  const assetMedia = /^\/api\/assets\/(\d+)\/media$/.exec(path);
  if (assetMedia && req.method === 'GET') {
    try {
      const id = assetMedia[1];
      const [media, rating, comments, questions] = await Promise.all([
        getAssetMedia(env, s.access_token, id),
        s.access_token && env.DOCEBO_MODE === 'live' ? getAssetRating(env, s.access_token, id) : undefined,
        s.access_token && env.DOCEBO_MODE === 'live' ? countAssetComments(env, s.access_token, id) : undefined,
        s.access_token && env.DOCEBO_MODE === 'live' ? countQuestions(env, s.access_token, 'asset', id) : undefined,
      ]);
      return json({ ...media, myRating: rating?.rating, canRate: rating?.canRate, comments, questions });
    } catch (e) {
      return err(502, (e as Error).message);
    }
  }

  // ---------- My posts: the learner's own contributions with review status ----------
  if (path === '/api/mine' && req.method === 'GET') {
    try {
      const mine = await myContributions(env, s);
      const items = mine
        .map((m) => {
          const it = normalizeItem(m.row as Record<string, unknown>, env.DOCEBO_DOMAIN);
          return it ? { ...it, channels: m.channels, myStatus: m.status } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      const eng = await engagementFor(env, s.user_id, items.map((i) => i.key));
      return json({ items: items.map((i) => ({ ...i, engagement: eng[i.key] })) });
    } catch (e) {
      return doceboErr(e);
    }
  }
  const delMine = /^\/api\/mine\/(\d+)$/.exec(path);
  if (delMine && req.method === 'DELETE') {
    try {
      await deleteMyAsset(env, s, delMine[1]);
      return json({ ok: true });
    } catch (e) {
      return doceboErr(e);
    }
  }

  // ---------- Contribute (Docebo "Share content") ----------
  if (path.startsWith('/api/contribute')) {
    try {
      if (path === '/api/contribute/channels' && req.method === 'GET') return json({ channels: await contributableChannels(env, s) });
      if (path === '/api/contribute/meta' && req.method === 'GET') {
        const u = safeUrl(url.searchParams.get('url'));
        if (!u) return err(400, 'Enter a full https:// link');
        return json(await linkMeta(env, s, u));
      }
      if (path === '/api/contribute/upload' && req.method === 'POST') {
        const filename = (url.searchParams.get('filename') ?? '').replace(/[^\w.\- ]+/g, '_').slice(-120);
        const mime = (url.searchParams.get('mime') ?? 'application/octet-stream').slice(0, 100);
        if (!filename) return err(400, 'Missing file name');
        const len = Number(req.headers.get('Content-Length') ?? 0);
        await logStep(env, s.user_id, 'upload-received', true, undefined, `name=.${filename.split('.').pop()} mime=${mime} len=${req.headers.get('Content-Length')}`);
        if (len > 95 * 1024 * 1024) return err(413, 'Files up to 95 MB can be shared from the feed. Use Docebo for larger files.');
        return json({ storedName: await uploadToDocebo(env, s, filename, mime, req.body, req.headers.get('Content-Length')) });
      }
      if (path === '/api/contribute' && req.method === 'POST') {
        const b = await readJson<{ type?: string; url?: string; storedName?: string; originalName?: string; mime?: string; title?: string; description?: string; thumbnail?: string; channels?: unknown[] }>(req);
        const title = (b?.title ?? '').trim().slice(0, 200);
        const description = (b?.description ?? '').trim().slice(0, 2000);
        const channels = [...new Set((b?.channels ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 20);
        if (!title) return err(400, 'Add a title');
        if (b?.type === 'link') {
          const u = safeUrl(b.url);
          if (!u) return err(400, 'Enter a full https:// link');
          return json(await contributeLink(env, s, { url: u, title, description, thumbnail: safeUrl(b.thumbnail) ?? undefined, channels }), 201);
        }
        if (b?.type === 'file') {
          await logStep(env, s.user_id, 'publish-received', true, undefined, `upload=${!!b.storedName} channels=${channels.join(',')}`);
          if (!isDoceboUploadUrl(b.storedName)) return err(400, 'Upload the file first');
          const originalName = (b.originalName ?? 'file').replace(/[\r\n]/g, ' ').slice(0, 200);
          return json(await contributeFile(env, s, { uploadUrl: b.storedName, originalName, mime: b.mime ?? '', title, description, channels }), 201);
        }
        return err(400, 'Unknown contribution type');
      }
    } catch (e) {
      await logStep(env, s.user_id, `error ${path}`, false, (e as DoceboError).status, (e as Error).message);
      return doceboErr(e);
    }
    return err(404, 'Not found');
  }

  // Docebo Q&A answers
  const qa = /^\/api\/questions\/(\d+)\/answers$/.exec(path);
  if (qa) {
    try {
      if (req.method === 'GET') return json({ answers: await listAnswers(env, s, qa[1]) });
      if (req.method === 'POST') {
        const b = await readJson<{ text?: string }>(req);
        const text = (b?.text ?? '').trim();
        if (!text) return err(400, 'Write an answer first');
        if (text.length > 2000) return err(400, 'Answers are limited to 2000 characters');
        return json({ answer: await answerQuestion(env, s, qa[1], text) }, 201);
      }
    } catch (e) {
      return doceboErr(e);
    }
  }

  const delComment = /^\/api\/comments\/(d?)(\d+)$/.exec(path);
  if (delComment && req.method === 'DELETE') {
    if (delComment[1] === 'd') {
      try {
        await deleteDoceboComment(env, s, delComment[2]);
        return json({ ok: true });
      } catch (e) {
        return doceboErr(e);
      }
    }
    return (await deleteOwnComment(env, Number(delComment[2]), s.user_id)) ? json({ ok: true }) : err(404, 'Comment not found');
  }

  const m = /^\/api\/items\/([^/]+)\/(like|save|comments|progress|rating|invite|playlists|playlists\/new|details|questions)$/.exec(path);
  if (!m) return err(404, 'Not found');
  const key = decodeURIComponent(m[1]);
  if (!ITEM_KEY_RE.test(key)) return err(400, 'Invalid item key');
  const action = m[2];
  const [kind, itemId] = key.split(':') as [string, string];
  const doceboLive = env.DOCEBO_MODE === 'live' && !!s.access_token;

  if (action === 'like' && req.method === 'POST') {
    const b = await readJson<{ on?: boolean }>(req);
    const on = b?.on !== false;
    await setFlag(env, 'likes', key, s.user_id, on);
    return json({ liked: on, likes: await likeCount(env, key) });
  }

  // Saved flag in the app (drives the Saved filter). For assets and courses the feed sets it from
  // Docebo playlist membership; learning plans (not playlist-able in Docebo) toggle it directly.
  if (action === 'save' && req.method === 'POST') {
    const b = await readJson<{ on?: boolean }>(req);
    const on = b?.on !== false;
    await setFlag(env, 'saves', key, s.user_id, on);
    return json({ saved: on });
  }

  // Docebo Q&A for courses and assets.
  if (action === 'questions') {
    if (kind !== 'course' && kind !== 'asset') return err(400, 'Q&A is available for courses and assets');
    try {
      if (req.method === 'GET') return json({ questions: await listQuestions(env, s, kind, itemId) });
      if (req.method === 'POST') {
        const b = await readJson<{ text?: string }>(req);
        const text = (b?.text ?? '').trim();
        if (!text) return err(400, 'Write a question first');
        if (text.length > 1000) return err(400, 'Questions are limited to 1000 characters');
        return json({ question: await askQuestion(env, s, kind, itemId, text) }, 201);
      }
    } catch (e) {
      return doceboErr(e);
    }
  }

  // Course / learning plan details for cards that open in Docebo.
  if (action === 'details' && req.method === 'GET') {
    if (kind !== 'course' && kind !== 'learning_plan') return err(400, 'Details are for courses and learning plans');
    try {
      return json(await learnDetails(env, s, kind, itemId));
    } catch (e) {
      return doceboErr(e);
    }
  }

  // Docebo "Add to playlist": the learner's playlists, toggle membership, or create a new one.
  if (action === 'playlists' || action === 'playlists/new') {
    if (kind !== 'asset' && kind !== 'course') return err(400, 'Docebo playlists hold assets and courses only');
    try {
      if (action === 'playlists' && req.method === 'GET') return json({ playlists: await listPlaylistsFor(env, s, kind, itemId) });
      if (action === 'playlists' && req.method === 'POST') {
        const b = await readJson<{ playlistId?: number; on?: boolean }>(req);
        const pid = Number(b?.playlistId);
        if (!Number.isInteger(pid) || pid <= 0) return err(400, 'Pick a playlist');
        await setPlaylistItem(env, s, kind, itemId, pid, b?.on !== false);
        return json({ ok: true });
      }
      if (action === 'playlists/new' && req.method === 'POST') {
        const b = await readJson<{ title?: string; private?: boolean }>(req);
        const title = (b?.title ?? '').trim().slice(0, 120);
        if (!title) return err(400, 'Name the playlist');
        return json({ id: await createPlaylistWith(env, s, kind, itemId, title, b?.private !== false) }, 201);
      }
    } catch (e) {
      return doceboErr(e);
    }
  }

  // Comments: assets use Docebo's own asset comments; courses and learning plans stay in the app.
  if (action === 'comments' && req.method === 'GET') {
    if (kind === 'asset' && doceboLive) {
      try {
        return json({ comments: await listAssetComments(env, s, itemId), source: 'docebo' });
      } catch (e) {
        return doceboErr(e);
      }
    }
    return json({ comments: (await listComments(env, key, s.user_id)).map((c) => ({ ...c, id: String(c.id) })), source: 'app' });
  }
  if (action === 'comments' && req.method === 'POST') {
    const b = await readJson<{ body?: string }>(req);
    const text = (b?.body ?? '').trim();
    if (!text) return err(400, 'Comment is empty');
    if (text.length > 1000) return err(400, 'Comment is longer than 1000 characters');
    if (kind === 'asset' && doceboLive) {
      try {
        return json({ comment: await addAssetComment(env, s, itemId, text), source: 'docebo' }, 201);
      } catch (e) {
        return doceboErr(e);
      }
    }
    const c = await addComment(env, key, s.user_id, s.username, text);
    return json({ comment: { ...c, id: String(c.id) }, source: 'app' }, 201);
  }

  // Rating (1 to 5 stars) goes straight to Docebo: asset rating or course rating.
  if (action === 'rating' && req.method === 'POST') {
    const b = await readJson<{ rating?: number }>(req);
    const rating = Math.round(Number(b?.rating));
    if (!(rating >= 1 && rating <= 5)) return err(400, 'Rating must be 1 to 5');
    try {
      return json(await rateItem(env, s, kind, itemId, rating));
    } catch (e) {
      return doceboErr(e);
    }
  }

  // Share: Docebo "Invite to watch" (assets only).
  if (action === 'invite') {
    if (kind !== 'asset') return err(400, 'Invite to watch is available for assets only');
    try {
      if (req.method === 'GET') return json({ users: await inviteCandidates(env, s, itemId, (url.searchParams.get('q') ?? '').trim()) });
      if (req.method === 'POST') {
        const b = await readJson<{ userIds?: unknown[] }>(req);
        const ids = [...new Set((b?.userIds ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 50);
        if (!ids.length) return err(400, 'Pick at least one person');
        return json({ invited: await sendInvites(env, s, itemId, ids) });
      }
    } catch (e) {
      return doceboErr(e);
    }
  }

  if (action === 'progress' && req.method === 'POST') {
    const b = await readJson<{ percent?: number }>(req);
    const pct = Math.max(0, Math.min(100, Math.round(Number(b?.percent) || 0)));
    const prev = await recordProgress(env, key, s.user_id, pct);
    // Docebo counts an asset view when it is opened, so record it on the first play.
    let tracked = false;
    if (kind === 'asset' && pct > 0 && prev === 0) {
      tracked = await trackAssetView(env, s.access_token, itemId);
    }
    return json({ percent: Math.max(prev, pct), trackedInDocebo: tracked });
  }

  return err(405, 'Method not allowed');
}
