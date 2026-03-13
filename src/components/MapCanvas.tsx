import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppLockState, CoordinatePoint, PoiResult } from '@shared/types'
import { createMapSession } from '../api'

export const MAP_SESSION_CACHE_KEY = 'radius-scout:mapbox-session:v1'
const EMPTY_FEATURE_COLLECTION: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
}

export interface MapCapturePoint {
  id: string
  poiId: string
  poiName: string
  lat: number
  lng: number
  poiLat: number
  poiLng: number
}

interface MapCanvasProps {
  isSessionReady: boolean
  lockState: AppLockState
  center: CoordinatePoint
  zoomLevel: number | null
  radiusMiles: number
  results: PoiResult[]
  capturePoints: MapCapturePoint[]
  selectedPoiId: string | null
  onSelectPoi: (poiId: string) => void
  onCenterChanged: (center: CoordinatePoint, zoom: number | null) => void
  onProviderUsageChanged?: () => void
}

type MapState = 'bootstrapping' | 'loading' | 'ready' | 'failed' | 'missing' | 'locked'

interface CachedMapSession {
  accessToken: string | null
  styleUrl: string
}

type MapDebugWindow = Window & {
  __RADIUS_SCOUT_MAP__?: mapboxgl.Map
}

export function MapCanvas({
  isSessionReady,
  lockState,
  center,
  zoomLevel,
  radiusMiles,
  results,
  capturePoints,
  selectedPoiId,
  onSelectPoi,
  onCenterChanged,
  onProviderUsageChanged,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const suppressViewportSyncRef = useRef(false)
  const onCenterChangedRef = useRef(onCenterChanged)
  const onSelectPoiRef = useRef(onSelectPoi)
  const [mapState, setMapState] = useState<MapState>('bootstrapping')
  const [mapSession, setMapSession] = useState<CachedMapSession | null>(null)
  const queuedPins = useMemo(() => results.filter(result => result.queueItem).slice(0, 6), [results])

  useEffect(() => {
    onCenterChangedRef.current = onCenterChanged
  }, [onCenterChanged])

  useEffect(() => {
    onSelectPoiRef.current = onSelectPoi
  }, [onSelectPoi])

  useEffect(() => {
    if (!isSessionReady) {
      setMapState('bootstrapping')
      return
    }

    if (lockState.isLocked) {
      setMapState('locked')
      return
    }

    if (mapSession) {
      return
    }

    const cached = readCachedMapSession()
    if (cached) {
      setMapSession(cached)
      setMapState(cached.accessToken ? 'loading' : 'missing')
      return
    }

    let cancelled = false
    setMapState('loading')

    void (async () => {
      try {
        const response = await createMapSession()
        if (cancelled) {
          return
        }

        const nextSession = {
          accessToken: response.accessToken,
          styleUrl: response.styleUrl,
        }

        if (response.accessToken) {
          sessionStorage.setItem(MAP_SESSION_CACHE_KEY, JSON.stringify(nextSession))
        }

        setMapSession(nextSession)
        setMapState(response.accessToken ? 'loading' : 'missing')
        onProviderUsageChanged?.()
      } catch (error) {
        console.error(error)
        if (cancelled) {
          return
        }

        setMapState(lockState.isLocked ? 'locked' : 'failed')
        onProviderUsageChanged?.()
      }
    })()

    return () => {
      cancelled = true
    }
  }, [isSessionReady, lockState.isLocked, mapSession, onProviderUsageChanged])

  useEffect(() => {
    if (!containerRef.current || !mapSession?.accessToken || !mapSession.styleUrl || lockState.isLocked) {
      return
    }

    let cancelled = false
    suppressViewportSyncRef.current = true

    let map: mapboxgl.Map
    try {
      map = new mapboxgl.Map({
        accessToken: mapSession.accessToken,
        container: containerRef.current,
        style: mapSession.styleUrl,
        center: [center.lng, center.lat],
        zoom: zoomLevel ?? 10,
        pitchWithRotate: false,
        attributionControl: false,
      })
    } catch (error) {
      console.error('Map initialization failed (WebGL may be unavailable):', error)
      setMapState('failed')
      return
    }

    mapRef.current = map
    ;(window as MapDebugWindow).__RADIUS_SCOUT_MAP__ = map
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right')

    const handleMoveEnd = () => {
      if (suppressViewportSyncRef.current) {
        suppressViewportSyncRef.current = false
        return
      }

      const mapCenter = map.getCenter()
      onCenterChangedRef.current(
        {
          lat: mapCenter.lat,
          lng: mapCenter.lng,
        },
        Math.round(map.getZoom()),
      )
    }

    const setPointerCursor = (cursor: string) => {
      map.getCanvas().style.cursor = cursor
    }

    map.on('moveend', handleMoveEnd)
    map.on('load', () => {
      if (cancelled) {
        return
      }

      initializeMapSources(map)
      bindMapInteractions(map, onSelectPoiRef, suppressViewportSyncRef)
      map.on('mouseenter', 'clusters', () => setPointerCursor('pointer'))
      map.on('mouseleave', 'clusters', () => setPointerCursor(''))
      map.on('mouseenter', 'poi-points', () => setPointerCursor('pointer'))
      map.on('mouseleave', 'poi-points', () => setPointerCursor(''))
      map.on('mouseenter', 'capture-points', () => setPointerCursor('pointer'))
      map.on('mouseleave', 'capture-points', () => setPointerCursor(''))
      setMapState('ready')
    })
    map.on('error', event => {
      if (!cancelled) {
        console.error(event.error)
      }
    })

    if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
      resizeObserverRef.current = new ResizeObserver(() => {
        map.resize()
      })
      resizeObserverRef.current.observe(containerRef.current)
    }

    return () => {
      cancelled = true
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
      delete (window as MapDebugWindow).__RADIUS_SCOUT_MAP__
      map.remove()
      mapRef.current = null
    }
  }, [lockState.isLocked, mapSession?.accessToken, mapSession?.styleUrl])

  useEffect(() => {
    if (!mapRef.current || mapState !== 'ready') {
      return
    }

    syncMapSources(mapRef.current, center, radiusMiles, results, capturePoints, selectedPoiId)
  }, [center, radiusMiles, results, capturePoints, selectedPoiId, mapState])

  useEffect(() => {
    if (!mapRef.current || mapState !== 'ready') {
      return
    }

    const currentCenter = mapRef.current.getCenter()
    if (!coordinatesDiffer(center, { lat: currentCenter.lat, lng: currentCenter.lng })) {
      return
    }

    suppressViewportSyncRef.current = true
    mapRef.current.easeTo({
      center: [center.lng, center.lat],
      duration: 400,
      zoom: zoomLevel ?? mapRef.current.getZoom(),
    })
  }, [center, mapState, zoomLevel])

  useEffect(() => {
    if (!mapRef.current || mapState !== 'ready' || zoomLevel === null) {
      return
    }

    if (Math.round(mapRef.current.getZoom()) === zoomLevel) {
      return
    }

    suppressViewportSyncRef.current = true
    mapRef.current.easeTo({ zoom: zoomLevel, duration: 300 })
  }, [mapState, zoomLevel])

  const fallbackMessage = mapState === 'loading'
    ? 'Loading Mapbox mission map...'
    : mapState === 'bootstrapping'
      ? 'Loading workspace and map session...'
      : mapState === 'locked'
        ? lockState.message ?? 'Map access is paused until the provider safety cap resets.'
        : mapSession?.accessToken
          ? 'Mapbox preview is unavailable right now. The radar scope still shows every POI relative to your selected center.'
          : 'Mapbox token unavailable. Search and queue workflows still load, and the radar scope still shows every POI relative to your selected center.'

  return (
    <div className="map-shell" data-testid="map-shell" role="region" aria-label="Map">
      <div className={mapState === 'ready' ? 'map-canvas' : 'map-canvas map-canvas-hidden'} ref={containerRef} />
      {mapState === 'ready' && results.length > 12 ? (
        <div className="map-overlay-note">
          <p>Dense areas cluster automatically. Click a cluster to zoom in, or use the result list to isolate a pin.</p>
          <button
            className="map-chip"
            type="button"
            onClick={() => {
              if (!mapRef.current) {
                return
              }

              suppressViewportSyncRef.current = true
              mapRef.current.easeTo({
                center: [center.lng, center.lat],
                zoom: Math.max((zoomLevel ?? Math.round(mapRef.current.getZoom())) + 2, 12),
                duration: 350,
              })
            }}
          >
            {results.length} clustered points of interest
          </button>
        </div>
      ) : null}
      {mapState === 'ready' && queuedPins.length ? (
        <div className="map-overlay-actions">
          {queuedPins.map(result => (
            <button
              key={result.id}
              className={selectedPoiId === result.id ? 'map-chip active' : 'map-chip'}
              type="button"
              onClick={() => {
                suppressViewportSyncRef.current = true
                mapRef.current?.easeTo({
                  center: [result.lng, result.lat],
                  zoom: Math.max(mapRef.current?.getZoom() ?? 13, 13),
                  duration: 350,
                })
                onSelectPoi(result.id)
              }}
            >
              {result.name}
            </button>
          ))}
        </div>
      ) : null}
      {mapState !== 'ready' ? (
        <FallbackRadarMap
          center={center}
          radiusMiles={radiusMiles}
          results={results}
          selectedPoiId={selectedPoiId}
          onSelectPoi={onSelectPoi}
          message={fallbackMessage}
        />
      ) : null}
    </div>
  )
}

