# aTalent Micro-learning Feed (MVP)

A vertical, swipeable learning feed for a Docebo Channel, embedded in a Docebo widget page through the **iFrame widget**. Learners swipe through short videos and courses with fewer clicks, and can like, save and comment.

## Architecture (hybrid model)

| Layer | Owner | How |
|---|---|---|
| What appears in the feed | Docebo Channel | Docebo API, called with the **learner's own token**, so Docebo visibility rules apply |
| Video playback | Docebo, or a CDN copy | Streamable URL from Docebo if available; otherwise a media override keyed to the Docebo item ID |
| Completions and enrolment status | Docebo | Courses hand off to Docebo's native player (SCORM tracking intact). Asset views are written back once the endpoint is confirmed |
| Likes, saves, comments, watch progress | This app (Cloudflare D1) | Keyed by Docebo user ID and item key (`asset:32`, `course:44`) |

```
Docebo widget page
 └─ iFrame widget (Advanced Settings: OAuth2 app + Salt secret)
     └─ https://<worker>/?user_id=…&username=…&auth_code=…&hash=…
         ├─ POST /api/session   verify hash, exchange auth_code (30 s) for learner token
         ├─ GET  /api/feed      Docebo Channel items + engagement from D1
         └─ POST /api/items/:key/{like|save|comments|progress}
```

Stack: Cloudflare Worker (TypeScript), D1, static frontend (no framework).

## Run it locally (mock mode)

Mock mode serves 10 real items captured from atalentdemo2 and needs no Docebo credentials.

```bash
npm install
cp .dev.vars.example .dev.vars
npx wrangler d1 create microlearning-feed      # paste the database_id into wrangler.toml
npm run db:migrate:local
npm run dev                                     # http://localhost:8787
```

To test the signed handshake locally:

```bash
node scripts/sign-url.mjs http://localhost:8787 dev-salt   # open the printed URL
```

To see video playback in mock mode, attach a test video to an item:

```bash
curl -X PUT http://localhost:8787/api/admin/media/asset:32 \
  -H "Authorization: Bearer dev-admin" -H "Content-Type: application/json" \
  -d '{"video_url":"https://<your-cdn>/sample.mp4"}'
```

## Deploy from the Cloudflare dashboard (no terminal)

Everything below happens in the browser. Cloudflare builds and deploys from this GitHub repo on every push.

1. **Database.** Cloudflare dashboard → Storage & Databases → D1 → Create database, named `microlearning-feed`. Copy its **Database ID** into `wrangler.toml` (`database_id`). Then open the database's **Console** tab, paste the contents of `migrations/0001_init.sql` and run it.
2. **Worker.** Workers & Pages → Create → **Import a repository** → pick `docebo-microlearning-feed`. Leave the build command empty; deploy command `npx wrangler deploy`. Note the Worker URL it gives you (e.g. `https://docebo-microlearning-feed.<you>.workers.dev`).
3. **Secrets.** Worker → Settings → Variables and Secrets → add as **Secret**: `DOCEBO_SALT_SECRET`, `DOCEBO_OAUTH_CLIENT_SECRET`, `ADMIN_TOKEN`.
4. **Settings.** Plain settings live in `wrangler.toml` (edit on GitHub; each push redeploys). Values typed into the dashboard for those names are overwritten by `wrangler.toml` on the next deploy.

### Discovery mode (confirm the endpoints without a terminal)

1. In `wrangler.toml` set `DOCEBO_MODE = "live"`, `DOCEBO_OAUTH_CLIENT_ID`, `DOCEBO_CHANNEL_ID` (optional; leave empty to use every channel the learner can see, and discovery then probes the item endpoints on the first visible channel), and `DISCOVERY_USERS` to your Docebo username.
2. In Docebo, create the OAuth2 app (redirect URL = the Worker URL) and add the iFrame widget to a widget page (Advanced Settings on, same OAuth2 app, salt secret).
3. Open that page as yourself. Instead of the feed you'll see an **Endpoint check**: status codes and field names for each candidate path, plus the iFrame parameter names Docebo sent. Click **Copy results**.
4. Once the endpoints are confirmed, clear `DISCOVERY_USERS`.

## Go live against Docebo

