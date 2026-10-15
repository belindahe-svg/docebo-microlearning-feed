-- Each learner's private Docebo playlist that mirrors "Save" in the feed ("Saved from Feed").
CREATE TABLE user_playlists (
  user_id     TEXT PRIMARY KEY,   -- Docebo user ID
  playlist_id INTEGER NOT NULL,   -- Docebo /share/v1/playlists id
  created_at  INTEGER NOT NULL
);