function initializeMapSources(map: mapboxgl.Map) {
  if (map.getSource('radius')) {
    return
  }

  map.addSource('radius', {
    type: 'geojson',
    data: EMPTY_FEATURE_COLLECTION,
  })
  map.addSource('search-center', {
    type: 'geojson',
    data: EMPTY_FEATURE_COLLECTION,
  })
  map.addSource('pois', {
    type: 'geojson',
    data: EMPTY_FEATURE_COLLECTION,
    cluster: true,
    clusterMaxZoom: 13,
    clusterRadius: 55,
  })
  map.addSource('selected-poi', {
    type: 'geojson',
    data: EMPTY_FEATURE_COLLECTION,
  })
  map.addSource('capture-links', {
    type: 'geojson',
    data: EMPTY_FEATURE_COLLECTION,
  })
  map.addSource('captures', {
    type: 'geojson',
    data: EMPTY_FEATURE_COLLECTION,
  })

  map.addLayer({
    id: 'radius-fill',
    type: 'fill',
    source: 'radius',
    paint: {
      'fill-color': '#f2b84b',
      'fill-opacity': 0.1,
    },
  })
  map.addLayer({
    id: 'radius-outline',
    type: 'line',
    source: 'radius',
    paint: {
      'line-color': '#f2b84b',
      'line-opacity': 0.88,
      'line-width': 2,
    },
  })
  map.addLayer({
    id: 'capture-links',
    type: 'line',
    source: 'capture-links',
    paint: {
      'line-color': '#63b8db',
      'line-width': 2,
      'line-opacity': 0.72,
      'line-dasharray': [2, 2],
    },
  })
  map.addLayer({
    id: 'clusters',
    type: 'circle',
    source: 'pois',
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': [
        'step',
        ['get', 'point_count'],
        '#63b8db',
        12,
        '#8fd1ff',
        24,
        '#f2b84b',
      ],
      'circle-radius': [
        'step',
        ['get', 'point_count'],
        22,
        12,
        28,
        24,
        34,
      ],
      'circle-stroke-color': '#08111d',
      'circle-stroke-width': 2,
    },
  })
  map.addLayer({
    id: 'cluster-count',
    type: 'symbol',
    source: 'pois',
    filter: ['has', 'point_count'],
    layout: {
      'text-field': ['get', 'point_count_abbreviated'],
      'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
      'text-size': 13,
    },
    paint: {
      'text-color': '#08111d',
    },
  })
  map.addLayer({
    id: 'poi-points',
    type: 'circle',
    source: 'pois',
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': [
        'match',
        ['coalesce', ['get', 'queueStatus'], ''],
        'photographed',
        '#31c48d',
        'visited',
        '#63b8db',
        'skipped',
        '#69768b',
        'queued',
        '#f2b84b',
        '#f2b84b',
      ],
      'circle-radius': 8,
      'circle-stroke-color': '#08111d',
      'circle-stroke-width': 2,
    },
  })
  map.addLayer({
    id: 'selected-poi-ring',
    type: 'circle',
    source: 'selected-poi',
    paint: {
      'circle-color': 'rgba(0, 0, 0, 0)',
      'circle-radius': 13,
      'circle-stroke-color': '#f2b84b',
      'circle-stroke-width': 3,
    },
  })
  map.addLayer({
    id: 'capture-points',
    type: 'circle',
    source: 'captures',
    paint: {
      'circle-color': [
        'case',
        ['==', ['get', 'selected'], true],
        '#31c48d',
        '#63b8db',
      ],
      'circle-radius': 6,
      'circle-stroke-color': '#08111d',
      'circle-stroke-width': 2,
    },
  })
  map.addLayer({
    id: 'search-center',
    type: 'circle',
    source: 'search-center',
    paint: {
      'circle-color': '#08111d',
      'circle-radius': 6,
      'circle-stroke-color': '#f2b84b',
      'circle-stroke-width': 3,
    },
  })
}

