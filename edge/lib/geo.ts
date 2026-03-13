import { MAX_RESULTS_PER_CATEGORY, RADIUS_BANDS } from '../../shared/constants'
import { haversineDistanceMeters, metersToMiles, milesToMeters, type Coordinates } from '../../shared/radius'
import type { CoverageBand, PoiCategory, PoiResult, QueueItemSummary } from '../../shared/types'
import type { Env } from '../env'
import { getAzureCategoryQuery } from './categories'
import { requireProviderUnits } from './provider-quota'
import lancasterPaFixture from '../../tests/fixtures/lancaster-pa.json'
import washingtonDcFixture from '../../tests/fixtures/washington-dc.json'
import newYorkNyFixture from '../../tests/fixtures/new-york-ny.json'
import scrantonPaFixture from '../../tests/fixtures/scranton-pa.json'
import ruralMontanaFixture from '../../tests/fixtures/rural-montana.json'
import suburbanBoiseFixture from '../../tests/fixtures/suburban-boise.json'
import emptyResultsFixture from '../../tests/fixtures/empty-results.json'

const AZURE_MAPS_BASE_URL = 'https://atlas.microsoft.com'
const AZURE_API_VERSION = '1.0'

interface GeocodeResult extends Coordinates {
  label: string
}

interface AzureAddress {
  freeformAddress?: string
  municipality?: string
  countrySubdivision?: string
}

interface AzurePoi {
  name?: string
  categories?: string[]
  phone?: string
  url?: string
}

interface AzurePosition {
  lat: number
  lon: number
}

interface AzureResult {
  id?: string
  dist?: number
  address?: AzureAddress
  poi?: AzurePoi
  position?: AzurePosition
}

interface AzureSearchResponse {
  results?: AzureResult[]
}

export interface SearchCandidate {
  provider: 'azure'
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
  sourceTags: Record<string, string>
}

interface MockFixture {
  label: string
  center: Coordinates
  matches: string[]
  points: Array<Omit<SearchCandidate, 'provider' | 'providerPlaceKey' | 'distanceMiles'> & { key: string }>
}

const MOCK_FIXTURES: MockFixture[] = [
  lancasterPaFixture,
  washingtonDcFixture,
  newYorkNyFixture,
  scrantonPaFixture,
  ruralMontanaFixture,
  suburbanBoiseFixture,
  emptyResultsFixture,
] as MockFixture[]

export async function geocodeInput(env: Env, input: string): Promise<GeocodeResult> {
  if (isProviderMockMode(env)) {
    return mockGeocode(input)
  }

  await requireProviderUnits(env, 'azure.search', 1, 'geocode', { input })

  const url = new URL('/search/address/json', AZURE_MAPS_BASE_URL)
  url.searchParams.set('api-version', AZURE_API_VERSION)
  url.searchParams.set('query', input)
  url.searchParams.set('limit', '1')
  url.searchParams.set('subscription-key', env.AZURE_MAPS_KEY ?? '')

  const payload = await fetchAzureJson<AzureSearchResponse>(url.toString(), 'Azure geocoding')
  const result = payload.results?.[0]

  if (!result?.position) {
    throw new Error('No matching address found.')
  }

  return {
    label: result.address?.freeformAddress ?? input,
    lat: result.position.lat,
    lng: result.position.lon,
  }
}

export async function queryPoisWithinRadius(
  env: Env,
  center: Coordinates,
  radiusMiles: number,
  categories: PoiCategory[],
): Promise<SearchCandidate[]> {
  if (isProviderMockMode(env)) {
    return mockQuery(center, radiusMiles, categories)
  }

  const combined = new Map<string, SearchCandidate>()

  for (const category of categories) {
    await requireProviderUnits(env, 'azure.search', 1, 'poi-search', {
      category,
      radiusMiles,
      lat: center.lat,
      lng: center.lng,
    })

    const url = new URL('/search/poi/category/json', AZURE_MAPS_BASE_URL)
    url.searchParams.set('api-version', AZURE_API_VERSION)
    url.searchParams.set('query', getAzureCategoryQuery(category))
    url.searchParams.set('lat', String(center.lat))
    url.searchParams.set('lon', String(center.lng))
    url.searchParams.set('radius', String(Math.round(milesToMeters(radiusMiles))))
    url.searchParams.set('limit', String(MAX_RESULTS_PER_CATEGORY))
    url.searchParams.set('subscription-key', env.AZURE_MAPS_KEY ?? '')

    const payload = await fetchAzureJson<AzureSearchResponse>(url.toString(), `Azure POI search (${category})`)

    for (const result of payload.results ?? []) {
      if (!result.position) {
        continue
      }

      const coordinates = { lat: result.position.lat, lng: result.position.lon }
      const distanceMiles = metersToMiles(haversineDistanceMeters(center, coordinates))

      if (distanceMiles > radiusMiles) {
        continue
      }

      const candidate = mapAzureResultToCandidate(result, category, distanceMiles)
      const existing = combined.get(candidate.providerPlaceKey)

      if (!existing || existing.distanceMiles > candidate.distanceMiles) {
        combined.set(candidate.providerPlaceKey, candidate)
      }
    }
  }

  return [...combined.values()].sort((left, right) => left.distanceMiles - right.distanceMiles)
}

