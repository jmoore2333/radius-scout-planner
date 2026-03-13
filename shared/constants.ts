export const APP_TITLE = 'Radius Scout'

export const RADIUS_BANDS = [1, 5, 10, 25, 50, 100] as const

export const QUEUE_STATUSES = ['queued', 'visited', 'photographed', 'skipped'] as const

export const CATEGORY_DEFINITIONS = [
  { key: 'hospitals', label: 'Hospitals', description: 'Trauma centers, medical campuses, and hospital systems.' },
  { key: 'schools', label: 'Schools', description: 'K-12 schools and education campuses.' },
  { key: 'malls', label: 'Malls', description: 'Shopping malls and indoor retail clusters.' },
  { key: 'restaurants', label: 'Restaurants', description: 'Sit-down restaurants and dining clusters.' },
  { key: 'coffee_shops', label: 'Coffee Shops', description: 'Cafes and coffee-first venues.' },
  { key: 'movie_theaters', label: 'Movie Theaters', description: 'Cinema and multiplex locations.' },
] as const

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
export const MAX_RESULTS_PER_CATEGORY = 50
export const SMOKE_SCOUT_PREFIX = 'smoke-e2e'
export const PROVIDER_WARNING_FRACTIONS = {
  advisory: 0.8,
  elevated: 0.85,
  hardStop: 0.9,
} as const
export const HUNDRED_MILE_BETA_LIMIT_MESSAGE =
  '100 mi beta searches currently support one category at a time to stay within Cloudflare Worker subrequest limits. Use 50 mi for multi-category scouting.'
