import type { Env, Session } from './types';

/**
 * Docebo iFrame widget (Advanced Settings on) passes the embedded page an OAuth2
 * authorization code (`auth_code`, valid 30 seconds) and a `hash` for verification.
 * Per Docebo's help centre, hash = SHA-256 of "user_id,username,auth_code,salt_secret".
 * Parameter names for user ID and username are confirmed on first real load (see README).
 */
export interface IframeParams {
  userId: string;
  username: string;
  authCode: string;
  hash: string;
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function expectedHash(p: Omit<IframeParams, 'hash'>, salt: string): Promise<string> {
  return sha256Hex([p.userId, p.username, p.authCode, salt].join(','));
}

export async function verifyIframeHash(p: IframeParams, salt: string): Promise<boolean> {
  if (!salt || !p.hash || !p.authCode) return false;
  const exp = await expectedHash(p, salt);
  return timingSafeEqual(exp, p.hash.toLowerCase());
}

/** Accept the common spellings until the real parameter names are confirmed. */
export function readIframeParams(q: Record<string, string | undefined>): IframeParams {
  return {
    userId: q.user_id ?? q.userid ?? q.id_user ?? '',
    username: q.username ?? q.user_name ?? '',
    authCode: q.auth_code ?? q.code ?? '',
    hash: q.hash ?? '',
  };
}

export interface TokenResponse {
  access_token: string;
  expires_in?: number;
}

/** Exchange the 30-second auth code for the learner's Docebo access token. */
export async function exchangeAuthCode(env: Env, code: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: env.DOCEBO_OAUTH_CLIENT_ID,
    client_secret: env.DOCEBO_OAUTH_CLIENT_SECRET,
  });
  if (env.DOCEBO_OAUTH_REDIRECT_URI) body.set('redirect_uri', env.DOCEBO_OAUTH_REDIRECT_URI);
  const res = await fetch(`https://${env.DOCEBO_DOMAIN}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Docebo token exchange failed (${res.status})`);
  const json = (await res.json()) as TokenResponse;
  if (!json.access_token) throw new Error('Docebo token exchange returned no access_token');
  return json;
}

function randomId(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function createSession(
  env: Env,
  userId: string,
  username: string,
  accessToken: string | null,
  ttlSeconds: number,
): Promise<Session> {
  const s: Session = {
    id: randomId(),
    user_id: userId,
    username,
    access_token: accessToken,
    expires_at: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, username, access_token, expires_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(s.id, s.user_id, s.username, s.access_token, s.expires_at)
    .run();
  // Opportunistic cleanup of expired sessions.
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Math.floor(Date.now() / 1000)).run();
  return s;
}

export async function getSession(env: Env, req: Request): Promise<Session | null> {
  const h = req.headers.get('Authorization') ?? '';
  const m = /^Bearer ([a-f0-9]{64})$/.exec(h);
  if (!m) return null;
  const row = await env.DB.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?')
    .bind(m[1], Math.floor(Date.now() / 1000))
    .first<Session>();
  return row ?? null;
}
