CREATE TABLE IF NOT EXISTS scout_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS scout_profiles_name_unique ON scout_profiles(name);

CREATE TABLE IF NOT EXISTS saved_searches (
  id TEXT PRIMARY KEY NOT NULL,
  scout_profile_id TEXT NOT NULL REFERENCES scout_profiles(id) ON DELETE CASCADE,
  origin_label TEXT NOT NULL,
  origin_lat REAL NOT NULL,
  origin_lng REAL NOT NULL,
  radius_miles INTEGER NOT NULL,
  categories_json TEXT NOT NULL,
  result_count INTEGER NOT NULL,
  zoom_level INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS poi_catalog (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  provider_place_key TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  raw_categories_json TEXT NOT NULL,
  address TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  website TEXT,
  phone TEXT,
  source_tags_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS poi_catalog_provider_place_key_unique ON poi_catalog(provider_place_key);

CREATE TABLE IF NOT EXISTS saved_search_results (
  search_id TEXT NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
  poi_id TEXT NOT NULL REFERENCES poi_catalog(id) ON DELETE CASCADE,
  distance_miles REAL NOT NULL,
  PRIMARY KEY (search_id, poi_id)
);

CREATE TABLE IF NOT EXISTS scout_queue_items (
  id TEXT PRIMARY KEY NOT NULL,
  scout_profile_id TEXT NOT NULL REFERENCES scout_profiles(id) ON DELETE CASCADE,
  poi_id TEXT NOT NULL REFERENCES poi_catalog(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  distance_miles REAL NOT NULL,
  interest_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS scout_queue_items_unique_scout_poi ON scout_queue_items(scout_profile_id, poi_id);

CREATE TABLE IF NOT EXISTS scout_poi_notes (
  id TEXT PRIMARY KEY NOT NULL,
  scout_profile_id TEXT NOT NULL REFERENCES scout_profiles(id) ON DELETE CASCADE,
  poi_id TEXT NOT NULL REFERENCES poi_catalog(id) ON DELETE CASCADE,
  queue_item_id TEXT REFERENCES scout_queue_items(id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  author_access_email TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY NOT NULL,
  scout_profile_id TEXT NOT NULL REFERENCES scout_profiles(id) ON DELETE CASCADE,
  poi_id TEXT REFERENCES poi_catalog(id) ON DELETE CASCADE,
  queue_item_id TEXT REFERENCES scout_queue_items(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  caption TEXT,
  captured_lat REAL,
  captured_lng REAL,
  created_at TEXT NOT NULL
);
