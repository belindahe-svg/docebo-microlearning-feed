export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  DOCEBO_MODE: 'mock' | 'live' | string;
  DOCEBO_DOMAIN: string;
  DOCEBO_CHANNEL_ID: string;
  DOCEBO_OAUTH_CLIENT_ID: string;
  DOCEBO_OAUTH_REDIRECT_URI: string;
  DOCEBO_CHANNEL_ITEMS_PATH: string;
  DOCEBO_CHANNELS_LIST_PATH?: string;
  DOCEBO_ASSET_VIEW_PATH: string;
  ALLOWED_FRAME_ANCESTORS: string;
  SESSION_TTL_SECONDS: string;
  DOCEBO_SALT_SECRET: string;
  DOCEBO_OAUTH_CLIENT_SECRET: string;
  ADMIN_TOKEN: string;
  DISCOVERY_USERS?: string;
  DISCOVERY_ASSET_ID?: string;
}

export type ItemKind = 'asset' | 'course' | 'learning_plan';

/** One card in the feed. Everything except `engagement` comes from Docebo. */
export interface FeedItem {
  key: string;            // "<kind>:<id>"
  id: string;
  kind: ItemKind;
  subtype: string;        // e.g. "Video", "E-Learning", "PDF"
  title: string;
  description?: string;
  thumbnailUrl?: string;
  videoUrl?: string;      // streamable URL, from Docebo or a media override
  doceboUrl: string;      // deep link that opens the item in Docebo's own player
  status?: string;        // learner's enrolment status for courses, when Docebo returns it
  rating?: number;
  channels?: string[];    // names of the learner's channels this item appears in (all-channels mode)
}

export interface Engagement {
  likes: number;
  liked: boolean;
  saved: boolean;
  comments: number;
}

export interface Session {
  id: string;
  user_id: string;
  username: string;
  access_token: string | null;
  expires_at: number;
}
