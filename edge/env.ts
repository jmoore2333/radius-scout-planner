export interface Env {
  APP_NAME: string
  APP_ENV: string
  APP_BASE_URL: string
  AZURE_BILLING_CYCLE_DAY: string
  AZURE_MONTHLY_SEARCH_LIMIT: string
  MAPBOX_BILLING_CYCLE_DAY: string
  MAPBOX_MONTHLY_MAP_LOAD_LIMIT: string
  MAPBOX_STYLE_URL: string
  PROVIDER_MOCKS?: string
  DEBUG_CONTROLS_ENABLED?: string
  DEBUG_ADMIN_EMAILS?: string
  AZURE_MAPS_KEY?: string
  MAPBOX_PUBLIC_TOKEN?: string
  DB: D1Database
  MEDIA_BUCKET: R2Bucket
  ASSETS: Fetcher
  QUOTA_GATE: DurableObjectNamespace
}
