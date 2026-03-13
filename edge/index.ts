import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  CATEGORY_DEFINITIONS,
  HUNDRED_MILE_BETA_LIMIT_MESSAGE,
  MAX_UPLOAD_BYTES,
  QUEUE_STATUSES,
  RADIUS_BANDS,
} from '../shared/constants'
import type {
  AppLockState,
  MapSessionResponse,
  PoiCategory,
  ProviderStatusResponse,
  QueueItemDetail,
  QueueItemSummary,
  QueueStatus,
  SavedSearchSummary,
  ScoutProfile,
  SearchResponse,
  SessionResponse,
} from '../shared/types'
import { getDb } from './db/client'
import { mediaAssets, poiCatalog, savedSearches, scoutPoiNotes, scoutProfiles, scoutQueueItems } from './db/schema'
import type { Env } from './env'
import { buildQueueCsv, buildQueueGeoJson } from './lib/export'
import { buildCoverageBands, geocodeInput, mergeQueueState, queryPoisWithinRadius } from './lib/geo'
import { extractMediaMetadata } from './lib/media-metadata'
import {
  ProviderQuotaError,
  ProviderQuotaGate,
  getProviderStatus,
  requireProviderUnits,
  resetProviderQuotas,
} from './lib/provider-quota'

const app = new Hono<{ Bindings: Env }>()
const EXEMPT_API_PATHS = new Set(['/api/health', '/api/session', '/api/provider-status', '/api/provider-debug/reset'])

const scoutSchema = z.object({
  name: z.string().min(2).max(64),
})

const categoryValues = CATEGORY_DEFINITIONS.map(item => item.key) as unknown as [PoiCategory, ...PoiCategory[]]
const queueStatuses = [...QUEUE_STATUSES] as [QueueStatus, ...QueueStatus[]]

const searchSchema = z.object({
  scoutProfileId: z.string().min(1),
  originInput: z.string().trim().min(3).optional(),
  originLat: z.number().optional(),
  originLng: z.number().optional(),
  radiusMiles: z.union([z.literal(1), z.literal(5), z.literal(10), z.literal(25), z.literal(50), z.literal(100)]),
  categories: z.array(z.enum(categoryValues)).min(1),
  zoomLevel: z.number().int().min(1).max(20).nullable().optional(),
})

const queueCreateSchema = z.object({
  scoutProfileId: z.string().min(1),
  poiId: z.string().min(1),
  distanceMiles: z.number().min(0),
  interestReason: z.string().max(300).nullable().optional(),
  status: z.enum(queueStatuses).default('queued'),
  note: z.string().max(1000).optional(),
})

const queueUpdateSchema = z.object({
  status: z.enum(queueStatuses).optional(),
  interestReason: z.string().max(300).nullable().optional(),
  note: z.string().max(1000).optional(),
})

app.use('/api/*', async (c, next) => {
  if (EXEMPT_API_PATHS.has(c.req.path)) {
    await next()
    return
  }

  const status = await getProviderStatus(c.env)
  if (status.lockState.isLocked) {
    return c.json(buildLockResponse(status.lockState), 503)
  }

  await next()
})

app.onError((error, c) => {
  console.error(error)

  if (error instanceof ProviderQuotaError) {
    return c.json(
      {
        code: 'provider_locked',
        lockedProvider: error.provider,
        message: error.message,
        availableAt: error.availableAt,
      },
      503,
    )
  }

  return c.json({ error: error instanceof Error ? error.message : 'Unexpected server error.' }, 500)
})

app.get('/api/health', c => c.json({ ok: true, at: new Date().toISOString() }))

app.get('/api/session', async c => {
  const db = getDb(c.env)
  const profiles = await db.select().from(scoutProfiles).orderBy(asc(scoutProfiles.name))
  const providerStatus = await getProviderStatus(c.env)

  const response: SessionResponse = {
    accessEmail: getAccessEmail(c.req.raw),
    appBaseUrl: c.env.APP_BASE_URL,
    profiles: profiles.map(profile => mapScoutProfile(profile)),
    categories: CATEGORY_DEFINITIONS,
    radiusBands: RADIUS_BANDS,
    mapProvider: 'mapbox',
    providerStatuses: providerStatus.providerStatuses,
    lockState: providerStatus.lockState,
    debugControlsEnabled: canUseDebugControls(c.env, c.req.raw),
  }

  return c.json(response)
})