function bindMapInteractions(
  map: mapboxgl.Map,
  onSelectPoiRef: React.MutableRefObject<(poiId: string) => void>,
  suppressViewportSyncRef: React.MutableRefObject<boolean>,
) {
  map.on('click', 'clusters', event => {
    const feature = event.features?.[0]
    if (!feature) {
      return
    }

    const clusterId = feature.properties?.cluster_id
    if (typeof clusterId !== 'number') {
      return
    }

    const source = map.getSource('pois') as mapboxgl.GeoJSONSource | undefined
    if (!source) {
      return
    }

    source.getClusterExpansionZoom(clusterId, (error, zoom) => {
      if (error) {
        console.error(error)
        return
      }

      if (feature.geometry.type !== 'Point') {
        return
      }

      suppressViewportSyncRef.current = true
      map.easeTo({
        center: feature.geometry.coordinates as [number, number],
        zoom: zoom ?? map.getZoom(),
      })
    })
  })

  map.on('click', 'poi-points', event => {
    const poiId = readFeatureProperty(event.features?.[0], 'id')
    if (poiId) {
      onSelectPoiRef.current(poiId)
    }
  })

  map.on('click', 'capture-points', event => {
    const poiId = readFeatureProperty(event.features?.[0], 'poiId')
    if (poiId) {
      onSelectPoiRef.current(poiId)
    }
  })
}

