import type { CATEGORY_DEFINITIONS, QUEUE_STATUSES, RADIUS_BANDS } from './constants'

export type PoiCategory = (typeof CATEGORY_DEFINITIONS)[number]['key']
export type QueueStatus = (typeof QUEUE_STATUSES)[number]
export type RadiusBand = (typeof RADIUS_BANDS)[number]
export type ProviderMetric = 'azure.search' | 'mapbox.map_load'
export type ProviderHealthState = 'healthy' | 'warning' | 'locked'

export interface CoordinatePoint {
  lat: number
  lng: number
}

export interface ProviderUsageStatus {
  provider: ProviderMetric
  label: string
  used: number
  limit: number
  ratio: number
  advisoryAt: number
  elevatedAt: number
  hardStopAt: number
  state: ProviderHealthState
  periodStart: string
  periodEnd: string
  availableAt: string
}

export interface AppLockState {
  isLocked: boolean
  lockedProvider: ProviderMetric | null
  message: string | null
  availableAt: string | null
}

export interface ScoutProfile {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string
}

export interface CoverageBand {
  radiusMiles: RadiusBand
  count: number | null
}

export interface QueueItemNote {
  id: string
  note: string
  createdAt: string
  authorAccessEmail: string | null
}

export interface MediaAsset {
  id: string
  queueItemId: string | null
  poiId: string | null
  url: string
  fileName: string
  contentType: string
  sizeBytes: number
  caption: string | null
  createdAt: string
  metadata: MediaAssetMetadata | null
}

export interface MediaAssetMetadata {
  widthPx: number | null
  heightPx: number | null
  capturedAt: string | null
  capturedLat: number | null
  capturedLng: number | null
  deviceMake: string | null
  deviceModel: string | null
  lensModel: string | null
}

export interface PoiResult {
  id: string
  providerPlaceKey: string
  name: string
  category: PoiCategory
  rawCategories: string[]
  address: string
  lat: number
  lng: number
  distanceMiles: number
  website: string | null
  phone: string | null
  queueItem: QueueItemSummary | null
}

export interface QueueItemSummary {
  id: string
  status: QueueStatus
  distanceMiles: number
  interestReason: string | null
  updatedAt: string
}

export interface QueueItemDetail {
  id: string
  status: QueueStatus
  distanceMiles: number
  interestReason: string | null
  createdAt: string
  updatedAt: string
  poi: PoiResult
  notes: QueueItemNote[]
  media: MediaAsset[]
}

export interface SavedSearchSummary {
  id: string
  scoutProfileId: string
  originLabel: string
  originLat: number
  originLng: number
  radiusMiles: number
  categories: PoiCategory[]
  resultCount: number
  zoomLevel: number | null
  createdAt: string
}

export interface SearchResponse {
  search: SavedSearchSummary
  coverageBands: CoverageBand[]
  results: PoiResult[]
}

export interface CreateScoutPayload {
  displayName: string
}

export interface SearchRequestPayload {
  scoutId: string
  query?: string
  coordinates?: CoordinatePoint
  radiusMiles: number
  categories: PoiCategory[]
  zoom?: number | null
}

export interface SaveQueueItemPayload {
  scoutId: string
  poiId: string
  searchId?: string | null
}

export interface UpdateQueueItemPayload {
  status?: QueueStatus
  note?: string
}

export interface SessionResponse {
  accessEmail: string | null
  appBaseUrl: string
  profiles: ScoutProfile[]
  categories: typeof CATEGORY_DEFINITIONS
  radiusBands: readonly number[]
  mapProvider: 'mapbox'
  providerStatuses: ProviderUsageStatus[]
  lockState: AppLockState
  debugControlsEnabled: boolean
}

export interface MapSessionResponse {
  accessToken: string | null
  styleUrl: string
  providerStatus: ProviderUsageStatus
}

export interface ProviderStatusResponse {
  providerStatuses: ProviderUsageStatus[]
  lockState: AppLockState
}