app.get('/api/provider-status', async c => {
  const response: ProviderStatusResponse = await getProviderStatus(c.env)
  return c.json(response)
})

app.post('/api/provider-debug/reset', async c => {
  if (!canUseDebugControls(c.env, c.req.raw)) {
    return c.json({ error: 'Debug controls are not enabled for this session.' }, 403)
  }

  const response = await resetProviderQuotas(c.env, {
    accessEmail: getAccessEmail(c.req.raw),
    userAgent: c.req.header('user-agent') ?? null,
  })
  return c.json(response)
})

app.post('/api/map-session', async c => {
  const providerStatus = await requireProviderUnits(c.env, 'mapbox.map_load', 1, 'map-session', {
    accessEmail: getAccessEmail(c.req.raw),
    userAgent: c.req.header('user-agent') ?? null,
  })

  const response: MapSessionResponse = {
    accessToken: c.env.MAPBOX_PUBLIC_TOKEN ?? null,
    styleUrl: c.env.MAPBOX_STYLE_URL,
    providerStatus,
  }

  return c.json(response, 201)
})

app.post('/api/scouts', zValidator('json', scoutSchema), async c => {
  const payload = c.req.valid('json')
  const db = getDb(c.env)
  const now = new Date().toISOString()
  const name = payload.name.trim()
  const existing = await db.select().from(scoutProfiles).where(eq(scoutProfiles.name, name)).limit(1)

  if (existing[0]) {
    await db.update(scoutProfiles).set({ lastUsedAt: now }).where(eq(scoutProfiles.id, existing[0].id))
    return c.json({ profile: { ...mapScoutProfile(existing[0]), lastUsedAt: now } })
  }

  const profile = {
    id: crypto.randomUUID(),
    name,
    createdAt: now,
    lastUsedAt: now,
  }

  await db.insert(scoutProfiles).values(profile)
  return c.json({ profile }, 201)
})

app.get('/api/scouts/:id/searches', async c => {
  const db = getDb(c.env)
  const rows = await db
    .select()
    .from(savedSearches)
    .where(eq(savedSearches.scoutProfileId, c.req.param('id')))
    .orderBy(desc(savedSearches.createdAt))

  const searches: SavedSearchSummary[] = rows.map(row => ({
    id: row.id,
    scoutProfileId: row.scoutProfileId,
    originLabel: row.originLabel,
    originLat: row.originLat,
    originLng: row.originLng,
    radiusMiles: row.radiusMiles,
    categories: JSON.parse(row.categoriesJson) as PoiCategory[],
    resultCount: row.resultCount,
    zoomLevel: row.zoomLevel,
    createdAt: row.createdAt,
  }))

  return c.json({ searches })
})

app.get('/api/scouts/:id/queue', async c => {
  const queueItems = await loadQueueItems(c.env, c.req.param('id'))
  return c.json({ queueItems })
})

