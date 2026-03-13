# Provider Usage Audit Runbook

This runbook is the operational protocol for checking that:

- the `ProviderQuotaGate` Durable Object is counting usage correctly
- the Durable Object rollups are being persisted into D1
- the per-call audit rows in D1 match the current rollups
- the app-side counters make sense when compared to Azure Maps and Mapbox

Use this before broad testing, after provider changes, and during regular cost reviews.

## Production identifiers

- App: `https://your-domain.example.com`
- Worker: `radius-scout-planner`
- D1 database: `radius-scout-db`
- Durable Object class: `ProviderQuotaGate`
- Azure Maps account: `your-azure-maps-account`
- Azure resource group: `your-azure-resource-group`
- Current Mapbox browser token note: `Radius Scout production web token`

## What one controlled run should do

Expected counter movement in the current architecture:

- Fresh browser tab that loads the map once:
  - `mapbox.map_load` increments by `+1`
- Address search with `N` categories:
  - `azure.search` increments by `+(1 + N)`
  - `1` geocode
  - `N` `poi-search`
- `Use map center` search with `N` categories:
  - `azure.search` increments by `+N`
  - no geocode call
- Re-rendering the page inside the same tab should not mint a new Mapbox session on its own

Practical check:

- Open one fresh tab
- Run one search with exactly `2` categories
- Expect:
  - `mapbox.map_load +1`
  - `azure.search +3`

## How the quota system keeps costs at zero

The `ProviderQuotaGate` Durable Object enforces a hard budget on every provider before any outbound API call is made. All counters are tracked in-memory in the DO and flushed to D1, so the app never relies solely on provider-side billing dashboards for gating.

The quota system uses three escalating thresholds:

| Threshold | State | Effect |
|-----------|-------|--------|
| 80% of period limit | `warning` | Warning header added to API responses; operations continue |
| 85% of period limit | `elevated` | Warning header escalated; operations continue |
| 90% of period limit | `hard_lock` | All requests for that provider are rejected with `429` until the period rolls over |

The hard lock at 90% leaves a 10% safety margin to absorb any in-flight or delayed requests before the provider's own billing limit is reached. This keeps the effective monthly spend at zero as long as free-tier limits are configured correctly in the DO.

To confirm that the quota state for the current period is visible at any time:

```bash
curl -sS https://your-domain.example.com/api/provider-status | jq
```

The response shows the current `used`, `limit`, and `state` for each provider.

## 1. Capture the baseline

Check the live counter state exposed by the Worker:

```bash
curl -sS https://your-domain.example.com/api/provider-status | jq
```

Inspect the current period rollups in D1:

```bash
npx wrangler d1 execute radius-scout-db --remote --command \
"SELECT provider, period_start, period_end, \"limit\", used, state, updated_at
 FROM provider_usage_periods
 ORDER BY provider, period_start DESC;"
```

Inspect the latest audit rows:

```bash
npx wrangler d1 execute radius-scout-db --remote --command \
"SELECT provider, units, reason, created_at,
        substr(coalesce(metadata_json,''),1,160) AS metadata_preview
 FROM provider_usage_events
 ORDER BY created_at DESC
 LIMIT 20;"
```

Reconcile rollups to event sums for the latest period per provider:

```bash
npx wrangler d1 execute radius-scout-db --remote --command \
"WITH latest AS (
   SELECT provider, MAX(period_start) AS period_start
   FROM provider_usage_periods
   GROUP BY provider
 )
 SELECT p.provider,
        p.period_start,
        p.used AS period_used,
        COALESCE(SUM(e.units), 0) AS event_used,
        p.used - COALESCE(SUM(e.units), 0) AS delta
 FROM provider_usage_periods p
 JOIN latest l
   ON l.provider = p.provider
  AND l.period_start = p.period_start
 LEFT JOIN provider_usage_events e
   ON e.provider = p.provider
  AND e.period_start = p.period_start
 GROUP BY p.provider, p.period_start, p.used
 ORDER BY p.provider;"
```

Expected result:

- `delta = 0` for both providers

If `delta != 0`, stop and investigate before doing more testing.

## 2. Run one controlled browser check

Do this in a fresh browser context so the Mapbox session behavior is real:

1. Open a new incognito/private window.
2. Go to `https://your-domain.example.com`.
3. Wait for the live map to render.
4. Create a temporary scout name like `audit-<YYYYMMDD>-1`.
5. Search:
   - address: `1600 Pennsylvania Ave NW, Washington, DC 20500`
   - radius: `5 mi`
   - categories: `hospitals`, `schools`

After that run:

- `mapbox.map_load` should have increased by `1`
- `azure.search` should have increased by `3`

Re-run the D1 event tail query. You should see:

- one `map-session`
- one `geocode`
- two `poi-search`

The metadata preview should match the search you just ran.

## 3. Confirm the DO is writing to D1 correctly

These are the two tables that matter:

- `provider_usage_periods`
- `provider_usage_events`

What to check:

- `provider_usage_periods.used` increments after the browser workflow
- matching `provider_usage_events` rows appear immediately
- the reconciliation query still returns `delta = 0`

Interpretation:

- If the event rows exist but the period table did not move, the DO is writing events but not persisting rollups correctly.
- If the period table moved but the event rows are missing, the audit trail is incomplete.
- If both moved but `delta != 0`, the rollup state and event ledger have diverged.

## 4. Cross-check against Azure Maps

