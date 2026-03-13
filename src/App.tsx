import { useEffect, useMemo, useState } from 'react'
import { BookOpenText, Camera, CircleDot, Compass, Download, MapPinned, NotebookTabs, PlaneTakeoff, Radar, Search, UploadCloud, UserPlus, X } from 'lucide-react'
import { CATEGORY_DEFINITIONS, HUNDRED_MILE_BETA_LIMIT_MESSAGE, QUEUE_STATUSES, RADIUS_BANDS } from '@shared/constants'
import { formatCoordinate, formatDistanceMiles } from '@shared/format'
import { haversineDistanceMeters, metersToMiles } from '@shared/radius'
import type {
  CoordinatePoint,
  CoverageBand,
  PoiResult,
  ProviderStatusResponse,
  ProviderUsageStatus,
  QueueItemDetail,
  QueueStatus,
  SavedSearchSummary,
  ScoutProfile,
  SearchResponse,
  SessionResponse,
} from '@shared/types'
import {
  createQueueItem,
  createScout,
  fetchProviderStatus,
  fetchQueue,
  fetchSearchHistory,
  fetchSession,
  resetProviderDebugState,
  runSearch,
  updateQueueItem,
  uploadMedia,
} from './api'
import { MapCanvas, clearCachedMapSession, type MapCapturePoint } from './components/MapCanvas'
import './App.css'

const LAST_SCOUT_KEY = 'radius-scout:last-scout-id'
const LAST_ORIGIN_KEY = 'radius-scout:last-origin'
const LAST_RADIUS_KEY = 'radius-scout:last-radius'
const LAST_CATEGORIES_KEY = 'radius-scout:last-categories'

const onboardingSlides = [
  {
    title: 'Radius-first scouting',
    body: 'Start from an address or coordinates, then move through fixed radius bands to see what is inside the flight planning envelope.',
    image: '/onboarding/overview.jpg',
  },
  {
    title: 'Queue and capture',
    body: 'Queue locations, mark what has been photographed, and attach field media so your scouting knowledge compounds over time.',
    image: '/onboarding/queue.jpg',
  },
  {
    title: 'Replay the territory',
    body: 'Reopen saved searches, compare radii, export coordinates, and use the same app as a working field notebook.',
    image: '/onboarding/history.jpg',
  },
] as const

const WEB_RENDERABLE_IMAGE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp', 'image/avif',
])

function isWebRenderableImage(contentType: string): boolean {
  return WEB_RENDERABLE_IMAGE_TYPES.has(contentType.toLowerCase())
}

function MediaPreview({ media }: { media: { url: string; contentType: string; caption: string | null; fileName: string } }) {
  if (isWebRenderableImage(media.contentType)) {
    return <img src={media.url} alt={media.caption ?? media.fileName} loading="lazy" />
  }
  if (media.contentType.startsWith('video/')) {
    return <video controls preload="metadata" src={media.url} />
  }
  return (
    <div className="file-preview-fallback">
      <span className="file-icon">📎</span>
      <span className="file-name">{media.fileName}</span>
    </div>
  )
}

function downloadFile(url: string, filename: string) {
  fetch(url)
    .then(res => res.blob())
    .then(blob => {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = filename
      a.click()
      URL.revokeObjectURL(a.href)
    })
    .catch(() => {
      // Fallback: open in new tab
      window.open(url, '_blank')
    })
}