app.post('/api/searches', zValidator('json', searchSchema), async c => {
  const payload = c.req.valid('json')
  const db = getDb(c.env)
  const now = new Date().toISOString()

  if (payload.radiusMiles === 100 && payload.categories.length > 1) {
    return c.json({ error: HUNDRED_MILE_BETA_LIMIT_MESSAGE }, 400)
  }

  const hasCoordinates = typeof payload.originLat === 'number' && typeof payload.originLng === 'number'
  if (!hasCoordinates && !payload.originInput) {
    return c.json({ error: 'Please enter an address or coordinates to search.' }, 400)
  }

  const origin = hasCoordinates
    ? {
        label: payload.originInput?.trim() || `${(payload.originLat as number).toFixed(6)}, ${(payload.originLng as number).toFixed(6)}`,
        lat: payload.originLat as number,
        lng: payload.originLng as number,
      }
    : await geocodeInput(c.env, payload.originInput!)

  const candidates = await queryPoisWithinRadius(c.env, { lat: origin.lat, lng: origin.lng }, payload.radiusMiles, payload.categories)
  const queueState = await loadQueueStateByPoiId(c.env, payload.scoutProfileId)
  const poiIdByProviderPlaceKey = new Map<string, string>()
  const poiStatements = candidates.map(candidate =>
    c.env.DB
      .prepare(`
        INSERT INTO poi_catalog (
          id,
          provider,
          provider_place_key,
          name,
          category,
          raw_categories_json,
          address,
          lat,
          lng,
          website,
          phone,
          source_tags_json,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider_place_key) DO UPDATE SET
          provider = excluded.provider,
          name = excluded.name,
          category = excluded.category,
          raw_categories_json = excluded.raw_categories_json,
          address = excluded.address,
          lat = excluded.lat,
          lng = excluded.lng,
          website = excluded.website,
          phone = excluded.phone,
          source_tags_json = excluded.source_tags_json,
          updated_at = excluded.updated_at
        RETURNING id, provider_place_key
      `)
      .bind(
        crypto.randomUUID(),
        candidate.provider,
        candidate.providerPlaceKey,
        candidate.name,
        candidate.category,
        JSON.stringify(candidate.rawCategories),
        candidate.address,
        candidate.lat,
        candidate.lng,
        candidate.website,
        candidate.phone,
        JSON.stringify(candidate.sourceTags),
        now,
        now,
      ),
  )
  const poiResults = await executeBatchInChunks(c.env.DB, poiStatements)

  for (const result of poiResults) {
    const row = (result.results as Array<{ id: string; provider_place_key: string }>)[0]
    if (row) {
      poiIdByProviderPlaceKey.set(row.provider_place_key, row.id)
    }
  }

  const searchId = crypto.randomUUID()
  await db.insert(savedSearches).values({
    id: searchId,
    scoutProfileId: payload.scoutProfileId,
    originLabel: origin.label,
    originLat: origin.lat,
    originLng: origin.lng,
    radiusMiles: payload.radiusMiles,
    categoriesJson: JSON.stringify(payload.categories),
    resultCount: candidates.length,
    zoomLevel: payload.zoomLevel ?? null,
    createdAt: now,
  })

  const savedSearchResultStatements = candidates
    .map(candidate => {
      const poiId = poiIdByProviderPlaceKey.get(candidate.providerPlaceKey)
      if (!poiId) {
        return null
      }

      return c.env.DB
        .prepare(`
          INSERT INTO saved_search_results (search_id, poi_id, distance_miles)
          VALUES (?, ?, ?)
          ON CONFLICT(search_id, poi_id) DO UPDATE SET distance_miles = excluded.distance_miles
        `)
        .bind(searchId, poiId, candidate.distanceMiles)
    })
    .filter(isDefined)

  await executeBatchInChunks(c.env.DB, savedSearchResultStatements)
  await db.update(scoutProfiles).set({ lastUsedAt: now }).where(eq(scoutProfiles.id, payload.scoutProfileId))

  const response: SearchResponse = {
    search: {
      id: searchId,
      scoutProfileId: payload.scoutProfileId,
      originLabel: origin.label,
      originLat: origin.lat,
      originLng: origin.lng,
      radiusMiles: payload.radiusMiles,
      categories: payload.categories,
      resultCount: candidates.length,
      zoomLevel: payload.zoomLevel ?? null,
      createdAt: now,
    },
    coverageBands: await buildCoverageBands(c.env, { lat: origin.lat, lng: origin.lng }, payload.radiusMiles, payload.categories, candidates),
    results: mergeQueueState(candidates, queueState, poiIdByProviderPlaceKey),
  }

  return c.json(response, 201)
})