First confirm which metrics Azure exposes:

```bash
RESOURCE_ID=$(az maps account show \
  --resource-group your-azure-resource-group \
  --name your-azure-maps-account \
  --query id -o tsv)

az monitor metrics list-definitions \
  --resource "$RESOURCE_ID" -o json
```

For this resource, the key metric is:

- `Usage`

And the important dimensions are:

- `ApiCategory`
- `ApiName`
- `ResultType`
- `ResponseCode`

Query the Usage metric:

```bash
RESOURCE_ID=$(az maps account show \
  --resource-group your-azure-resource-group \
  --name your-azure-maps-account \
  --query id -o tsv)

az monitor metrics list \
  --resource "$RESOURCE_ID" \
  --metric Usage \
  --interval P1D \
  --aggregation Count \
  --filter "ApiCategory eq '*' and ApiName eq '*'" \
  -o json
```

What you should see:

- `SearchAddress.GetAddress` for geocodes
- `SearchPOICategory.GetSearchPOICategory` for category POI calls

Use the Azure portal when you need cleaner slicing:

1. Open your Azure Maps account
2. Go to `Monitoring > Metrics`
3. Metric: `Usage`
4. Split by: `ApiName`
5. Filter `ApiCategory = Search`

Compare that window to the D1 event rows from the same period.

Expected relationship:

- D1 `geocode` rows should line up with `SearchAddress.GetAddress`
- D1 `poi-search` rows should line up with `SearchPOICategory.GetSearchPOICategory`

Notes:

- Azure metrics are not the source of truth for app-side gating; the DO is
- Azure metrics can lag behind the live D1 event stream
- use Azure as the provider-side billing sanity check, not the real-time circuit breaker

## 5. Cross-check against Mapbox

There are two distinct checks on the Mapbox side.

### A. Verify the token configuration

Log in to your Mapbox account at `https://account.mapbox.com/access-tokens/` and locate the token named `Radius Scout production web token`.

Verify:

- `usage = "pk"` (public token)
- `allowedUrls` contains:
  - `https://your-domain.example.com`
  - `http://localhost:<your-dev-port>`
- scopes:
  - `styles:read`
  - `fonts:read`
  - `styles:tiles`

You can also query the token list via the Mapbox API using your secret token (`sk.*`):

```bash
curl -sS "https://api.mapbox.com/tokens/v2/your-mapbox-username?usage=pk&access_token=<YOUR_SECRET_TOKEN>" | jq \
  '[.[] | select(.note == "Radius Scout production web token") | {id, note, allowedUrls, scopes, usage, created}]'
```

Replace `<YOUR_SECRET_TOKEN>` with your `sk.*` token and `your-mapbox-username` with your Mapbox account username.

### B. Check Mapbox usage

Mapbox usage must be checked in the Mapbox Statistics UI by token. This is the provider-side billing cross-check.

Use the token note:

- `Radius Scout production web token`

What to compare:

- D1 `mapbox.map_load` current-period `used`
- Mapbox Statistics page map/session usage for the same token and same time window

Expected relationship:

- D1 is the real-time operational counter
- Mapbox Statistics is the billing sanity check
- Mapbox stats can lag, so compare trends and daily totals, not second-by-second values

Important:

- Do not use `curl /api/map-session` as a provider-side validation step
- that increments the DO/D1 counter, but it does not prove the browser actually loaded Mapbox tiles/styles
- for Mapbox validation, always use a real browser tab

## 6. Optional live log watch

If you want to watch API calls while doing the controlled run:

```bash
npx wrangler tail
```

Use that together with:

- the D1 event tail query
- the Azure Metrics view
- the Mapbox Statistics page

## 7. Warning signs

Investigate immediately if any of these happen:

- reconciliation `delta != 0`
- repeated `map-session` rows from the same user agent within seconds for a single tab
- `poi-search` rows appear without the expected number of selected categories
- Azure metrics materially exceed the app-side `azure.search` count over the same window
- Mapbox daily usage materially exceeds the number of fresh-tab sessions the app recorded
- counters jump while no one is actively using the site

## 8. Debug reset policy

The debug reset exists for stuck/test scenarios only.

Do not use it as part of normal production billing checks.

Why:

- it clears the Durable Object rollup state for the current period
- it writes `debug-reset` audit rows with `0` units
- after a reset, the current-period reconciliation will no longer represent the real month-to-date totals

Use it only when:

- you are in local/dev, or
- you have explicitly decided to discard the current app-side counters and restart the month-to-date tracking window

If you ever must use it in production:

1. Export the current `provider_usage_periods` and `provider_usage_events` first.
2. Record the reset time in the incident notes.
3. Treat the counters after reset as a new local tracking window, not the authoritative month-to-date total.

## 9. Recommended cadence

- Before any major smoke run
- After any provider-token rotation
- After any DO/quota logic change
- Weekly while usage is low
- Daily once either provider crosses `80%`

## 10. Pass / fail summary

Pass:

- live `/api/provider-status` moves exactly as expected
- D1 event rows appear immediately
- D1 rollups reconcile to event sums with `delta = 0`
- Azure Usage metrics line up with `geocode` and `poi-search`
- Mapbox token config is correct and Statistics trends align with fresh-tab usage

Fail:

- any non-zero reconciliation delta
- duplicate map-session grants for one browser session
- provider-side usage materially drifting from the app-side counters
- any need to rely on debug reset to keep normal production accounting working
