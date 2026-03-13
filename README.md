# Radius Scout

Radius-based area research and POI indexing tool.

Radius Scout helps you systematically research any area by searching for points of interest within configurable radius bands, managing a queue of locations to visit, and collecting photos and data at each stop. Built for individuals and small teams who need to catalog what exists in an area -- whether for site surveys, market research, logistics planning, or field documentation.

**Use cases:**

- Researching areas of interest around a target address or coordinate
- Logging photos and data points that need to be captured at specific locations
- Building a searchable index around known POIs in any area
- Multi-user support for teams coordinating field visits


## Feature Highlights

- **Radius band search** -- search in 1, 5, 10, 25, 50, and 100 mile bands from any origin
- **Category-based POI discovery** -- hospitals, schools, malls, restaurants, coffee shops, movie theaters
- **Queue management with statuses** -- track each POI as queued, visited, photographed, or skipped
- **Photo/video uploads with automatic EXIF metadata extraction** -- GPS coordinates, capture time, and device info are pulled from uploaded media
- **CSV and GeoJSON export** for team handoff and external tooling
- **Provider quota guardrails** to stay within free tiers (warnings at 80%, automatic lockout at 90%)
- **Multi-user support** via Cloudflare Access -- each team member gets their own scout profile


## Architecture Overview

**Stack:**

| Layer | Technology |
|---|---|
| API server | Cloudflare Workers (Hono framework) |
| Database | Cloudflare D1 (SQLite at the edge) |
| Media storage | Cloudflare R2 |
| Quota management | Cloudflare Durable Objects |
| Frontend | React 19, Vite |
| Map rendering | Mapbox GL JS |
| Geocoding + POI search | Azure Maps |

**Request flow:**

```
Browser (React + Mapbox GL JS)
    |
    v
Cloudflare Worker (Hono API)
    |
    +---> D1 (SQLite)        -- POI catalog, queue state, scout profiles
    +---> R2 (Object Store)  -- uploaded photos and videos
    +---> Durable Object     -- provider quota counters
    +---> Azure Maps API     -- geocoding + POI search (external)
    |
    v
JSON Response --> Browser renders on Mapbox map
```


## Provider Setup

Radius Scout runs entirely on free tiers. You need accounts with three providers -- all free.

### Cloudflare