app.post('/api/queue-items', zValidator('json', queueCreateSchema), async c => {
  const payload = c.req.valid('json')
  const db = getDb(c.env)
  const now = new Date().toISOString()
  const existing = await db
    .select()
    .from(scoutQueueItems)
    .where(and(eq(scoutQueueItems.scoutProfileId, payload.scoutProfileId), eq(scoutQueueItems.poiId, payload.poiId)))
    .limit(1)

  const queueItemId = existing[0]?.id ?? crypto.randomUUID()

  if (existing[0]) {
    await db
      .update(scoutQueueItems)
      .set({
        status: payload.status,
        distanceMiles: payload.distanceMiles,
        interestReason: payload.interestReason ?? null,
        updatedAt: now,
      })
      .where(eq(scoutQueueItems.id, queueItemId))
  } else {
    await db.insert(scoutQueueItems).values({
      id: queueItemId,
      scoutProfileId: payload.scoutProfileId,
      poiId: payload.poiId,
      status: payload.status,
      distanceMiles: payload.distanceMiles,
      interestReason: payload.interestReason ?? null,
      createdAt: now,
      updatedAt: now,
    })
  }

  if (payload.note?.trim()) {
    await db.insert(scoutPoiNotes).values({
      id: crypto.randomUUID(),
      scoutProfileId: payload.scoutProfileId,
      poiId: payload.poiId,
      queueItemId,
      note: payload.note.trim(),
      authorAccessEmail: getAccessEmail(c.req.raw),
      createdAt: now,
    })
  }

  return c.json({ queueItemId }, existing[0] ? 200 : 201)
})

app.patch('/api/queue-items/:id', zValidator('json', queueUpdateSchema), async c => {
  const payload = c.req.valid('json')
  const db = getDb(c.env)
  const queueItemId = c.req.param('id')
  const now = new Date().toISOString()
  const existing = await db.select().from(scoutQueueItems).where(eq(scoutQueueItems.id, queueItemId)).limit(1)

  if (!existing[0]) {
    return c.json({ error: 'Queue item not found.' }, 404)
  }

  await db
    .update(scoutQueueItems)
    .set({
      status: payload.status ?? existing[0].status,
      interestReason: payload.interestReason === undefined ? existing[0].interestReason : payload.interestReason,
      updatedAt: now,
    })
    .where(eq(scoutQueueItems.id, queueItemId))

  if (payload.note?.trim()) {
    await db.insert(scoutPoiNotes).values({
      id: crypto.randomUUID(),
      scoutProfileId: existing[0].scoutProfileId,
      poiId: existing[0].poiId,
      queueItemId,
      note: payload.note.trim(),
      authorAccessEmail: getAccessEmail(c.req.raw),
      createdAt: now,
    })
  }

  return c.json({ ok: true })
})

app.post('/api/uploads', async c => {
  const formData = await c.req.formData()
  const file = formData.get('file')
  const scoutProfileId = String(formData.get('scoutProfileId') ?? '')
  const poiId = String(formData.get('poiId') ?? '')
  const queueItemId = String(formData.get('queueItemId') ?? '')
  const caption = String(formData.get('caption') ?? '')

  if (!(file instanceof File)) {
    return c.json({ error: 'Upload is missing a file.' }, 400)
  }

  if (!scoutProfileId || !poiId || !queueItemId) {
    return c.json({ error: 'Upload is missing required metadata.' }, 400)
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json({ error: 'File exceeds the 100 MB limit.' }, 400)
  }

  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
    return c.json({ error: 'Only image and video uploads are supported.' }, 400)
  }

  const mediaId = crypto.randomUUID()
  const r2Key = `${scoutProfileId}/${queueItemId}/${mediaId}-${sanitizeFileName(file.name)}`
  const fileBytes = await file.arrayBuffer()
  const extractedMetadata = await extractMediaMetadata(file, fileBytes)

  await c.env.MEDIA_BUCKET.put(r2Key, fileBytes, {
    httpMetadata: {
      contentType: file.type,
      contentDisposition: `inline; filename="${file.name}"`,
    },
  })

  const db = getDb(c.env)
  const createdAt = new Date().toISOString()
  await db.insert(mediaAssets).values({
    id: mediaId,
    scoutProfileId,
    poiId,
    queueItemId,
    r2Key,
    fileName: file.name,
    contentType: file.type,
    sizeBytes: file.size,
    caption: caption || null,
    capturedAt: extractedMetadata?.capturedAt ?? null,
    capturedLat: extractedMetadata?.capturedLat ?? null,
    capturedLng: extractedMetadata?.capturedLng ?? null,
    widthPx: extractedMetadata?.widthPx ?? null,
    heightPx: extractedMetadata?.heightPx ?? null,
    metadataJson: extractedMetadata ? JSON.stringify(extractedMetadata) : null,
    createdAt,
  })

  return c.json({
    media: {
      id: mediaId,
      queueItemId,
      poiId,
      url: `${c.env.APP_BASE_URL}/api/media/${mediaId}`,
      fileName: file.name,
      contentType: file.type,
      sizeBytes: file.size,
      caption: caption || null,
      createdAt,
      metadata: extractedMetadata,
    },
  })
})

