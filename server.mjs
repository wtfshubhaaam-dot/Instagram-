// GlassPost: a single-file Node server (no framework).
// Serves the static pages, the JSON API, the Instagram OAuth flow and the post scheduler.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PROD = process.env.NODE_ENV === 'production';

/* ------------------------------------------------------------------ config */

const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};
const appUrl = () => env('APP_URL').replace(/\/+$/, '');
const GRAPH = () => `https://graph.instagram.com/${process.env.INSTAGRAM_GRAPH_VERSION || 'v26.0'}`;
const redirectUri = () => `${appUrl()}/api/auth/instagram/callback`;

/* ------------------------------------------------------------------ crypto */

const encKey = () => {
  const key = Buffer.from(env('ENCRYPTION_KEY'), 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes.');
  return key;
};
const hmac = (value, secret) => createHmac('sha256', secret).update(value).digest('base64url');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
function encrypt(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}
function decrypt(payload) {
  const raw = Buffer.from(payload, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', encKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

/* ---------------------------------------------------------------- database */

let pool;
let schemaReady;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ig_user_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  account_type TEXT,
  profile_picture_url TEXT,
  token_enc TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  caption TEXT NOT NULL DEFAULT '',
  media_type TEXT NOT NULL CHECK (media_type IN ('IMAGE','REELS')),
  media_url TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','processing','published','failed')),
  creation_id TEXT,
  ig_media_id TEXT,
  permalink TEXT,
  attempts INT NOT NULL DEFAULT 0,
  error TEXT,
  locked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS posts_due_idx ON posts (status, scheduled_at);
CREATE INDEX IF NOT EXISTS posts_account_idx ON posts (account_id, scheduled_at DESC);
CREATE TABLE IF NOT EXISTS deletion_requests (
  code TEXT PRIMARY KEY,
  ig_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

async function query(text, params = []) {
  pool ??= new pg.Pool({ connectionString: env('DATABASE_URL'), max: 4, idleTimeoutMillis: 20_000, connectionTimeoutMillis: 10_000 });
  schemaReady ??= pool.query(SCHEMA).catch((error) => {
    schemaReady = undefined;
    throw error;
  });
  await schemaReady;
  return (await pool.query(text, params)).rows;
}

/* ----------------------------------------------------------------- session */

const COOKIE = 'gp_session';
const SESSION_AGE = 60 * 60 * 24 * 30;

const parseCookies = (header = '') =>
  Object.fromEntries(header.split(';').map((part) => part.trim().split(/=(.*)/s).slice(0, 2)).filter(([k]) => k));

function cookie(name, value, { maxAge, path = '/' } = {}) {
  return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax${PROD ? '; Secure' : ''}${maxAge === undefined ? '' : `; Max-Age=${maxAge}`}`;
}

function sessionCookie(accountId) {
  const payload = Buffer.from(JSON.stringify({ a: accountId, e: Date.now() + SESSION_AGE * 1000 })).toString('base64url');
  return cookie(COOKIE, `${payload}.${hmac(payload, env('SESSION_SECRET'))}`, { maxAge: SESSION_AGE });
}

function getSession(req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (!raw) return null;
  const [payload, signature] = raw.split('.');
  if (!payload || !signature || !safeEqual(signature, hmac(payload, env('SESSION_SECRET')))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.e > Date.now() ? { accountId: data.a } : null;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- instagram */

class InstagramError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
  get transient() {
    return this.status >= 500 || this.status === 429 || [1, 2, 4, 17, 32, 613].includes(this.code);
  }
  get tokenInvalid() {
    return this.code === 190;
  }
}

async function call(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(25_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error || body.error_message) {
    const error = body.error ?? {};
    throw new InstagramError(error.message ?? body.error_message ?? `Instagram API request failed (${response.status})`, response.status, error.code);
  }
  return body;
}

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const formPost = (token, data) => ({
  method: 'POST',
  headers: { ...(token ? bearer(token) : {}), 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(data),
});

const ig = {
  authorizeUrl: (state) =>
    'https://www.instagram.com/oauth/authorize?' +
    new URLSearchParams({
      client_id: env('INSTAGRAM_APP_ID'),
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: 'instagram_business_basic,instagram_business_content_publish',
      state,
    }),

  async exchangeCode(code) {
    const body = await call('https://api.instagram.com/oauth/access_token', formPost(null, {
      client_id: env('INSTAGRAM_APP_ID'),
      client_secret: env('INSTAGRAM_APP_SECRET'),
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(),
      code,
    }));
    return (Array.isArray(body.data) ? body.data[0] : body).access_token;
  },

  async longLived(shortToken) {
    const body = await call('https://graph.instagram.com/access_token?' + new URLSearchParams({
      grant_type: 'ig_exchange_token',
      client_secret: env('INSTAGRAM_APP_SECRET'),
      access_token: shortToken,
    }));
    return { token: body.access_token, expiresAt: new Date(Date.now() + body.expires_in * 1000) };
  },

  async refresh(token) {
    const body = await call('https://graph.instagram.com/refresh_access_token?' + new URLSearchParams({
      grant_type: 'ig_refresh_token',
      access_token: token,
    }));
    return { token: body.access_token, expiresAt: new Date(Date.now() + body.expires_in * 1000) };
  },

  async profile(token) {
    const body = await call(`${GRAPH()}/me?fields=user_id,username,account_type,profile_picture_url`, { headers: bearer(token) });
    return {
      igUserId: String(body.user_id ?? body.id),
      username: String(body.username ?? ''),
      accountType: body.account_type ?? null,
      pictureUrl: body.profile_picture_url ?? null,
    };
  },

  async createContainer(token, igUserId, { mediaType, mediaUrl, caption }) {
    const data = { caption };
    if (mediaType === 'IMAGE') data.image_url = mediaUrl;
    else Object.assign(data, { media_type: 'REELS', video_url: mediaUrl, share_to_feed: 'true' });
    return (await call(`${GRAPH()}/${igUserId}/media`, formPost(token, data))).id;
  },

  async containerStatus(token, id) {
    const body = await call(`${GRAPH()}/${id}?fields=status_code,status`, { headers: bearer(token) });
    return { code: body.status_code, detail: body.status };
  },

  async publish(token, igUserId, creationId) {
    return (await call(`${GRAPH()}/${igUserId}/media_publish`, formPost(token, { creation_id: creationId }))).id;
  },

  async permalink(token, mediaId) {
    try {
      return (await call(`${GRAPH()}/${mediaId}?fields=permalink`, { headers: bearer(token) })).permalink ?? null;
    } catch {
      return null;
    }
  },
};

/* --------------------------------------------------------------- scheduler */

const MAX_ATTEMPTS = 3;
const BATCH = 5;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const claim = () =>
  query(
    `WITH due AS (
       SELECT id FROM posts
       WHERE (status = 'scheduled' AND scheduled_at <= now())
          OR (status = 'processing' AND locked_at < now() - interval '45 seconds')
       ORDER BY scheduled_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED
     )
     UPDATE posts p SET status = 'processing', locked_at = now(), updated_at = now()
     FROM due, accounts a WHERE p.id = due.id AND a.id = p.account_id
     RETURNING p.id, p.caption, p.media_type, p.media_url, p.creation_id, p.attempts, a.ig_user_id, a.token_enc`,
  );

const fail = (id, message) =>
  query(`UPDATE posts SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [id, String(message).slice(0, 500)]);

async function retryLater(post, message) {
  if (post.attempts + 1 >= MAX_ATTEMPTS) return fail(post.id, message);
  await query(
    `UPDATE posts SET status='scheduled', attempts=attempts+1, error=$2, creation_id=NULL,
       scheduled_at = now() + make_interval(mins => $3), updated_at=now() WHERE id=$1`,
    [post.id, String(message).slice(0, 500), (post.attempts + 1) * 2],
  );
}

async function processPost(post) {
  const token = decrypt(post.token_enc);
  try {
    let creationId = post.creation_id;
    if (!creationId) {
      creationId = await ig.createContainer(token, post.ig_user_id, {
        mediaType: post.media_type,
        mediaUrl: post.media_url,
        caption: post.caption,
      });
      await query(`UPDATE posts SET creation_id=$2, updated_at=now() WHERE id=$1`, [post.id, creationId]);
    }
    for (let i = 0; i < 4; i++) {
      const { code, detail } = await ig.containerStatus(token, creationId);
      if (code === 'FINISHED') {
        const mediaId = await ig.publish(token, post.ig_user_id, creationId);
        const link = await ig.permalink(token, mediaId);
        await query(`UPDATE posts SET status='published', ig_media_id=$2, permalink=$3, error=NULL, updated_at=now() WHERE id=$1`, [post.id, mediaId, link]);
        return;
      }
      if (code === 'ERROR' || code === 'EXPIRED') return fail(post.id, `Instagram could not process the media (${detail ?? code}).`);
      await sleep(4000); // Still IN_PROGRESS: the stale lock lets the next tick continue.
    }
  } catch (error) {
    if (error instanceof InstagramError) {
      if (error.tokenInvalid) return fail(post.id, 'Instagram access expired. Reconnect the account.');
      if (error.transient) return retryLater(post, error.message);
      return fail(post.id, error.message);
    }
    return retryLater(post, error?.message ?? 'Unexpected error');
  }
}

async function refreshExpiringTokens() {
  const rows = await query(`SELECT id, token_enc FROM accounts WHERE token_expires_at < now() + interval '10 days' AND token_expires_at > now() LIMIT 5`);
  for (const row of rows) {
    try {
      const next = await ig.refresh(decrypt(row.token_enc));
      await query(`UPDATE accounts SET token_enc=$2, token_expires_at=$3 WHERE id=$1`, [row.id, encrypt(next.token), next.expiresAt]);
    } catch {
      /* Retried on the next tick. */
    }
  }
}

async function tick() {
  const started = Date.now();
  await refreshExpiringTokens();
  const posts = await claim();
  for (const post of posts) {
    if (Date.now() - started > 45_000) break;
    await processPost(post);
  }
  return { claimed: posts.length };
}

/* ----------------------------------------------------------------- storage */

let s3;
const publicBase = () => env('R2_PUBLIC_BASE_URL').replace(/\/+$/, '');
const LIMITS = { 'image/jpeg': 8 * 1048576, 'video/mp4': 300 * 1048576, 'video/quicktime': 300 * 1048576 };

async function presign(accountId, contentType, size) {
  s3 ??= new S3Client({
    region: 'auto',
    endpoint: `https://${env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env('R2_ACCESS_KEY_ID'), secretAccessKey: env('R2_SECRET_ACCESS_KEY') },
  });
  const ext = contentType === 'image/jpeg' ? 'jpg' : contentType === 'video/quicktime' ? 'mov' : 'mp4';
  const key = `${accountId}/${randomUUID()}.${ext}`;
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: env('R2_BUCKET'), Key: key, ContentType: contentType, ContentLength: size }),
    { expiresIn: 600 },
  );
  return { uploadUrl, publicUrl: `${publicBase()}/${key}` };
}

/* -------------------------------------------------------------------- http */

const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: https:; media-src 'self' https:; connect-src 'self' https:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/privacy': ['privacy.html', 'text/html; charset=utf-8'],
  '/terms': ['terms.html', 'text/html; charset=utf-8'],
  '/data-deletion': ['data-deletion.html', 'text/html; charset=utf-8'],
  '/glass.css': ['glass.css', 'text/css; charset=utf-8'],
  '/site.css': ['site.css', 'text/css; charset=utf-8'],
  '/site.js': ['site.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/glassy-scene.js': ['glassy-scene.js', 'text/javascript; charset=utf-8'],
  '/vermilion-light.svg': ['vermilion-light.svg', 'image/svg+xml'],
  '/vermilion-dark.svg': ['vermilion-dark.svg', 'image/svg+xml'],
};

const fileCache = new Map();
async function serveFile(res, name, type, cacheControl) {
  let body = fileCache.get(name);
  if (!body) {
    body = await readFile(join(ROOT, name));
    if (PROD) fileCache.set(name, body);
  }
  res.writeHead(200, { ...HEADERS, 'Content-Type': type, 'Cache-Control': cacheControl });
  res.end(body);
}

function send(res, status, data, extra = {}) {
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(data));
}
const redirect = (res, location, extra = {}) => {
  res.writeHead(302, { ...HEADERS, Location: location, 'Cache-Control': 'no-store', ...extra });
  res.end();
};

async function readBody(req, limit = 65_536) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
const readJson = async (req) => {
  try {
    return JSON.parse((await readBody(req)) || '{}');
  } catch (error) {
    if (error.status) throw error;
    return null;
  }
};

function signedRequest(raw) {
  const [signature, payload] = String(raw ?? '').split('.');
  if (!signature || !payload || !safeEqual(signature, hmac(payload, env('INSTAGRAM_APP_SECRET')))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data?.user_id ? data : null;
  } catch {
    return null;
  }
}

const POST_COLUMNS = 'id, caption, media_type, media_url, scheduled_at, status, permalink, error';

const routes = {
  'GET /api/health': async (_req, res) => send(res, 200, { status: 'ok' }),

  'GET /api/auth/instagram': async (_req, res) => {
    const state = randomBytes(16).toString('base64url');
    redirect(res, ig.authorizeUrl(state), { 'Set-Cookie': cookie('gp_oauth_state', state, { maxAge: 600, path: '/api/auth' }) });
  },

  'GET /api/auth/instagram/callback': async (req, res, url) => {
    const back = (reason) => redirect(res, `${appUrl()}/?error=${encodeURIComponent(reason)}`);
    if (url.searchParams.get('error')) return back('Instagram authorisation was cancelled.');
    const state = url.searchParams.get('state');
    const expected = parseCookies(req.headers.cookie).gp_oauth_state;
    const code = url.searchParams.get('code');
    if (!code || !state || !expected || !safeEqual(state, expected)) return back('The sign-in request could not be verified. Please try again.');
    try {
      const shortToken = await ig.exchangeCode(code.replace(/#_$/, ''));
      const long = await ig.longLived(shortToken);
      const profile = await ig.profile(long.token);
      const [account] = await query(
        `INSERT INTO accounts (ig_user_id, username, account_type, profile_picture_url, token_enc, token_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (ig_user_id) DO UPDATE SET username=EXCLUDED.username, account_type=EXCLUDED.account_type,
           profile_picture_url=EXCLUDED.profile_picture_url, token_enc=EXCLUDED.token_enc, token_expires_at=EXCLUDED.token_expires_at
         RETURNING id`,
        [profile.igUserId, profile.username, profile.accountType, profile.pictureUrl, encrypt(long.token), long.expiresAt],
      );
      res.writeHead(302, {
        ...HEADERS,
        Location: `${appUrl()}/dashboard`,
        'Set-Cookie': [sessionCookie(account.id), cookie('gp_oauth_state', '', { maxAge: 0, path: '/api/auth' })],
      });
      res.end();
    } catch (error) {
      console.error('Instagram sign-in failed', error);
      back('Instagram sign-in failed. Confirm this is a Professional account and try again.');
    }
  },

  'POST /api/auth/logout': async (_req, res) => redirect(res, `${appUrl()}/`, { 'Set-Cookie': cookie(COOKIE, '', { maxAge: 0 }) }),

  'GET /api/me': async (req, res) => {
    const session = getSession(req);
    if (!session) return send(res, 401, { error: 'Unauthorised' });
    const [account] = await query(`SELECT username, profile_picture_url, token_expires_at FROM accounts WHERE id=$1`, [session.accountId]);
    if (!account) return send(res, 401, { error: 'Unauthorised' });
    send(res, 200, { username: account.username, avatar: account.profile_picture_url, tokenExpiresAt: account.token_expires_at });
  },

  'GET /api/posts': async (req, res) => {
    const session = getSession(req);
    if (!session) return send(res, 401, { error: 'Unauthorised' });
    send(res, 200, { posts: await query(`SELECT ${POST_COLUMNS} FROM posts WHERE account_id=$1 ORDER BY scheduled_at DESC LIMIT 100`, [session.accountId]) });
  },

  'POST /api/posts': async (req, res) => {
    const session = getSession(req);
    if (!session) return send(res, 401, { error: 'Unauthorised' });
    const body = await readJson(req);
    if (!body) return send(res, 400, { error: 'Invalid request body.' });
    const caption = String(body.caption ?? '').trim();
    const when = new Date(body.scheduledAt ?? '');
    if (caption.length > 2200) return send(res, 400, { error: 'Captions are limited to 2,200 characters.' });
    if (body.mediaType !== 'IMAGE' && body.mediaType !== 'REELS') return send(res, 400, { error: 'Choose a photo or a Reel.' });
    if (typeof body.mediaUrl !== 'string' || !body.mediaUrl.startsWith(`${publicBase()}/${session.accountId}/`)) return send(res, 400, { error: 'Upload the media before scheduling.' });
    if (Number.isNaN(when.getTime()) || when.getTime() < Date.now() + 60_000 || when.getTime() > Date.now() + 75 * 86_400_000) {
      return send(res, 400, { error: 'Pick a time between 1 minute and 75 days from now.' });
    }
    const [{ count }] = await query(
      `SELECT count(*)::int AS count FROM posts WHERE account_id=$1 AND status IN ('scheduled','processing')
         AND scheduled_at BETWEEN $2::timestamptz - interval '24 hours' AND $2::timestamptz + interval '24 hours'`,
      [session.accountId, when.toISOString()],
    );
    if (count >= 50) return send(res, 400, { error: 'Instagram allows 50 API posts per 24 hours. Choose another time.' });
    const [post] = await query(
      `INSERT INTO posts (account_id, caption, media_type, media_url, scheduled_at) VALUES ($1,$2,$3,$4,$5) RETURNING ${POST_COLUMNS}`,
      [session.accountId, caption, body.mediaType, body.mediaUrl, when.toISOString()],
    );
    send(res, 201, { post });
  },

  'POST /api/uploads/sign': async (req, res) => {
    const session = getSession(req);
    if (!session) return send(res, 401, { error: 'Unauthorised' });
    const { contentType, size } = (await readJson(req)) ?? {};
    const limit = LIMITS[contentType];
    if (!limit) return send(res, 400, { error: 'Instagram accepts JPEG images and MP4 or MOV videos.' });
    if (!Number.isInteger(size) || size <= 0 || size > limit) return send(res, 400, { error: `File is too large (limit ${Math.round(limit / 1048576)} MB).` });
    send(res, 200, await presign(session.accountId, contentType, size));
  },

  'GET /api/cron/tick': cron,
  'POST /api/cron/tick': cron,

  'POST /api/meta/deauthorize': async (req, res) => {
    const data = signedRequest(new URLSearchParams(await readBody(req)).get('signed_request'));
    if (!data) return send(res, 400, { error: 'Invalid signature' });
    await query(`DELETE FROM accounts WHERE ig_user_id=$1`, [String(data.user_id)]);
    send(res, 200, { ok: true });
  },

  'POST /api/meta/data-deletion': async (req, res) => {
    const data = signedRequest(new URLSearchParams(await readBody(req)).get('signed_request'));
    if (!data) return send(res, 400, { error: 'Invalid signature' });
    const code = randomUUID();
    await query(`DELETE FROM accounts WHERE ig_user_id=$1`, [String(data.user_id)]);
    await query(`INSERT INTO deletion_requests (code, ig_user_id) VALUES ($1,$2)`, [code, String(data.user_id)]);
    send(res, 200, { url: `${appUrl()}/data-deletion?code=${code}`, confirmation_code: code });
  },

  'GET /api/deletion-status': async (_req, res, url) => {
    const code = url.searchParams.get('code') ?? '';
    const rows = /^[0-9a-f-]{36}$/.test(code) ? await query(`SELECT 1 FROM deletion_requests WHERE code=$1`, [code]) : [];
    send(res, 200, { found: rows.length > 0 });
  },
};

async function cron(req, res) {
  const supplied = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!supplied || !safeEqual(supplied, env('CRON_SECRET'))) return send(res, 401, { error: 'Unauthorised' });
  try {
    send(res, 200, await tick());
  } catch (error) {
    console.error('Scheduler tick failed', error);
    send(res, 500, { error: 'Tick failed' });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const key = `${req.method} ${url.pathname}`;

    if (routes[key]) return await routes[key](req, res, url);

    if (req.method === 'DELETE' && /^\/api\/posts\/[0-9a-f-]{36}$/.test(url.pathname)) {
      const session = getSession(req);
      if (!session) return send(res, 401, { error: 'Unauthorised' });
      const rows = await query(`DELETE FROM posts WHERE id=$1 AND account_id=$2 AND status IN ('scheduled','failed','published') RETURNING id`, [url.pathname.split('/').pop(), session.accountId]);
      return rows.length ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Post not found or already processing.' });
    }

    if (req.method === 'GET' && url.pathname === '/dashboard') {
      if (!getSession(req)) return redirect(res, '/');
      return await serveFile(res, 'dashboard.html', 'text/html; charset=utf-8', 'no-store');
    }

    if (req.method === 'GET' && FILES[url.pathname]) {
      const [name, type] = FILES[url.pathname];
      return await serveFile(res, name, type, type.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600');
    }

    send(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) send(res, error.status ?? 500, { error: error.status === 413 ? 'Payload too large' : 'Internal server error' });
  }
});

const port = Number(process.env.PORT) || 8000;
server.listen(port, '0.0.0.0', () => console.log(`GlassPost listening on :${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