1. **Create an OAuth2 app** in Docebo (Admin menu → API and SSO → API credentials). Note the client ID and secret.
2. **Confirm the endpoints** (they are not in Docebo's public docs). Get a token from the API browser at `https://<domain>/api-browser/`, then run:
   ```bash
   DOCEBO_DOMAIN=atalentdemo2.docebosaas.com DOCEBO_TOKEN=… CHANNEL_ID=… npm run discover
   ```
   Set `DOCEBO_CHANNEL_ITEMS_PATH` to the path that returns the channel's items. If the asset detail has no streamable video URL, use media overrides. Set `DOCEBO_ASSET_VIEW_PATH` only once a view or completion endpoint is confirmed.
3. **Configure** `wrangler.toml`: `DOCEBO_MODE = "live"`, `DOCEBO_CHANNEL_ID` (empty = all channels visible to the learner, merged and de-duplicated), `DOCEBO_OAUTH_CLIENT_ID`, `ALLOWED_FRAME_ANCESTORS`.
4. **Set secrets**:
   ```bash
   npx wrangler secret put DOCEBO_SALT_SECRET
   npx wrangler secret put DOCEBO_OAUTH_CLIENT_SECRET
   npx wrangler secret put ADMIN_TOKEN
   ```
5. **Deploy**: `npm run db:migrate:remote && npm run deploy`.
6. **Add the widget**: Docebo widget page → iFrame widget → URL = your Worker URL, set a height (e.g. 760 px), turn on Advanced Settings, select the OAuth2 app, paste the salt secret.
7. **First load**: if the page says "Missing Docebo iframe parameters", it lists the parameter names Docebo actually sent. Adjust `readIframeParams` in `src/auth.ts` to match.

## Open questions to close before a client demo

| # | Question | Where it matters |
|---|---|---|
| 1 | ~~Endpoint for a Channel's items~~ Confirmed: `GET /learn/v1/channels/{id}/assets` (learner token). Rows: id, type_id, title, content_type, image_url, uri, rating, duration. `/learn/v1/channels` also embeds ~10 preview items per channel in `sub_items`. Note: `/share/v1/assets?channel_id=` ignores the filter | `DOCEBO_CHANNEL_ITEMS_PATH`, `normalizeItem` |
| 2 | ~~Streamable video URL?~~ On atalentdemo2, video assets are YouTube embeds (`player.content.sources[0].url`), so the feed plays them with YouTube's embedded player via `GET /api/assets/{id}/media`. Uploaded MP4 assets not yet checked; media overrides cover them | Media overrides vs direct streaming |
| 3 | ~~Asset view via API?~~ Yes: `PUT /share/v1/assets/{id}/track`, sent on first play | `src/social.ts` |
| 4 | Do channel items include the learner's enrolment status for courses? | Status chips |
| 5 | ~~iFrame parameter names~~ Confirmed: `user_id`, `username`, `auth_code`, `hash` | `readIframeParams` |
| 6 | Does Docebo require `redirect_uri` on the auth-code exchange? | `DOCEBO_OAUTH_REDIRECT_URI` |
| 7 | The iFrame widget is documented as **desktop only**. Mobile and Go.Learn need a different entry point (e.g. an external link page with SSO) | Mobile rollout |
| 8 | Does the iframe sandbox allow `target="_top"` links, so "Open in Docebo" navigates the main page? | CTA behaviour |

## Docebo-synced social actions

Endpoints come from the instance's own API spec (`/share/v1/swagger`, `/learn/v1/swagger`) and run with the learner's token.

| Feed action | Assets | Courses | Learning plans |
|---|---|---|---|
| Like ♥ | App only (Docebo has no "like" for content) | App only | App only |
| Rate ★ | `PUT /share/v1/assets/{id}/rating` | `POST /learn/v1/courses/{id}/rating` | n/a |
| Comment | Docebo asset comments (`/share/v1/comments`) | App | App |
| Save | App + learner's private Docebo playlist "Saved from Feed" | App + playlist | App only |
| Share | Invite to watch (`/share/v1/assets/{id}/invitations`) + copy link | Copy link | Copy link |
| Watch | `PUT /share/v1/assets/{id}/track` on first play | n/a | n/a |

## Security notes

- The hash is checked with a constant-time comparison; the auth code is removed from the address bar right after the handshake.
- The learner's Docebo token stays server-side in D1; the browser only holds an opaque session ID, sent as a Bearer header (no third-party cookies, so it works inside the iframe).
- Responses set `Content-Security-Policy: frame-ancestors` to the Docebo origins in `ALLOWED_FRAME_ANCESTORS`.
- Comments are plain text, escaped on render, capped at 1,000 characters. Learners can delete only their own.
- MVP limits: no moderation queue, and item keys are format-checked but not checked against the learner's feed.

## Project layout

```
src/index.ts      router, headers, session and feed handlers
src/auth.ts       iframe hash check, auth-code exchange, sessions
src/docebo.ts     Docebo client, defensive normalizer, view tracking hook
src/db.ts         likes, saves, comments, progress, media overrides
src/mock.ts       10 real items from atalentdemo2 for mock mode
public/           feed UI (index.html, app.css, app.js)
migrations/       D1 schema
scripts/          discover.mjs (endpoint probe), sign-url.mjs (handshake test)
test/             unit tests (vitest)
```