app.get('/api/media/:id', async c => {
  const db = getDb(c.env)
  const rows = await db.select().from(mediaAssets).where(eq(mediaAssets.id, c.req.param('id'))).limit(1)
  const asset = rows[0]

  if (!asset) {
    return c.notFound()
  }

  const object = await c.env.MEDIA_BUCKET.get(asset.r2Key)
  if (!object) {
    return c.notFound()
  }

  return new Response(object.body, {
    headers: {
      'content-type': asset.contentType,
      'content-length': String(asset.sizeBytes),
      'cache-control': 'private, max-age=60',
      'content-disposition': `inline; filename="${asset.fileName}"`,
    },
  })
})

app.get('/api/export.csv', async c => {
  const scoutProfileId = c.req.query('scoutProfileId')
  if (!scoutProfileId) {
    return c.json({ error: 'scoutProfileId is required.' }, 400)
  }

  const queueItems = await loadQueueItems(c.env, scoutProfileId)
  return new Response(buildQueueCsv(queueItems), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="radius-scout-export.csv"',
    },
  })
})

app.get('/api/export.geojson', async c => {
  const scoutProfileId = c.req.query('scoutProfileId')
  if (!scoutProfileId) {
    return c.json({ error: 'scoutProfileId is required.' }, 400)
  }

  const queueItems = await loadQueueItems(c.env, scoutProfileId)
  return c.json(buildQueueGeoJson(queueItems))
})

app.get('*', c => c.env.ASSETS.fetch(c.req.raw))

export default {
  fetch: app.fetch,
}

export { ProviderQuotaGate }

async function loadQueueStateByPoiId(env: Env, scoutProfileId: string): Promise<Map<string, QueueItemSummary>> {
  const db = getDb(env)
  const queueRows = await db.select().from(scoutQueueItems).where(eq(scoutQueueItems.scoutProfileId, scoutProfileId))
  const map = new Map<string, QueueItemSummary>()

  for (const row of queueRows) {
    map.set(row.poiId, {
      id: row.id,
      status: row.status as QueueStatus,
      distanceMiles: row.distanceMiles,
      interestReason: row.interestReason,
      updatedAt: row.updatedAt,
    })
  }

  return map
}