function App() {
  const [isBootstrapping, setIsBootstrapping] = useState(true)
  const [session, setSession] = useState<SessionResponse | null>(null)
  const [profiles, setProfiles] = useState<ScoutProfile[]>([])
  const [selectedScoutId, setSelectedScoutId] = useState<string | null>(null)
  const [queueItems, setQueueItems] = useState<QueueItemDetail[]>([])
  const [history, setHistory] = useState<SavedSearchSummary[]>([])
  const [originInput, setOriginInput] = useState(localStorage.getItem(LAST_ORIGIN_KEY) ?? '')
  const [selectedRadius, setSelectedRadius] = useState<number>(Number(localStorage.getItem(LAST_RADIUS_KEY) ?? 10))
  const [selectedCategories, setSelectedCategories] = useState<string[]>(
    JSON.parse(localStorage.getItem(LAST_CATEGORIES_KEY) ?? JSON.stringify(['hospitals', 'schools', 'malls'])),
  )
  const [activeSearch, setActiveSearch] = useState<SearchResponse | null>(null)
  const [selectedPoiId, setSelectedPoiId] = useState<string | null>(null)
  const [draftScoutName, setDraftScoutName] = useState('')
  const [draftNote, setDraftNote] = useState('')
  const [draftInterestReason, setDraftInterestReason] = useState('')
  const [statusDraft, setStatusDraft] = useState<QueueStatus>('queued')
  const [message, setMessage] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(false)
  const [mapCenter, setMapCenter] = useState<CoordinatePoint>({ lat: 38.9072, lng: -77.0369 })
  const [mapZoom, setMapZoom] = useState<number | null>(10)
  const [hiddenStatuses, setHiddenStatuses] = useState<Set<QueueStatus>>(new Set(['photographed', 'skipped']))

  useEffect(() => {
    void bootstrap()
  }, [])

  useEffect(() => {
    if (!selectedScoutId) {
      return
    }

    if (session?.lockState.isLocked) {
      return
    }

    localStorage.setItem(LAST_SCOUT_KEY, selectedScoutId)
    setActiveSearch(current => (current?.search.scoutProfileId === selectedScoutId ? current : null))
    setSelectedPoiId(null)
    void loadScoutCollections(selectedScoutId).then(collections => {
      if (!collections) {
        return
      }

      const latestSearch = collections.history[0]

      if (latestSearch) {
        setOriginInput(latestSearch.originLabel)
        setSelectedRadius(latestSearch.radiusMiles)
        setSelectedCategories(latestSearch.categories)
        setMapCenter({ lat: latestSearch.originLat, lng: latestSearch.originLng })
        setMapZoom(latestSearch.zoomLevel ?? 11)
        return
      }

      const firstQueuedPoi = collections.queueItems[0]?.poi
      if (firstQueuedPoi) {
        setMapCenter({ lat: firstQueuedPoi.lat, lng: firstQueuedPoi.lng })
        setMapZoom(13)
      }
    })
  }, [selectedScoutId, session?.lockState.isLocked])

  useEffect(() => {
    localStorage.setItem(LAST_ORIGIN_KEY, originInput)
  }, [originInput])

  useEffect(() => {
    localStorage.setItem(LAST_RADIUS_KEY, String(selectedRadius))
  }, [selectedRadius])

  useEffect(() => {
    localStorage.setItem(LAST_CATEGORIES_KEY, JSON.stringify(selectedCategories))
  }, [selectedCategories])

  const mapPois = useMemo<PoiResult[]>(() => {
    const combined = new Map<string, PoiResult>()

    for (const result of activeSearch?.results ?? []) {
      combined.set(result.id, result)
    }

    for (const item of queueItems) {
      const queueSummary = {
        id: item.id,
        status: item.status,
        distanceMiles: item.distanceMiles,
        interestReason: item.interestReason,
        updatedAt: item.updatedAt,
      }
      const queuePoi: PoiResult = {
        ...item.poi,
        distanceMiles: item.distanceMiles,
        queueItem: queueSummary,
      }
      const existing = combined.get(item.poi.id)

      combined.set(item.poi.id, existing ? { ...existing, queueItem: queueSummary } : queuePoi)
    }

    return [...combined.values()].sort((left, right) => {
      if (left.queueItem && !right.queueItem) {
        return -1
      }

      if (!left.queueItem && right.queueItem) {
        return 1
      }

      return left.distanceMiles - right.distanceMiles
    })
  }, [activeSearch, queueItems])

  const selectedPoi = useMemo(() => {
    if (!selectedPoiId) {
      return null
    }

    return mapPois.find(result => result.id === selectedPoiId) ?? null
  }, [mapPois, selectedPoiId])

  const selectedQueueItem = useMemo(() => {
    if (!selectedPoi) {
      return null
    }

    return queueItems.find(item => item.poi.id === selectedPoi.id) ?? null
  }, [queueItems, selectedPoi])

  const galleryItems = useMemo(
    () =>
      queueItems
        .flatMap(item => item.media.map(media => ({ media, queueItem: item })))
        .sort((left, right) => right.media.createdAt.localeCompare(left.media.createdAt)),
    [queueItems],
  )
  const capturePoints = useMemo<MapCapturePoint[]>(
    () =>
      galleryItems.flatMap(({ media, queueItem }) =>
        media.metadata && media.metadata.capturedLat !== null && media.metadata.capturedLng !== null
          ? [
              {
                id: media.id,
                poiId: queueItem.poi.id,
                poiName: queueItem.poi.name,
                lat: media.metadata.capturedLat,
                lng: media.metadata.capturedLng,
                poiLat: queueItem.poi.lat,
                poiLng: queueItem.poi.lng,
              },
            ]
          : [],
      ),
    [galleryItems],
  )
  const visibleResults = activeSearch?.results.length ? activeSearch.results : mapPois.filter(result => result.queueItem)

  const filteredQueueItems = useMemo(
    () => queueItems.filter(item => !hiddenStatuses.has(item.status)),
    [queueItems, hiddenStatuses],
  )

  const queueSummary = useMemo(
    () =>
      QUEUE_STATUSES.map(status => ({
        status,
        count: queueItems.filter(item => item.status === status).length,
      })),
    [queueItems],
  )
  const isHundredMileCategoryLimited = selectedRadius === 100 && selectedCategories.length > 1
  const providerStatuses = session?.providerStatuses ?? []

  useEffect(() => {
    if (selectedPoiId || !mapPois.length) {
      return
    }

    setSelectedPoiId(mapPois[0].id)
  }, [mapPois, selectedPoiId])

  useEffect(() => {
    if (!selectedPoi) {
      return
    }

    setStatusDraft(selectedQueueItem?.status ?? 'queued')
    setDraftInterestReason(selectedQueueItem?.interestReason ?? '')
    setDraftNote('')
  }, [selectedPoi, selectedQueueItem])

  async function bootstrap() {
    try {
      const response = await fetchSession()
      setSession(response)
      setProfiles(response.profiles)

      const rememberedScoutId = localStorage.getItem(LAST_SCOUT_KEY)
      const initialScout = rememberedScoutId && response.profiles.some(profile => profile.id === rememberedScoutId)
        ? rememberedScoutId
        : response.profiles[0]?.id ?? null

      if (initialScout) {
        setSelectedScoutId(initialScout)
      }
    } catch (error) {
      setMessage((error as Error).message)
    } finally {
      setIsBootstrapping(false)
    }
  }

  async function refreshProviderStatuses() {
    try {
      const response = await fetchProviderStatus()
      applyProviderStatusResponse(response)
    } catch (error) {
      console.warn('Unable to refresh provider status.', error)
    }
  }

  async function handleResetProviderState() {
    try {
      setIsBusy(true)
      const response = await resetProviderDebugState()
      clearCachedMapSession()
      applyProviderStatusResponse(response)
      setMessage('Provider quota state reset for this environment. Reload or open a fresh browser/tab to validate a new map-session count.')
    } catch (error) {
      setMessage((error as Error).message)
    } finally {
      setIsBusy(false)
    }
  }

  function applyProviderStatusResponse(response: ProviderStatusResponse) {
    setSession(current =>
      current
        ? {
            ...current,
            providerStatuses: response.providerStatuses,
            lockState: response.lockState,
          }
        : current,
    )
  }

  async function loadScoutCollections(scoutId: string) {
    try {
      const [nextQueue, nextHistory] = await Promise.all([
        fetchQueue(scoutId),
        fetchSearchHistory(scoutId),
      ])
      setQueueItems(nextQueue)
      setHistory(nextHistory)
      return { queueItems: nextQueue, history: nextHistory }
    } catch (error) {
      setMessage((error as Error).message)
      return null
    }
  }

  async function handleCreateScout() {
    if (!draftScoutName.trim()) {
      return
    }

    try {
      setIsBusy(true)
      const profile = await createScout(draftScoutName.trim())
      setProfiles(previous => mergeProfile(previous, profile))
      setSelectedScoutId(profile.id)
      setDraftScoutName('')
      setMessage(`Scout profile "${profile.name}" is ready.`)
    } catch (error) {
      setMessage((error as Error).message)
    } finally {
      setIsBusy(false)
    }
  }

  async function handleSearch(options?: {
    originOverride?: CoordinatePoint
    radiusMiles?: number
    categories?: string[]
    originValue?: string
    zoomLevel?: number | null
  }) {
    if (!selectedScoutId) {
      setMessage('Create or select a scout profile first.')
      return
    }

    try {
      const originValue = options?.originValue ?? originInput
      const submittedOriginLabel = options?.originValue ?? (!options?.originOverride ? originValue : undefined)
      const radiusMiles = options?.radiusMiles ?? selectedRadius
      const categories = options?.categories ?? selectedCategories

      if (radiusMiles === 100 && categories.length > 1) {
        setMessage(HUNDRED_MILE_BETA_LIMIT_MESSAGE)
        return
      }

      setIsBusy(true)
      const coordinateMatch = parseCoordinateInput(originValue)
      const effectiveLat = options?.originOverride?.lat ?? coordinateMatch?.lat
      const effectiveLng = options?.originOverride?.lng ?? coordinateMatch?.lng
      const useMapFallback = effectiveLat == null && !submittedOriginLabel?.trim()
      const search = await runSearch({
        scoutProfileId: selectedScoutId,
        originInput: submittedOriginLabel?.trim() || undefined,
        originLat: useMapFallback ? mapCenter.lat : effectiveLat,
        originLng: useMapFallback ? mapCenter.lng : effectiveLng,
        radiusMiles,
        categories,
        zoomLevel: options?.zoomLevel ?? mapZoom ?? undefined,
      })

      setActiveSearch(search)
      setSelectedPoiId(search.results[0]?.id ?? null)
      setOriginInput(search.search.originLabel)
      setMapCenter({ lat: search.search.originLat, lng: search.search.originLng })
      await loadScoutCollections(selectedScoutId)
      await refreshProviderStatuses()
      setMessage(`Captured ${search.results.length} POIs within ${search.search.radiusMiles} miles.`)
    } catch (error) {
      setMessage((error as Error).message)
      await refreshProviderStatuses()
    } finally {
      setIsBusy(false)
    }
  }

  async function handleQueueSelectedPoi() {
    if (!selectedScoutId || !selectedPoi) {
      return
    }

    try {
      if (selectedQueueItem) {
        await updateQueueItem(selectedQueueItem.id, {
          status: statusDraft,
          interestReason: draftInterestReason || null,
          note: draftNote || undefined,
        })
      } else {
        await createQueueItem({
          scoutProfileId: selectedScoutId,
          poiId: selectedPoi.id,
          distanceMiles: selectedPoi.distanceMiles,
          interestReason: draftInterestReason || null,
          note: draftNote || undefined,
          status: statusDraft,
        })
      }
      await refreshAfterMutation(selectedScoutId)
      setMessage(
        selectedQueueItem
          ? `${selectedPoi.name} queue details updated.`
          : `${selectedPoi.name} added to the scouting queue.`,
      )
    } catch (error) {
      setMessage((error as Error).message)
    }
  }

  async function handleUpdateQueueItem(queueItemId: string, status: QueueStatus) {
    try {
      await updateQueueItem(queueItemId, { status })
      if (selectedScoutId) {
        await refreshAfterMutation(selectedScoutId)
      }
    } catch (error) {
      setMessage((error as Error).message)
    }
  }

  async function handleUpload(queueItem: QueueItemDetail, fileList: FileList | null) {
    if (!fileList?.length || !selectedScoutId) {
      return
    }

    const files = Array.from(fileList)
    let uploaded = 0
    const errors: string[] = []

    for (const file of files) {
      try {
        const payload = new FormData()
        payload.set('file', file)
        payload.set('scoutProfileId', selectedScoutId)
        payload.set('poiId', queueItem.poi.id)
        payload.set('queueItemId', queueItem.id)
        payload.set('caption', `Uploaded from ${queueItem.poi.name}`)
        await uploadMedia(payload)
        uploaded++
      } catch (error) {
        errors.push(`${file.name}: ${(error as Error).message}`)
      }
    }

    await refreshAfterMutation(selectedScoutId)

    if (errors.length) {
      setMessage(`${uploaded}/${files.length} uploaded. Errors: ${errors.join('; ')}`)
    } else {
      setMessage(`${uploaded} file${uploaded > 1 ? 's' : ''} uploaded to ${queueItem.poi.name}.`)
    }
  }

  async function refreshAfterMutation(scoutId: string) {
    const collections = await loadScoutCollections(scoutId)
    if (!collections) {
      return
    }

    setActiveSearch(current => {
      if (!current) {
        return current
      }

      const queueItemByPoiId = new Map(collections.queueItems.map(item => [item.poi.id, item]))
      return {
        ...current,
        results: current.results.map(result => {
          const queueItem = queueItemByPoiId.get(result.id)
          return {
            ...result,
            queueItem: queueItem
              ? {
                  id: queueItem.id,
                  status: queueItem.status,
                  distanceMiles: queueItem.distanceMiles,
                  interestReason: queueItem.interestReason,
                  updatedAt: queueItem.updatedAt,
                }
              : null,
          }
        }),
      }
    })
  }

  const isLocked = Boolean(session?.lockState.isLocked)

  return (
    <div className="app-shell">
      <div className="ambient-grid" aria-hidden="true" />
      <header className="top-bar">
        <div>
          <p className="eyebrow">Radius Planner / Radius Scout</p>
          <h1>{session?.appBaseUrl ? 'Field knowledge that compounds.' : 'Radius Scout'}</h1>
          <p className="subtitle">
            Search outward from an address, score what matters, and build a reusable scouting plan with coordinates, queue states, and field media.
          </p>
        </div>
        <div className="top-bar-actions">
          <button className="ghost-button onboarding-button" onClick={() => setIsOnboardingOpen(true)} type="button">
            <NotebookTabs size={18} />
            New Here?
          </button>
          <a className="ghost-button" href="/user-manual.html" target="_blank" rel="noreferrer">
            <BookOpenText size={18} />
            User Manual
          </a>
          <div className="access-pill">
            <Radar size={16} />
            {session?.accessEmail ?? 'Protected via Cloudflare Access'}
          </div>
        </div>
      </header>

      {isLocked ? (
        <main className="offline-workspace">
          <section className="panel lock-panel">
            <div className="panel-header">
              <span className="panel-kicker">Offline</span>
              <h2>Provider safety cap reached</h2>
            </div>
            <p className="subtitle">
              {session?.lockState.message
                ?? 'The scouting board is temporarily offline because one of the provider safety caps was reached.'}
            </p>
            <div className="summary-grid">
              <article className="summary-card">
                <span>Locked provider</span>
                <strong>{formatLockedProvider(session?.lockState.lockedProvider ?? null)}</strong>
              </article>
              <article className="summary-card">
                <span>Available again</span>
                <strong>{formatResetTime(session?.lockState.availableAt)}</strong>
              </article>
              <article className="summary-card">
                <span>What still works</span>
                <strong>Manual + docs</strong>
              </article>
            </div>
            <div className="action-row">
              <a className="ghost-button" href="/user-manual.html" target="_blank" rel="noreferrer">
                <BookOpenText size={16} />
                Open manual
              </a>
              <button className="ghost-button onboarding-button" onClick={() => setIsOnboardingOpen(true)} type="button">
                <NotebookTabs size={18} />
                New Here?
              </button>
            </div>
          </section>
          <aside className="detail-column">
            <section className="panel">
              <div className="panel-header">
                <span className="panel-kicker">Settings</span>
                <h2>Provider budget guardrails</h2>
              </div>
              <ProviderBudgetPanel
                providerStatuses={providerStatuses}
                debugControlsEnabled={session?.debugControlsEnabled ?? false}
                isBusy={isBusy}
                onReset={() => void handleResetProviderState()}
              />
            </section>
          </aside>
        </main>
      ) : (
      <main className="workspace">
        <aside className="control-rail">
          <section className="panel">
            <div className="panel-header">
              <span className="panel-kicker">Scouts</span>
              <h2>Field operator</h2>
            </div>
            <label className="field">
              <span>Scout profile</span>
              <select
                data-testid="scout-select"
                value={selectedScoutId ?? ''}
                onChange={event => setSelectedScoutId(event.target.value)}
              >
                <option value="" disabled>
                  Choose a scout
                </option>
                {profiles.map(profile => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="inline-form">
              <input
                data-testid="new-scout-input"
                value={draftScoutName}
                onChange={event => setDraftScoutName(event.target.value)}
                placeholder="Add a new scout name"
              />
              <button aria-label="Create scout" type="button" onClick={() => void handleCreateScout()} disabled={isBusy}>
                <UserPlus size={16} />
              </button>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <span className="panel-kicker">Search</span>
              <h2>Radius-first lookups</h2>
            </div>
            <label className="field">
              <span>Address or coordinates</span>
              <input
                data-testid="origin-input"
                value={originInput}
                onChange={event => setOriginInput(event.target.value)}
                placeholder="1600 Pennsylvania Ave NW, Washington, DC or 38.8977,-77.0365"
              />
            </label>
            <div className="radius-grid" data-testid="radius-grid">
              {RADIUS_BANDS.map(radius => (
                <button
                  key={radius}
                  className={radius === selectedRadius ? 'radius-chip active' : 'radius-chip'}
                  aria-pressed={radius === selectedRadius}
                  type="button"
                  onClick={() => setSelectedRadius(radius)}
                >
                  {formatRadiusLabel(radius)}
                </button>
              ))}
            </div>
            <div className="category-grid">
              {CATEGORY_DEFINITIONS.map(category => {
                const selected = selectedCategories.includes(category.key)

                return (
                  <button
                    key={category.key}
                    className={selected ? 'category-chip active' : 'category-chip'}
                    aria-pressed={selected}
                    type="button"
                    data-testid={`category-${category.key}`}
                    onClick={() =>
                      setSelectedCategories(current =>
                        current.includes(category.key)
                          ? current.filter(item => item !== category.key)
                          : [...current, category.key],
                      )
                    }
                  >
                    <span>{category.label}</span>
                    <small>{category.description}</small>
                  </button>
                )
              })}
            </div>
            {selectedRadius === 100 ? (
              <p className={`search-note ${isHundredMileCategoryLimited ? 'search-note-warning' : ''}`}>
                {isHundredMileCategoryLimited
                  ? HUNDRED_MILE_BETA_LIMIT_MESSAGE
                  : '100 mi beta is intended for broad single-category sweeps. Use 50 mi for wider multi-category planning.'}
              </p>
            ) : null}
            <div className="action-row">
              <button
                className="primary-button"
                type="button"
                data-testid="search-button"
                disabled={isBusy || isHundredMileCategoryLimited}
                onClick={() => void handleSearch()}
              >
                <Search size={16} />
                Search this radius
              </button>
              <button
                className="ghost-button"
                type="button"
                disabled={isBusy || isHundredMileCategoryLimited}
                onClick={() => void handleSearch({ originOverride: mapCenter })}
              >
                <Compass size={16} />
                Use map center
              </button>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <span className="panel-kicker">Coverage</span>
              <h2>What changes by radius</h2>
            </div>
            <CoverageList coverage={activeSearch?.coverageBands ?? []} />
            <div className="summary-grid">
              {queueSummary.map(item => (
                <article key={item.status} className="summary-card">
                  <span>{item.status}</span>
                  <strong>{item.count}</strong>
                </article>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <span className="panel-kicker">Settings</span>
              <h2>Provider budget guardrails</h2>
            </div>
            <ProviderBudgetPanel
              providerStatuses={providerStatuses}
              debugControlsEnabled={session?.debugControlsEnabled ?? false}
              isBusy={isBusy}
              onReset={() => void handleResetProviderState()}
            />
          </section>
        </aside>

        <section className="map-column">
          <div className="map-header panel">
            <div>
              <span className="panel-kicker">Mission board</span>
              <h2>
                {activeSearch?.search.originLabel
                  ?? (queueItems.length ? `${queueItems.length} saved scout pins ready for review` : 'Choose an address or coordinates to start')}
              </h2>
              <p>
                {activeSearch
                  ? `${activeSearch.results.length} POIs inside ${activeSearch.search.radiusMiles} miles`
                  : queueItems.length
                  ? 'Your saved queue items stay pinned to the map so you can reopen the area and continue the story.'
                  : 'Pan the map, switch radii, and use the queue to build a working capture plan.'}
              </p>
            </div>
            <div className="map-header-actions">
              <a
                className="ghost-button"
                href={buildOpenStreetMapUrl(mapCenter, mapZoom)}
                target="_blank"
                rel="noreferrer"
              >
                <Compass size={16} />
                Open in OpenStreetMap
              </a>
              {selectedScoutId ? (
                <>
                  <button className="ghost-button" type="button" onClick={() => downloadFile(`/api/export.csv?scoutProfileId=${selectedScoutId}`, 'scout-export.csv')}>
                    <Download size={16} />
                    CSV
                  </button>
                  <button className="ghost-button" type="button" onClick={() => downloadFile(`/api/export.geojson?scoutProfileId=${selectedScoutId}`, 'scout-export.geojson')}>
                    <MapPinned size={16} />
                    GeoJSON
                  </button>
                </>
              ) : null}
            </div>
          </div>
          <MapCanvas
            isSessionReady={!isBootstrapping}
            lockState={session?.lockState ?? { isLocked: false, lockedProvider: null, message: null, availableAt: null }}
            center={mapCenter}
            zoomLevel={mapZoom}
            radiusMiles={selectedRadius}
            results={mapPois}
            capturePoints={capturePoints}
            selectedPoiId={selectedPoiId}
            onSelectPoi={setSelectedPoiId}
            onCenterChanged={(center, zoom) => {
              setMapCenter(center)
              setMapZoom(zoom)
            }}
            onProviderUsageChanged={() => void refreshProviderStatuses()}
          />

          <section className="panel result-panel">
            <div className="panel-header">
              <span className="panel-kicker">Results</span>
              <h2>Nearest points of interest</h2>
            </div>
            <div className="result-list" data-testid="result-list">
              {visibleResults.length ? (
                visibleResults.map(result => (
                  <button
                    key={result.id}
                    type="button"
                    data-testid={`poi-${result.id}`}
                    className={selectedPoiId === result.id ? 'result-card active' : 'result-card'}
                    onClick={() => {
                      setSelectedPoiId(result.id)
                      setMapCenter({ lat: result.lat, lng: result.lng })
                    }}
                  >
                    <div>
                      <strong>{result.name}</strong>
                      <p>{result.address}</p>
                    </div>
                    <div className="result-meta">
                      <span>{formatDistanceMiles(result.distanceMiles)}</span>
                      <span>{result.category.replace('_', ' ')}</span>
                    </div>
                  </button>
                ))
              ) : (
                <p className="empty-state">Run a search to populate the scouting map.</p>
              )}
            </div>
          </section>
        </section>

        <aside className="detail-column">
          <section className="panel detail-panel">
            <div className="panel-header">
              <span className="panel-kicker">Selected point</span>
              <h2>{selectedPoi?.name ?? 'Choose a POI'}</h2>
            </div>
            {selectedPoi ? (
              <>
                <ul className="detail-list">
                  <li><CircleDot size={16} /> {selectedPoi.category.replace('_', ' ')}</li>
                  <li><Compass size={16} /> {formatDistanceMiles(selectedPoi.distanceMiles)}</li>
                  <li><MapPinned size={16} /> {selectedPoi.address}</li>
                  <li><PlaneTakeoff size={16} /> {formatCoordinate(selectedPoi.lat)}, {formatCoordinate(selectedPoi.lng)}</li>
                </ul>
                <div className="detail-actions">
                  <button className="ghost-button" type="button" onClick={() => navigator.clipboard.writeText(`${selectedPoi.lat}, ${selectedPoi.lng}`)}>
                    Copy coordinates
                  </button>
                  <button className="ghost-button" type="button" onClick={() => navigator.clipboard.writeText(selectedPoi.address)}>
                    Copy address
                  </button>
                </div>
                <div className="field-group">
                  <label className="field">
                    <span>Queue status</span>
                    <select value={statusDraft} onChange={event => setStatusDraft(event.target.value as QueueStatus)}>
                      {QUEUE_STATUSES.map(status => (
                        <option key={status} value={status}>{status}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Why this matters</span>
                    <input value={draftInterestReason} onChange={event => setDraftInterestReason(event.target.value)} placeholder="Helipad, skyline, mall anchor, hospital campus..." />
                  </label>
                  <label className="field">
                    <span>Field note</span>
                    <textarea value={draftNote} onChange={event => setDraftNote(event.target.value)} placeholder="Access observations, line-of-sight, restrictions, alternate angle..." />
                  </label>
                </div>
                <button className="primary-button wide" type="button" data-testid="queue-button" onClick={() => void handleQueueSelectedPoi()}>
                  <Camera size={16} />
                  {selectedQueueItem ? 'Update queue item' : 'Save to queue'}
                </button>
                {selectedQueueItem ? (
                  <div className="detail-story">
                    <div className="detail-story-header">
                      <span className="panel-kicker">Pinned evidence</span>
                      <strong>{selectedQueueItem.media.length} uploads</strong>
                    </div>
                    <div className="detail-badges">
                      <span className={`status-badge status-${selectedQueueItem.status}`}>{selectedQueueItem.status}</span>
                      {selectedQueueItem.interestReason ? <span>{selectedQueueItem.interestReason}</span> : null}
                    </div>
                    {selectedQueueItem.notes.length ? (
                      <div className="note-stack">
                        {selectedQueueItem.notes.slice(0, 3).map(note => (
                          <article key={note.id} className="note-card">
                            <p>{note.note}</p>
                            <small>{new Date(note.createdAt).toLocaleString()}</small>
                          </article>
                        ))}
                      </div>
                    ) : null}
                    {selectedQueueItem.media.length ? (
                      <div className="media-grid">
                        {selectedQueueItem.media.map(media => (
                          <article key={media.id} className="media-card">
                            <MediaPreview media={media} />
                            <div className="media-meta">
                              <strong>{media.caption ?? media.fileName}</strong>
                              <small>{new Date(media.createdAt).toLocaleString()}</small>
                              {formatMediaMetadataSummary(media, selectedQueueItem.poi).length ? (
                                <div className="metadata-chip-row">
                                  {formatMediaMetadataSummary(media, selectedQueueItem.poi).map(item => (
                                    <span key={item} className="metadata-chip">{item}</span>
                                  ))}
                                </div>
                              ) : null}
                              {media.metadata?.capturedLat !== null && media.metadata?.capturedLng !== null ? (
                                <button
                                  className="ghost-button"
                                  type="button"
                                  onClick={() => {
                                    setSelectedPoiId(selectedQueueItem.poi.id)
                                    setMapCenter({ lat: media.metadata!.capturedLat!, lng: media.metadata!.capturedLng! })
                                    setMapZoom(current => Math.max(current ?? 14, 14))
                                  }}
                                >
                                  Show capture
                                </button>
                              ) : null}
                              <a className="ghost-button" href={media.url} target="_blank" rel="noreferrer">
                                Open asset
                              </a>
                            </div>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <p className="empty-state">This saved pin is ready for media, but nothing has been uploaded yet.</p>
                    )}
                  </div>
                ) : null}
              </>
            ) : (
              <p className="empty-state">Results selected from the map or list land here for queueing, copying coordinates, and capture notes.</p>
            )}
          </section>

          <section className="panel detail-panel">
            <div className="panel-header">
              <span className="panel-kicker">Queue</span>
              <h2>What still needs coverage</h2>
            </div>
            <div className="queue-filters" data-testid="queue-filters">
              {QUEUE_STATUSES.map(status => (
                <label key={status} className="queue-filter-toggle">
                  <input
                    type="checkbox"
                    checked={!hiddenStatuses.has(status)}
                    onChange={() => {
                      setHiddenStatuses(prev => {
                        const next = new Set(prev)
                        if (next.has(status)) {
                          next.delete(status)
                        } else {
                          next.add(status)
                        }
                        return next
                      })
                    }}
                  />
                  {status} ({queueSummary.find(s => s.status === status)?.count ?? 0})
                </label>
              ))}
            </div>
            <div className="queue-list" data-testid="queue-list">
              {filteredQueueItems.length ? (
                filteredQueueItems.map(item => (
                  <article
                    key={item.id}
                    className={selectedPoiId === item.poi.id ? 'queue-card queue-card-selected' : 'queue-card'}
                    data-testid={`queue-${item.id}`}
                    onClick={() => {
                      setSelectedPoiId(item.poi.id)
                      setMapCenter({ lat: item.poi.lat, lng: item.poi.lng })
                      setMapZoom(current => current ?? 13)
                    }}
                  >
                    <header>
                      <strong>{item.poi.name}</strong>
                      <select
                        value={item.status}
                        onClick={event => event.stopPropagation()}
                        onChange={event => void handleUpdateQueueItem(item.id, event.target.value as QueueStatus)}
                      >
                        {QUEUE_STATUSES.map(status => (
                          <option key={status} value={status}>{status}</option>
                        ))}
                      </select>
                    </header>
                    <p>{item.poi.address}</p>
                    <div className="queue-meta">
                      <span>{formatDistanceMiles(item.distanceMiles)}</span>
                      <span>{item.notes.length} notes</span>
                      <span>{item.media.length} uploads</span>
                    </div>
                    <label className="upload-button">
                      <UploadCloud size={16} />
                      Upload photo/video
                      <input
                        data-testid={`upload-${item.id}`}
                        type="file"
                        accept="image/*,video/*"
                        multiple
                        onClick={event => event.stopPropagation()}
                        onChange={event => void handleUpload(item, event.target.files)}
                      />
                    </label>
                  </article>
                ))
              ) : (
                <p className="empty-state">
                  {queueItems.length
                    ? `${queueItems.length - filteredQueueItems.length} items hidden by filters.`
                    : 'Queued points show up here with note and upload history.'}
                </p>
              )}
            </div>
          </section>

          <section className="panel detail-panel">
            <div className="panel-header">
              <span className="panel-kicker">Field gallery</span>
              <h2>Attached capture evidence</h2>
            </div>
            <div className="gallery-list">
              {galleryItems.length ? (
                galleryItems.map(({ media, queueItem }) => (
                  <article key={media.id} className="gallery-card">
                    <MediaPreview media={media} />
                    <div className="gallery-card-copy">
                      <strong>{queueItem.poi.name}</strong>
                      <small>{new Date(media.createdAt).toLocaleString()}</small>
                      {formatMediaMetadataSummary(media, queueItem.poi).length ? (
                        <div className="metadata-chip-row">
                          {formatMediaMetadataSummary(media, queueItem.poi).map(item => (
                            <span key={item} className="metadata-chip">{item}</span>
                          ))}
                        </div>
                      ) : null}
                      <div className="gallery-card-actions">
                        <button
                          className="ghost-button"
                          type="button"
                          onClick={() => {
                            setSelectedPoiId(queueItem.poi.id)
                            setMapCenter({ lat: queueItem.poi.lat, lng: queueItem.poi.lng })
                            setMapZoom(current => current ?? 13)
                          }}
                        >
                          Show pin
                        </button>
                        {media.metadata?.capturedLat !== null && media.metadata?.capturedLng !== null ? (
                          <button
                            className="ghost-button"
                            type="button"
                            onClick={() => {
                              setSelectedPoiId(queueItem.poi.id)
                              setMapCenter({ lat: media.metadata!.capturedLat!, lng: media.metadata!.capturedLng! })
                              setMapZoom(current => Math.max(current ?? 14, 14))
                            }}
                          >
                            Show capture
                          </button>
                        ) : null}
                        <a className="ghost-button" href={media.url} target="_blank" rel="noreferrer">
                          Open asset
                        </a>
                      </div>
                    </div>
                  </article>
                ))
              ) : (
                <p className="empty-state">Uploaded photos and videos appear here and can be traced back to their map pins.</p>
              )}
            </div>
          </section>

          <section className="panel detail-panel">
            <div className="panel-header">
              <span className="panel-kicker">Search history</span>
              <h2>Replay prior scouting passes</h2>
            </div>
            <div className="history-list">
              {history.length ? (
                history.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    className="history-card"
                    onClick={() => {
                      setOriginInput(item.originLabel)
                      setSelectedRadius(item.radiusMiles)
                      setSelectedCategories(item.categories)
                      setMapCenter({ lat: item.originLat, lng: item.originLng })
                      setMapZoom(item.zoomLevel)
                      void handleSearch({
                        originOverride: { lat: item.originLat, lng: item.originLng },
                        radiusMiles: item.radiusMiles,
                        categories: item.categories,
                        originValue: item.originLabel,
                        zoomLevel: item.zoomLevel,
                      })
                    }}
                  >
                    <strong>{item.originLabel}</strong>
                    <span>{item.radiusMiles} mi</span>
                    <small>{item.resultCount} POIs</small>
                  </button>
                ))
              ) : (
                <p className="empty-state">Each run becomes a reusable scouting bookmark.</p>
              )}
            </div>
          </section>
        </aside>
      </main>
      )}

      {message ? (
        <div className="toast" role="status">
          {message}
          <button type="button" onClick={() => setMessage(null)}>
            <X size={14} />
          </button>
        </div>
      ) : null}

      {isOnboardingOpen ? (
        <div className="modal-shell" role="dialog" aria-modal="true">
          <div className="modal-card">
            <header className="modal-header">
              <div>
                <p className="panel-kicker">New Here?</p>
                <h2>What this tool is for</h2>
              </div>
              <button className="ghost-button" type="button" onClick={() => setIsOnboardingOpen(false)}>
                <X size={16} />
                Close
              </button>
            </header>
            <div className="onboarding-grid">
              {onboardingSlides.map(slide => (
                <article key={slide.title} className="onboarding-card">
                  <img src={slide.image} alt={slide.title} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                  <div>
                    <strong>{slide.title}</strong>
                    <p>{slide.body}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function CoverageList({ coverage }: { coverage: CoverageBand[] }) {
  return (
    <div className="coverage-list">
      {RADIUS_BANDS.map(radius => {
        const current = coverage.find(item => item.radiusMiles === radius)
        return (
          <article key={radius} className="coverage-card">
            <span>{formatRadiusLabel(radius)}</span>
            <strong>{current?.count ?? '—'}</strong>
          </article>
        )
      })}
    </div>
  )
}

function ProviderStatusPanel({ providerStatuses }: { providerStatuses: ProviderUsageStatus[] }) {
  if (!providerStatuses.length) {
    return <p className="empty-state">Provider usage becomes visible once the session is initialized.</p>
  }

  return (
    <div className="provider-status-list">
      {providerStatuses.map(status => {
        const progress = Math.min(100, Math.round(status.ratio * 100))
        return (
          <article key={status.provider} className="provider-card">
            <div className="provider-card-header">
              <strong>{status.label}</strong>
              <span className={`provider-state provider-state-${status.state}`}>{status.state}</span>
            </div>
            <div className="provider-progress">
              <div className="provider-progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <div className="provider-card-copy">
              <span>{status.used.toLocaleString()} / {status.limit.toLocaleString()}</span>
              <span>Warn at {status.advisoryAt.toLocaleString()} / {status.elevatedAt.toLocaleString()}</span>
              <span>Lock at {status.hardStopAt.toLocaleString()}</span>
              <small>Resets {formatResetTime(status.availableAt)}</small>
            </div>
          </article>
        )
      })}
    </div>
  )
}

function ProviderBudgetPanel({
  providerStatuses,
  debugControlsEnabled,
  isBusy,
  onReset,
}: {
  providerStatuses: ProviderUsageStatus[]
  debugControlsEnabled: boolean
  isBusy: boolean
  onReset: () => void
}) {
  return (
    <>
      <ProviderStatusPanel providerStatuses={providerStatuses} />
      <p className="search-note">
        Warnings begin at 80% and 85%. The full app locks at 90% until the provider billing period resets.
      </p>
      {debugControlsEnabled ? (
        <div className="settings-debug">
          <p className="search-note search-note-warning">
            Debug controls are enabled for this session. Resetting the quota gate clears Durable Object counters and the cached map session for fresh validation.
          </p>
          <button className="ghost-button" type="button" onClick={onReset} disabled={isBusy}>
            Reset provider debug state
          </button>
        </div>
      ) : null}
    </>
  )
}

function parseCoordinateInput(value: string): CoordinatePoint | null {
  const match = value.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/)
  if (!match) {
    return null
  }

  return {
    lat: Number(match[1]),
    lng: Number(match[2]),
  }
}

function mergeProfile(existing: ScoutProfile[], next: ScoutProfile): ScoutProfile[] {
  const known = new Map(existing.map(item => [item.id, item]))
  known.set(next.id, next)
  return [...known.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function formatRadiusLabel(radius: number): string {
  return radius >= 50 ? `${radius} mi (beta)` : `${radius} mi`
}

function formatMediaMetadataSummary(media: QueueItemDetail['media'][number], poi: PoiResult) {
  const metadata = media.metadata
  const summary: string[] = []

  if (metadata?.capturedAt) {
    summary.push(`Captured ${new Date(metadata.capturedAt).toLocaleString()}`)
  }

  if (metadata?.widthPx && metadata.heightPx) {
    summary.push(`${metadata.widthPx}x${metadata.heightPx}`)
  }

  const deviceLabel = [metadata?.deviceMake, metadata?.deviceModel].filter(Boolean).join(' ')
  if (deviceLabel) {
    summary.push(deviceLabel)
  }

  if (metadata && metadata.capturedLat !== null && metadata.capturedLng !== null) {
    const captureDistance = metersToMiles(
      haversineDistanceMeters(
        { lat: metadata.capturedLat, lng: metadata.capturedLng },
        { lat: poi.lat, lng: poi.lng },
      ),
    )

    summary.push(`${formatDistanceMiles(captureDistance)} from saved POI`)
  }

  return summary
}

function formatLockedProvider(provider: SessionResponse['lockState']['lockedProvider']) {
  if (provider === 'azure.search') {
    return 'Azure Maps Search'
  }

  if (provider === 'mapbox.map_load') {
    return 'Mapbox map loads'
  }

  return 'Unknown provider'
}

function formatResetTime(value: string | null | undefined) {
  if (!value) {
    return 'Pending reset'
  }

  return new Date(value).toLocaleString()
}

function buildOpenStreetMapUrl(center: CoordinatePoint, zoomLevel: number | null) {
  const zoom = Math.max(1, Math.min(18, Math.round(zoomLevel ?? 13)))
  return `https://www.openstreetmap.org/?mlat=${center.lat}&mlon=${center.lng}#map=${zoom}/${center.lat}/${center.lng}`
}

export default App
