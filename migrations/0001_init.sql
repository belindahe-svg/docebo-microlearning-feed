-- Engagement layer only. Docebo stays the system of record for content, enrolments and completions.
-- Items are keyed as "<kind>:<docebo id>", e.g. "asset:32" or "course:44".

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,          -- random, sent by the browser as a Bearer token
  user_id       TEXT NOT NULL,             -- Docebo user ID
  username      TEXT NOT NULL,
  access_token  TEXT,                      -- learner's Docebo token (NULL in mock mode)
  expires_at    INTEGER NOT NULL           -- unix seconds
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE likes (
  item_key   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (item_key, user_id)
);

CREATE TABLE saves (
  item_key   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (item_key, user_id)
);

CREATE TABLE comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_key   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  username   TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_comments_item ON comments(item_key, created_at);

-- Feed analytics only (not a learning record). Completions go to Docebo.
CREATE TABLE views (
  item_key    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  max_percent INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (item_key, user_id)
);

-- Optional CDN copy of a Docebo video, keyed to the Docebo item. Used when Docebo
-- does not expose a streamable URL suitable for the feed.
CREATE TABLE media_overrides (
  item_key   TEXT PRIMARY KEY,
  video_url  TEXT NOT NULL,
  poster_url TEXT,
  updated_at INTEGER NOT NULL
);