async function loadQueueItems(env: Env, scoutProfileId: string): Promise<QueueItemDetail[]> {
  const db = getDb(env)
  const queueRows = await db
    .select()
    .from(scoutQueueItems)
    .where(eq(scoutQueueItems.scoutProfileId, scoutProfileId))
    .orderBy(desc(scoutQueueItems.updatedAt))

  if (queueRows.length === 0) {
    return []
  }

  const poiIds = queueRows.map(row => row.poiId)
  const queueItemIds = queueRows.map(row => row.id)
  const poiRows = await db.select().from(poiCatalog).where(inArray(poiCatalog.id, poiIds))
  const noteRows = await db.select().from(scoutPoiNotes).where(inArray(scoutPoiNotes.queueItemId, queueItemIds))
  const mediaRows = await db.select().from(mediaAssets).where(inArray(mediaAssets.queueItemId, queueItemIds))

  const poiById = new Map(
    poiRows.map(row => [
      row.id,
      {
        id: row.id,
        providerPlaceKey: row.providerPlaceKey,
        name: row.name,
        category: row.category as PoiCategory,
        rawCategories: JSON.parse(row.rawCategoriesJson) as string[],
        address: row.address,
        lat: row.lat,
        lng: row.lng,
        distanceMiles: 0,
        website: row.website,
        phone: row.phone,
        queueItem: null,
      },
    ]),
  )

  const items: QueueItemDetail[] = []

  for (const row of queueRows) {
    const poi = poiById.get(row.poiId)
    if (!poi) {
      continue
    }

    const notes = noteRows
      .filter(note => note.queueItemId === row.id)
      .map(note => ({
        id: note.id,
        note: note.note,
        createdAt: note.createdAt,
        authorAccessEmail: note.authorAccessEmail,
      }))

    const media = mediaRows
      .filter(mediaRow => mediaRow.queueItemId === row.id)
      .map(mediaRow => ({
        metadata: readMediaMetadata(mediaRow),
        id: mediaRow.id,
        queueItemId: mediaRow.queueItemId,
        poiId: mediaRow.poiId,
        url: `${env.APP_BASE_URL}/api/media/${mediaRow.id}`,
        fileName: mediaRow.fileName,
        contentType: mediaRow.contentType,
        sizeBytes: mediaRow.sizeBytes,
        caption: mediaRow.caption,
        createdAt: mediaRow.createdAt,
      }))

    items.push({
      id: row.id,
      status: row.status as QueueStatus,
      distanceMiles: row.distanceMiles,
      interestReason: row.interestReason,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      poi: {
        ...poi,
        distanceMiles: row.distanceMiles,
      },
      notes,
      media,
    })
  }

  return items
}

function mapScoutProfile(profile: typeof scoutProfiles.$inferSelect): ScoutProfile {
  return {
    id: profile.id,
    name: profile.name,
    createdAt: profile.createdAt,
    lastUsedAt: profile.lastUsedAt,
  }
}

function getAccessEmail(request: Request): string | null {
  return request.headers.get('cf-access-authenticated-user-email')
}

function sanitizeFileName(fileName: string): string {
  return fileName.replaceAll(/[^a-zA-Z0-9._-]/g, '-')
}

function readMediaMetadata(mediaRow: typeof mediaAssets.$inferSelect) {
  if (mediaRow.metadataJson) {
    try {
      return JSON.parse(mediaRow.metadataJson) as {
        widthPx: number | null
        heightPx: number | null
        capturedAt: string | null
        capturedLat: number | null
        capturedLng: number | null
        deviceMake: string | null
        deviceModel: string | null
        lensModel: string | null
      }
    } catch (error) {
      console.warn('Unable to parse persisted media metadata.', error)
    }
  }

  return {
    widthPx: mediaRow.widthPx,
    heightPx: mediaRow.heightPx,
    capturedAt: mediaRow.capturedAt,
    capturedLat: mediaRow.capturedLat,
    capturedLng: mediaRow.capturedLng,
    deviceMake: null,
    deviceModel: null,
    lensModel: null,
  }
}

async function executeBatchInChunks(db: D1Database, statements: D1PreparedStatement[], chunkSize = 50) {
  const results: D1Result[] = []

  for (let index = 0; index < statements.length; index += chunkSize) {
    const chunk = statements.slice(index, index + chunkSize)
    if (chunk.length === 0) {
      continue
    }

    const chunkResults = await db.batch(chunk)
    results.push(...chunkResults)
  }

  return results
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined
}

function buildLockResponse(lockState: AppLockState) {
  return {
    code: 'provider_locked',
    lockedProvider: lockState.lockedProvider,
    message: lockState.message,
    availableAt: lockState.availableAt,
  }
}

function canUseDebugControls(env: Env, request: Request) {
  if (env.PROVIDER_MOCKS === '1' || env.APP_ENV !== 'production') {
    return true
  }

  if (env.DEBUG_CONTROLS_ENABLED !== '1') {
    return false
  }

  const accessEmail = getAccessEmail(request)?.toLowerCase()
  if (!accessEmail) {
    return false
  }

  const allowedEmails = (env.DEBUG_ADMIN_EMAILS ?? '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)

  return allowedEmails.includes(accessEmail)
}
