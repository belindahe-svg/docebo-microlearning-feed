-- Diagnostics for "Share content": one row per step (upload URL, storage upload, asset, channels).
-- No file contents or tokens; detail holds status codes and short error text. Safe to clear.
CREATE TABLE contrib_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  step       TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  status     INTEGER,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
