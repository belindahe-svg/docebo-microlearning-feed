#!/usr/bin/env node
// Probe candidate Docebo endpoints for Channels and assets, read-only (GET only).
//
// Usage:
//   DOCEBO_DOMAIN=atalentdemo2.docebosaas.com DOCEBO_TOKEN=<access token> \
//   CHANNEL_ID=<id> ASSET_ID=32 node scripts/discover.mjs
//
// Get a token from the Docebo API browser (https://<domain>/api-browser/) or an OAuth2 app.
// The script prints status codes and field names only, never field values beyond IDs and titles.
// The paths below are guesses to check, not confirmed endpoints. Add more if the API browser shows others.

const domain = process.env.DOCEBO_DOMAIN;
const token = process.env.DOCEBO_TOKEN;
const channelId = process.env.CHANNEL_ID || '';
const assetId = process.env.ASSET_ID || '32';
if (!domain || !token) {
  console.error('Set DOCEBO_DOMAIN and DOCEBO_TOKEN first.');
  process.exit(1);
}

const candidates = [
  ['List channels', '/learn/v1/channels'],
  ['List channels (share)', '/share/v1/channels'],
  ...(channelId
    ? [
        ['Channel detail', `/learn/v1/channels/${channelId}`],
        ['Channel items', `/learn/v1/channels/${channelId}/items`],
        ['Channel objects', `/learn/v1/channels/${channelId}/objects`],
        ['Channel assets (share)', `/share/v1/channels/${channelId}/assets`],
      ]
    : []),
  ['Asset detail (share)', `/share/v1/assets/${assetId}`],
  ['Asset detail (learn)', `/learn/v1/assets/${assetId}`],
  ['My enrolments', '/learn/v1/enrollments?page_size=5'],
];

function describe(body) {
  const data = body?.data ?? body;
  const rows = data?.items ?? data?.results ?? (Array.isArray(data) ? data : null);
  if (Array.isArray(rows)) {
    const first = rows[0] ?? {};
    return `${rows.length} rows; fields: ${Object.keys(first).join(', ') || '(empty)'}` +
      (first.title || first.name ? `; first: "${first.title ?? first.name}"` : '');
  }
  return `object; fields: ${Object.keys(data ?? {}).join(', ')}`;
}

for (const [label, path] of candidates) {
  try {
    const res = await fetch(`https://${domain}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    let detail = '';
    if (res.ok) detail = describe(await res.json().catch(() => ({})));
    console.log(`${res.status}  ${label.padEnd(24)} ${path}${detail ? `\n      ${detail}` : ''}`);
  } catch (e) {
    console.log(`ERR  ${label.padEnd(24)} ${path}  ${e.message}`);
  }
}
console.log('\nSet DOCEBO_CHANNEL_ITEMS_PATH in wrangler.toml to the path that returns the channel\'s items.');
console.log('Look for a video URL field on the asset detail; if none is streamable, use media overrides.');
