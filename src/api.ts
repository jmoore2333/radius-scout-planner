import type {
  MapSessionResponse,
  ProviderStatusResponse,
  QueueItemDetail,
  SavedSearchSummary,
  ScoutProfile,
  SearchResponse,
  SessionResponse,
} from '@shared/types'

export async function fetchSession(): Promise<SessionResponse> {
  return requestJson<SessionResponse>('/api/session')
}

export async function fetchProviderStatus(): Promise<ProviderStatusResponse> {
  return requestJson<ProviderStatusResponse>('/api/provider-status')
}

export async function createMapSession(): Promise<MapSessionResponse> {
  return requestJson<MapSessionResponse>('/api/map-session', {
    method: 'POST',
  })
}

export async function resetProviderDebugState(): Promise<ProviderStatusResponse> {
  return requestJson<ProviderStatusResponse>('/api/provider-debug/reset', {
    method: 'POST',
  })
}

export async function createScout(name: string): Promise<ScoutProfile> {
  const response = await requestJson<{ profile: ScoutProfile }>('/api/scouts', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })

  return response.profile
}

export async function runSearch(payload: {
  scoutProfileId: string
  originInput?: string
  originLat?: number
  originLng?: number
  radiusMiles: number
  categories: string[]
  zoomLevel?: number | null
}): Promise<SearchResponse> {
  return requestJson<SearchResponse>('/api/searches', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function fetchQueue(scoutProfileId: string): Promise<QueueItemDetail[]> {
  const response = await requestJson<{ queueItems: QueueItemDetail[] }>(`/api/scouts/${scoutProfileId}/queue`)
  return response.queueItems
}

export async function fetchSearchHistory(scoutProfileId: string): Promise<SavedSearchSummary[]> {
  const response = await requestJson<{ searches: SavedSearchSummary[] }>(`/api/scouts/${scoutProfileId}/searches`)
  return response.searches
}

export async function createQueueItem(payload: {
  scoutProfileId: string
  poiId: string
  distanceMiles: number
  interestReason?: string | null
  note?: string
  status?: string
}): Promise<{ queueItemId: string }> {
  return requestJson<{ queueItemId: string }>('/api/queue-items', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function updateQueueItem(queueItemId: string, payload: {
  status?: string
  interestReason?: string | null
  note?: string
}): Promise<void> {
  await requestJson<{ ok: true }>(`/api/queue-items/${queueItemId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export async function uploadMedia(payload: FormData) {
  return requestJson('/api/uploads', {
    method: 'POST',
    body: payload,
    isJson: false,
  })
}

async function requestJson<T>(input: string, init?: RequestInit & { isJson?: boolean }): Promise<T> {
  const headers = new Headers(init?.headers)

  if (init?.body && init.isJson !== false) {
    headers.set('content-type', 'application/json')
  }

  const response = await fetch(input, {
    ...init,
    headers,
  })

  if (!response.ok) {
    let message = `Request failed with ${response.status}`
    const maybeJson = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (maybeJson) {
      const errorValue = maybeJson.error ?? maybeJson.message
      if (typeof errorValue === 'string') {
        message = errorValue
      } else if (errorValue && typeof errorValue === 'object') {
        // Zod validation errors return { issues: [{ message: "..." }, ...] }
        const issues = (errorValue as { issues?: Array<{ message: string }> }).issues
        if (issues?.length) {
          message = issues.map(i => i.message).join('; ')
        }
      }
    }
    throw new Error(message)
  }

  return (await response.json()) as T
}