- Create a free account at [cloudflare.com](https://cloudflare.com)
- **Workers free tier:** 100,000 requests/day
- **D1 free tier:** 5M rows read/day, 100K rows written/day
- **R2 free tier:** 10GB storage, 10M reads/month
- The setup script creates all Cloudflare resources (D1 database, R2 bucket, secrets) automatically

### Azure Maps

- **S0 free tier:** 5,000 search transactions/month
- **How to create:** Azure Portal --> Create resource --> "Azure Maps" --> select the S0 (Free) pricing tier
- **Get your API key:** open your Azure Maps resource --> Authentication tab --> copy the Primary Key
- **CORS configuration:** in the Azure portal, add your deployment URL and `http://localhost:8799` to the allowed origins

> **Why Azure Maps over Google Maps?** Google Maps Platform charges per request with no meaningful free tier for server-side usage. Azure Maps S0 tier provides 5,000 free searches/month -- more than enough for personal and small-team use. The quota guardrail system ensures you never exceed free-tier limits.

### Mapbox

- **Free tier:** 50,000 map loads/month
- **Create a token** at [account.mapbox.com/access-tokens](https://account.mapbox.com/access-tokens/)
- **Required scopes:** `styles:read`, `fonts:read`, `styles:tiles`
- The token **must** be a `pk.*` (public) token -- never use `sk.*` (secret) tokens in the browser
- **URL restrictions:** add your deployment URL and `http://localhost:8799` to the token's allowed URLs

### Open-Source and Free-Tier Alternatives

- The quota system is designed to keep usage comfortably within free tiers. At 80% of a provider's monthly limit, a warning banner appears. At 90%, the app automatically locks out further API calls to prevent charges.
- For those exploring open-source map tile providers, the architecture separates map rendering (Mapbox) from POI search (Azure Maps) -- either can be swapped independently without touching the other.
- See `docs/provider-usage-runbook.md` for detailed guidance on monitoring your usage against provider dashboards.


## Quick Start

```bash
git clone <repo-url>
cd radius-scout-planner
npm run setup
```

The setup script handles everything:

1. Checks prerequisites (Node.js, npm, wrangler CLI)
2. Collects your Azure Maps and Mapbox API keys
3. Creates Cloudflare resources (D1 database, R2 bucket)
4. Installs dependencies, builds, and deploys
5. Sets secrets and runs verification tests
6. Captures screenshots for the built-in user manual


## Local Development

Start the local dev server (Vite frontend + Wrangler worker):

```bash
npm run dev
```

This starts the app at `http://localhost:8799`.

To develop without making real API calls, set `PROVIDER_MOCKS=1` in your `.dev.vars` file:

```
AZURE_MAPS_KEY=your_key
MAPBOX_PUBLIC_TOKEN=pk.your_token
PROVIDER_MOCKS=1
```

Mock mode uses fixture data from `tests/fixtures/` that covers various scenarios: dense urban areas, suburban areas, rural locations, and empty results.

See `.dev.vars.example` for a documented template of all environment variables.


## Testing

The test suite includes 41 E2E tests covering core workflows, input validation, provider quota states, queue management, and edge cases. See `docs/e2e-testing-guide.md` for the full reference.

**Unit tests:**

```bash
npm run test:unit
```

**E2E tests — mock mode (validates all application logic, no API quota used):**

```bash
npx playwright test
```

**E2E tests — live mode (adds map viewport assertions, uses API quota):**

```bash
APP_BASE_URL=https://your-app.workers.dev npx playwright test
```

**Screenshot capture (populates images for the "New Here?" modal and user manual):**

The onboarding modal and user manual include placeholder screenshots that are auto-generated from your live deployment. Until you run these commands, those images will show a placeholder message. Both require a deployed URL with real Mapbox tiles.

```bash
# Onboarding modal screenshots ("New Here?" button on home page)
CAPTURE_ONBOARDING=1 APP_BASE_URL=https://your-app.workers.dev npx playwright test tests/e2e/onboarding-screenshots.spec.ts

# User manual screenshots (user-manual.html page)
CAPTURE_MANUAL=1 APP_BASE_URL=https://your-app.workers.dev npx playwright test tests/e2e/manual-capture.spec.ts

# After capturing, rebuild and redeploy so the images are served from the worker
npm run build && wrangler deploy
```

> **Note:** Screenshots are saved to `public/onboarding/` and `public/manual/` which are static assets bundled into the worker. After capturing, you must rebuild and redeploy for the images to appear on the live site.

**Capturing new mock fixtures:**

1. Make a real API call with `PROVIDER_MOCKS=0`
2. Save the response as a JSON file in `tests/fixtures/` matching the `MockFixture` interface
3. Import the fixture in `edge/lib/geo.ts` and add it to the `MOCK_FIXTURES` array


## Provider Usage Monitoring

The app includes a built-in provider quota management system using Cloudflare Durable Objects. It tracks Azure Maps API calls and Mapbox map loads against configurable monthly limits. The Durable Object maintains real-time counters and persists rollups to D1 for historical auditing.

At 80% of any provider's monthly limit, a warning banner appears in the UI. At 90%, the app automatically prevents further API calls to that provider, ensuring you stay within free-tier limits.

See `docs/provider-usage-runbook.md` for the full monitoring and audit guide, including how to cross-reference app counters with Azure and Mapbox dashboards.


## User Manual

Open `public/user-manual.html` for the built-in user guide. It covers search workflows, queue management, photo uploads, and export.

Screenshots in the manual are auto-generated during setup from your actual deployment. To re-capture them:

```bash
APP_BASE_URL=https://your-app.workers.dev npx playwright test tests/e2e/onboarding-screenshots.spec.ts
```


## Authentication

- **Recommended:** Cloudflare Access (free for up to 50 users). Once configured, the app automatically reads user identity from the `cf-access-authenticated-user-email` header.
- **Without Cloudflare Access:** the app works in local development or when accessed through Cloudflare WARP.
- **Custom auth:** the user email is read from a single function (`getAccessEmail`) in `edge/index.ts`. To use a different auth provider, update that function to read from your provider's header or token.


## Contributing

Contributions are welcome. To get started:

1. Fork the repository and create a feature branch
2. Set up local development with `PROVIDER_MOCKS=1` to avoid API calls
3. Run `npm run test:unit` and `npx playwright test` before submitting a pull request
4. Keep pull requests focused -- one feature or fix per PR

Please open an issue first for large changes to discuss the approach.


## License

MIT -- see [LICENSE](LICENSE) for details.