function syncMapSources(
  map: mapboxgl.Map,
  center: CoordinatePoint,
  radiusMiles: number,
  results: PoiResult[],
  capturePoints: MapCapturePoint[],
  selectedPoiId: string | null,
) {
  setSourceData(map, 'radius', buildRadiusFeatureCollection(center, radiusMiles))
  setSourceData(map, 'search-center', buildCenterFeatureCollection(center))
  setSourceData(map, 'pois', buildPoiFeatureCollection(results))
  setSourceData(map, 'selected-poi', buildSelectedPoiFeatureCollection(results, selectedPoiId))
  setSourceData(map, 'captures', buildCaptureFeatureCollection(capturePoints, selectedPoiId))
  setSourceData(map, 'capture-links', buildCaptureLineFeatureCollection(capturePoints, selectedPoiId))
}

function setSourceData(map: mapboxgl.Map, sourceId: string, data: GeoJSON.FeatureCollection) {
  const source = map.getSource(sourceId) as mapboxgl.GeoJSONSource | undefined
  source?.setData(data)
}

function buildPoiFeatureCollection(results: PoiResult[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: results.map(result => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [result.lng, result.lat],
      },
      properties: {
        id: result.id,
        name: result.name,
        category: result.category,
        queueStatus: result.queueItem?.status ?? '',
      },
    })),
  }
}

function buildSelectedPoiFeatureCollection(results: PoiResult[], selectedPoiId: string | null): GeoJSON.FeatureCollection {
  const selected = results.find(result => result.id === selectedPoiId)
  if (!selected) {
    return EMPTY_FEATURE_COLLECTION
  }

  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [selected.lng, selected.lat],
        },
        properties: {
          id: selected.id,
        },
      },
    ],
  }
}

function buildCaptureFeatureCollection(capturePoints: MapCapturePoint[], selectedPoiId: string | null): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: capturePoints.map(point => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [point.lng, point.lat],
      },
      properties: {
        id: point.id,
        poiId: point.poiId,
        poiName: point.poiName,
        selected: point.poiId === selectedPoiId,
      },
    })),
  }
}

function buildCaptureLineFeatureCollection(capturePoints: MapCapturePoint[], selectedPoiId: string | null): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: capturePoints
      .filter(point => point.poiId === selectedPoiId)
      .map(point => ({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [point.lng, point.lat],
            [point.poiLng, point.poiLat],
          ],
        },
        properties: {
          id: point.id,
          poiId: point.poiId,
        },
      })),
  }
}

function buildCenterFeatureCollection(center: CoordinatePoint): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [center.lng, center.lat],
        },
        properties: {
          role: 'center',
        },
      },
    ],
  }
}

function buildRadiusFeatureCollection(center: CoordinatePoint, radiusMiles: number): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [buildCircleCoordinates(center, radiusMiles)],
        },
        properties: {
          radiusMiles,
        },
      },
    ],
  }
}