export async function buildCoverageBands(
  env: Env,
  _center: Coordinates,
  activeRadiusMiles: number,
  _categories: PoiCategory[],
  results: SearchCandidate[],
): Promise<CoverageBand[]> {
  void env
  return RADIUS_BANDS.map(radiusMiles => ({
    radiusMiles,
    count: radiusMiles > activeRadiusMiles ? null : results.filter(result => result.distanceMiles <= radiusMiles).length,
  }))
}

export function mergeQueueState(
  results: SearchCandidate[],
  queueStateByPoiId: Map<string, QueueItemSummary>,
  poiIdByProviderPlaceKey: Map<string, string>,
): PoiResult[] {
  return results.map(result => {
    const poiId = poiIdByProviderPlaceKey.get(result.providerPlaceKey)

    return {
      id: poiId ?? result.providerPlaceKey,
      providerPlaceKey: result.providerPlaceKey,
      name: result.name,
      category: result.category,
      rawCategories: result.rawCategories,
      address: result.address,
      lat: result.lat,
      lng: result.lng,
      distanceMiles: result.distanceMiles,
      website: result.website,
      phone: result.phone,
      queueItem: poiId ? queueStateByPoiId.get(poiId) ?? null : null,
    }
  })
}

async function fetchAzureJson<T>(url: string, description: string): Promise<T> {
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`${description} failed with ${response.status}: ${await response.text()}`)
  }

  return (await response.json()) as T
}

function mapAzureResultToCandidate(result: AzureResult, category: PoiCategory, distanceMiles: number): SearchCandidate {
  return {
    provider: 'azure',
    providerPlaceKey: `azure:${result.id ?? crypto.randomUUID()}`,
    name: result.poi?.name ?? result.address?.freeformAddress ?? `Unnamed ${category.replace('_', ' ')}`,
    category,
    rawCategories: result.poi?.categories ?? [],
    address: result.address?.freeformAddress ?? 'Address unavailable',
    lat: result.position?.lat ?? 0,
    lng: result.position?.lon ?? 0,
    distanceMiles,
    website: result.poi?.url ?? null,
    phone: result.poi?.phone ?? null,
    sourceTags: {
      azure_result_id: result.id ?? '',
      ...(result.poi?.categories ?? []).reduce<Record<string, string>>((accumulator, value, index) => {
        accumulator[`category_${index}`] = value
        return accumulator
      }, {}),
    },
  }
}

function isProviderMockMode(env: Env) {
  return env.PROVIDER_MOCKS === '1' || (!env.AZURE_MAPS_KEY && env.APP_ENV !== 'production')
}

function mockGeocode(input: string): GeocodeResult {
  const normalized = input.trim().toLowerCase()
  const fixture = MOCK_FIXTURES.find(candidate => candidate.matches.some(match => normalized.includes(match)))

  if (fixture) {
    return {
      label: fixture.label,
      lat: fixture.center.lat,
      lng: fixture.center.lng,
    }
  }

  return {
    label: input,
    lat: 38.9072,
    lng: -77.0369,
  }
}

function mockQuery(center: Coordinates, radiusMiles: number, categories: PoiCategory[]): SearchCandidate[] {
  const fixture = closestFixture(center)
  const basePoints = fixture?.points ?? buildGenericMockPoints(center)

  return basePoints
    .filter(point => categories.includes(point.category))
    .map(point => {
      const coordinates = { lat: point.lat, lng: point.lng }
      const distanceMiles = metersToMiles(haversineDistanceMeters(center, coordinates))

      return {
        ...point,
        provider: 'azure' as const,
        providerPlaceKey: `azure:${point.key}`,
        distanceMiles,
      }
    })
    .filter(point => point.distanceMiles <= radiusMiles)
    .sort((left, right) => left.distanceMiles - right.distanceMiles)
}

function closestFixture(center: Coordinates) {
  return MOCK_FIXTURES
    .map(fixture => ({
      fixture,
      distance: haversineDistanceMeters(center, fixture.center),
    }))
    .sort((left, right) => left.distance - right.distance)[0]?.fixture
}

function buildGenericMockPoints(center: Coordinates) {
  const rows: MockFixture['points'] = []
  const categories: PoiCategory[] = ['hospitals', 'schools', 'malls', 'restaurants', 'coffee_shops', 'movie_theaters']
  let index = 0

  for (const category of categories) {
    for (let offset = 1; offset <= 4; offset += 1) {
      index += 1
      rows.push(
        mockPoint(
          `${category}-${offset}`,
          `${category.replaceAll('_', ' ')} mock ${offset}`,
          category,
          center.lat + offset * 0.01,
          center.lng - offset * 0.01,
          `${offset} Mock St`,
        ),
      )
    }
  }

  return rows
}

function mockPoint(
  key: string,
  name: string,
  category: PoiCategory,
  lat: number | string,
  lng: number,
  address: string,
): Omit<SearchCandidate, 'provider' | 'providerPlaceKey' | 'distanceMiles'> & { key: string } {
  return {
    key,
    name,
    category,
    rawCategories: [category],
    address,
    lat: Number(lat),
    lng,
    website: null,
    phone: null,
    sourceTags: {
      mock: 'true',
      category,
    },
  }
}
