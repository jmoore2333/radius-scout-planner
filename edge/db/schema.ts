import { integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const scoutProfiles = sqliteTable(
  'scout_profiles',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at').notNull(),
  },
  table => ({
    nameUnique: uniqueIndex('scout_profiles_name_unique').on(table.name),
  }),
)

export const savedSearches = sqliteTable('saved_searches', {
  id: text('id').primaryKey(),
  scoutProfileId: text('scout_profile_id').notNull().references(() => scoutProfiles.id, { onDelete: 'cascade' }),
  originLabel: text('origin_label').notNull(),
  originLat: real('origin_lat').notNull(),
  originLng: real('origin_lng').notNull(),
  radiusMiles: integer('radius_miles').notNull(),
  categoriesJson: text('categories_json').notNull(),
  resultCount: integer('result_count').notNull(),
  zoomLevel: integer('zoom_level'),
  createdAt: text('created_at').notNull(),
})

export const poiCatalog = sqliteTable(
  'poi_catalog',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    providerPlaceKey: text('provider_place_key').notNull(),
    name: text('name').notNull(),
    category: text('category').notNull(),
    rawCategoriesJson: text('raw_categories_json').notNull(),
    address: text('address').notNull(),
    lat: real('lat').notNull(),
    lng: real('lng').notNull(),
    website: text('website'),
    phone: text('phone'),
    sourceTagsJson: text('source_tags_json').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  table => ({
    providerPlaceKeyUnique: uniqueIndex('poi_catalog_provider_place_key_unique').on(table.providerPlaceKey),
  }),
)

export const savedSearchResults = sqliteTable(
  'saved_search_results',
  {
    searchId: text('search_id').notNull().references(() => savedSearches.id, { onDelete: 'cascade' }),
    poiId: text('poi_id').notNull().references(() => poiCatalog.id, { onDelete: 'cascade' }),
    distanceMiles: real('distance_miles').notNull(),
  },
  table => ({
    pk: primaryKey({ columns: [table.searchId, table.poiId] }),
  }),
)

export const scoutQueueItems = sqliteTable(
  'scout_queue_items',
  {
    id: text('id').primaryKey(),
    scoutProfileId: text('scout_profile_id').notNull().references(() => scoutProfiles.id, { onDelete: 'cascade' }),
    poiId: text('poi_id').notNull().references(() => poiCatalog.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    distanceMiles: real('distance_miles').notNull(),
    interestReason: text('interest_reason'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  table => ({
    uniqueScoutPoi: uniqueIndex('scout_queue_items_unique_scout_poi').on(table.scoutProfileId, table.poiId),
  }),
)

export const scoutPoiNotes = sqliteTable('scout_poi_notes', {
  id: text('id').primaryKey(),
  scoutProfileId: text('scout_profile_id').notNull().references(() => scoutProfiles.id, { onDelete: 'cascade' }),
  poiId: text('poi_id').notNull().references(() => poiCatalog.id, { onDelete: 'cascade' }),
  queueItemId: text('queue_item_id').references(() => scoutQueueItems.id, { onDelete: 'cascade' }),
  note: text('note').notNull(),
  authorAccessEmail: text('author_access_email'),
  createdAt: text('created_at').notNull(),
})

export const mediaAssets = sqliteTable('media_assets', {
  id: text('id').primaryKey(),
  scoutProfileId: text('scout_profile_id').notNull().references(() => scoutProfiles.id, { onDelete: 'cascade' }),
  poiId: text('poi_id').references(() => poiCatalog.id, { onDelete: 'cascade' }),
  queueItemId: text('queue_item_id').references(() => scoutQueueItems.id, { onDelete: 'cascade' }),
  r2Key: text('r2_key').notNull(),
  fileName: text('file_name').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  caption: text('caption'),
  capturedAt: text('captured_at'),
  capturedLat: real('captured_lat'),
  capturedLng: real('captured_lng'),
  widthPx: integer('width_px'),
  heightPx: integer('height_px'),
  metadataJson: text('metadata_json'),
  createdAt: text('created_at').notNull(),
})

export const providerUsagePeriods = sqliteTable(
  'provider_usage_periods',
  {
    provider: text('provider').notNull(),
    periodStart: text('period_start').notNull(),
    periodEnd: text('period_end').notNull(),
    limit: integer('limit').notNull(),
    used: integer('used').notNull(),
    state: text('state').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  table => ({
    pk: primaryKey({ columns: [table.provider, table.periodStart] }),
  }),
)

export const providerUsageEvents = sqliteTable('provider_usage_events', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  periodStart: text('period_start').notNull(),
  units: integer('units').notNull(),
  reason: text('reason').notNull(),
  metadataJson: text('metadata_json'),
  createdAt: text('created_at').notNull(),
})