function buildCircleCoordinates(center: CoordinatePoint, radiusMiles: number, steps = 96): [number, number][] {
  const earthRadiusMeters = 6_371_000
  const angularDistance = (radiusMiles * 1609.344) / earthRadiusMeters
  const lat = degreesToRadians(center.lat)
  const lng = degreesToRadians(center.lng)
  const points: [number, number][] = []

  for (let step = 0; step <= steps; step += 1) {
    const bearing = (step / steps) * Math.PI * 2
    const nextLat = Math.asin(
      Math.sin(lat) * Math.cos(angularDistance) +
        Math.cos(lat) * Math.sin(angularDistance) * Math.cos(bearing),
    )
    const nextLng =
      lng +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat),
        Math.cos(angularDistance) - Math.sin(lat) * Math.sin(nextLat),
      )

    points.push([radiansToDegrees(nextLng), radiansToDegrees(nextLat)])
  }

  return points
}

function degreesToRadians(value: number) {
  return (value * Math.PI) / 180
}

function radiansToDegrees(value: number) {
  return (value * 180) / Math.PI
}

function readFeatureProperty(feature: mapboxgl.MapboxGeoJSONFeature | undefined, key: string) {
  const value = feature?.properties?.[key]
  return typeof value === 'string' ? value : null
}

function readCachedMapSession(): CachedMapSession | null {
  try {
    const raw = sessionStorage.getItem(MAP_SESSION_CACHE_KEY)
    if (!raw) {
      return null
    }

    const parsed = JSON.parse(raw) as CachedMapSession
    if (typeof parsed.styleUrl !== 'string') {
      return null
    }

    return {
      accessToken: typeof parsed.accessToken === 'string' ? parsed.accessToken : null,
      styleUrl: parsed.styleUrl,
    }
  } catch (error) {
    console.warn('Unable to parse cached Mapbox session.', error)
    return null
  }
}

export function clearCachedMapSession() {
  try {
    sessionStorage.removeItem(MAP_SESSION_CACHE_KEY)
  } catch (error) {
    console.warn('Unable to clear cached Mapbox session.', error)
  }
}

function coordinatesDiffer(left: CoordinatePoint, right: CoordinatePoint) {
  return Math.abs(left.lat - right.lat) > 0.000001 || Math.abs(left.lng - right.lng) > 0.000001
}

function FallbackRadarMap({
  center,
  radiusMiles,
  results,
  selectedPoiId,
  onSelectPoi,
  message,
}: {
  center: CoordinatePoint
  radiusMiles: number
  results: PoiResult[]
  selectedPoiId: string | null
  onSelectPoi: (poiId: string) => void
  message: string
}) {
  const radiusScale = 42
  const visiblePoints = results
    .map(result => {
      const latMiles = (result.lat - center.lat) * 69
      const lngMiles = (result.lng - center.lng) * Math.max(Math.cos((center.lat * Math.PI) / 180) * 69, 15)
      const x = 50 + (lngMiles / radiusMiles) * radiusScale
      const y = 50 - (latMiles / radiusMiles) * radiusScale

      return {
        result,
        x,
        y,
        visible: x >= 4 && x <= 96 && y >= 4 && y <= 96,
      }
    })
    .filter(point => point.visible)
    .slice(0, 120)

  return (
    <div className="map-placeholder radar-map">
      <div className="map-placeholder-copy">
        <p>{message}</p>
        <small>{results.length} captured POIs plotted inside the current {radiusMiles} mile search radius.</small>
      </div>
      <div className="radar-scope" role="img" aria-label={`Fallback radar view with ${visiblePoints.length} mapped points`}>
        <div className="radar-ring radar-ring-outer" />
        <div className="radar-ring radar-ring-mid" />
        <div className="radar-ring radar-ring-inner" />
        <div className="radar-crosshair radar-crosshair-horizontal" />
        <div className="radar-crosshair radar-crosshair-vertical" />
        <button className="radar-origin" type="button" aria-label="Search center">
          <span />
        </button>
        {visiblePoints.map(point => (
          <button
            key={point.result.id}
            className={point.result.id === selectedPoiId ? 'radar-point active' : 'radar-point'}
            style={{ left: `${point.x}%`, top: `${point.y}%` }}
            type="button"
            title={`${point.result.name} · ${point.result.distanceMiles.toFixed(1)} mi`}
            onClick={() => onSelectPoi(point.result.id)}
          >
            <span />
          </button>
        ))}
      </div>
    </div>
  )
}
