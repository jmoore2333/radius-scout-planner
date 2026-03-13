import { PROVIDER_WARNING_FRACTIONS } from '../../shared/constants'
import type { AppLockState, ProviderHealthState, ProviderMetric, ProviderUsageStatus } from '../../shared/types'
import type { Env } from '../env'

interface ProviderConfig {
  provider: ProviderMetric
  label: string
  limit: number
  billingDay: number
}

interface ProviderPeriod {
  provider: ProviderMetric
  label: string
  used: number
  limit: number
  periodStart: string
  periodEnd: string
  state: ProviderHealthState
  updatedAt: string
}

interface ConsumeRequest {
  provider: ProviderMetric
  units: number
  reason: string
  metadata?: Record<string, unknown>
}

interface ConsumeResponse {
  allowed: boolean
  providerStatus: ProviderUsageStatus
  lockState: AppLockState
}

interface ResetRequest {
  reason?: string
  metadata?: Record<string, unknown>
}

const STORAGE_PREFIX = 'provider-period:'

export class ProviderQuotaError extends Error {
  provider: ProviderMetric
  availableAt: string

  constructor(provider: ProviderMetric, message: string, availableAt: string) {
    super(message)
    this.name = 'ProviderQuotaError'
    this.provider = provider
    this.availableAt = availableAt
  }
}

export class ProviderQuotaGate {
  private readonly state: DurableObjectState
  private readonly env: Env

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  async fetch(request: Request) {
    const url = new URL(request.url)

    if (url.pathname === '/status') {
      return Response.json(await this.buildStatusPayload())
    }

    if (url.pathname === '/consume' && request.method === 'POST') {
      const payload = (await request.json()) as ConsumeRequest
      const response = await this.consume(payload)
      return Response.json(response, { status: response.allowed ? 200 : 429 })
    }

    if (url.pathname === '/reset' && request.method === 'POST') {
      const payload = (await request.json().catch(() => ({}))) as ResetRequest
      const response = await this.reset(payload)
      return Response.json(response)
    }

    return new Response('Not found', { status: 404 })
  }

  private async buildStatusPayload() {
    const providerStatuses = await this.getProviderStatuses()
    return {
      providerStatuses,
      lockState: buildLockState(providerStatuses),
    }
  }

  private async consume(payload: ConsumeRequest): Promise<ConsumeResponse> {
    const config = getProviderConfigs(this.env).find(item => item.provider === payload.provider)
    if (!config) {
      throw new Error(`Unknown provider ${payload.provider}`)
    }

    const period = await this.readPeriod(config)
    const hardStopAt = Math.floor(period.limit * PROVIDER_WARNING_FRACTIONS.hardStop)

    if (period.used >= hardStopAt || period.used + payload.units > hardStopAt) {
      const lockedPeriod = await this.persistPeriod({
        ...period,
        state: 'locked',
        updatedAt: new Date().toISOString(),
      })
      const lockedStatus = mapPeriodToStatus(lockedPeriod)
      return {
        allowed: false,
        providerStatus: lockedStatus,
        lockState: buildLockState([lockedStatus]),
      }
    }

    const nextUsed = period.used + payload.units
    const nextPeriod = await this.persistPeriod({
      ...period,
      used: nextUsed,
      state: deriveHealthState(nextUsed, period.limit),
      updatedAt: new Date().toISOString(),
    })

    await this.writeUsageAudit(nextPeriod, payload)

    const providerStatus = mapPeriodToStatus(nextPeriod)
    return {
      allowed: true,
      providerStatus,
      lockState: buildLockState([providerStatus]),
    }
  }

  private async getProviderStatuses(): Promise<ProviderUsageStatus[]> {
    const configs = getProviderConfigs(this.env)
    const periods = await Promise.all(configs.map(config => this.readPeriod(config)))
    return periods.map(mapPeriodToStatus)
  }

  private async readPeriod(config: ProviderConfig): Promise<ProviderPeriod> {
    const now = new Date()
    const { start, end } = computeBillingPeriod(now, config.billingDay)
    const storageKey = `${STORAGE_PREFIX}${config.provider}`
    const stored = (await this.state.storage.get<ProviderPeriod>(storageKey)) ?? null

    if (stored && stored.periodStart === start.toISOString() && stored.periodEnd === end.toISOString()) {
      return stored
    }

    const fresh: ProviderPeriod = {
      provider: config.provider,
      label: config.label,
      used: 0,
      limit: config.limit,
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      state: 'healthy',
      updatedAt: now.toISOString(),
    }

    await this.persistPeriod(fresh)
    return fresh
  }

  private async persistPeriod(period: ProviderPeriod): Promise<ProviderPeriod> {
    await this.state.storage.put(`${STORAGE_PREFIX}${period.provider}`, period)
    await this.upsertUsagePeriodRow(period)

    return period
  }

  private async writeUsageAudit(period: ProviderPeriod, payload: ConsumeRequest) {
    await this.env.DB
      .prepare(`
        INSERT INTO provider_usage_events (
          id,
          provider,
          period_start,
          units,
          reason,
          metadata_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        crypto.randomUUID(),
        period.provider,
        period.periodStart,
        payload.units,
        payload.reason,
        payload.metadata ? JSON.stringify(payload.metadata) : null,
        period.updatedAt,
      )
      .run()
  }

  private async upsertUsagePeriodRow(period: ProviderPeriod) {
    try {
      await this.runUsagePeriodUpsert(
        `
          INSERT INTO provider_usage_periods (
            provider,
            period_start,
            period_end,
            quota_limit,
            used,
            state,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(provider, period_start) DO UPDATE SET
            period_end = excluded.period_end,
            quota_limit = excluded.quota_limit,
            used = excluded.used,
            state = excluded.state,
            updated_at = excluded.updated_at
        `,
        period,
      )
    } catch (error) {
      if (!isMissingQuotaLimitColumnError(error)) {
        throw error
      }

      await this.runUsagePeriodUpsert(
        `
          INSERT INTO provider_usage_periods (
            provider,
            period_start,
            period_end,
            "limit",
            used,
            state,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(provider, period_start) DO UPDATE SET
            period_end = excluded.period_end,
            "limit" = excluded."limit",
            used = excluded.used,
            state = excluded.state,
            updated_at = excluded.updated_at
        `,
        period,
      )
    }
  }

  private async runUsagePeriodUpsert(query: string, period: ProviderPeriod) {
    await this.env.DB
      .prepare(query)
      .bind(
        period.provider,
        period.periodStart,
        period.periodEnd,
        period.limit,
        period.used,
        period.state,
        period.updatedAt,
      )
      .run()
  }

  private async reset(payload: ResetRequest) {
    await this.state.storage.deleteAll()
    const now = new Date().toISOString()
    const configs = getProviderConfigs(this.env)

    await this.env.DB.batch(
      configs.map(config =>
        this.env.DB
          .prepare(`
            INSERT INTO provider_usage_events (
              id,
              provider,
              period_start,
              units,
              reason,
              metadata_json,
              created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(
            crypto.randomUUID(),
            config.provider,
            computeBillingPeriod(new Date(), config.billingDay).start.toISOString(),
            0,
            payload.reason ?? 'debug-reset',
            payload.metadata ? JSON.stringify(payload.metadata) : null,
            now,
          ),
      ),
    )

    return this.buildStatusPayload()
  }
}

export async function getProviderStatus(env: Env) {
  const response = await getQuotaStub(env).fetch('https://quota.internal/status')
  return (await response.json()) as {
    providerStatuses: ProviderUsageStatus[]
    lockState: AppLockState
  }
}

export async function requireProviderUnits(
  env: Env,
  provider: ProviderMetric,
  units: number,
  reason: string,
  metadata?: Record<string, unknown>,
): Promise<ProviderUsageStatus> {
  const response = await getQuotaStub(env).fetch('https://quota.internal/consume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider, units, reason, metadata }),
  })

  const payload = (await response.json()) as ConsumeResponse

  if (!payload.allowed) {
    throw new ProviderQuotaError(
      payload.providerStatus.provider,
      buildProviderLockMessage(payload.providerStatus),
      payload.providerStatus.availableAt,
    )
  }

  return payload.providerStatus
}

export async function resetProviderQuotas(env: Env, metadata?: Record<string, unknown>) {
  const response = await getQuotaStub(env).fetch('https://quota.internal/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      reason: 'debug-reset',
      metadata,
    }),
  })

  return (await response.json()) as {
    providerStatuses: ProviderUsageStatus[]
    lockState: AppLockState
  }
}

export function buildProviderLockMessage(status: ProviderUsageStatus) {
  return `${status.label} is offline until ${new Date(status.availableAt).toLocaleString()} after reaching the provider safety cap.`
}

export function buildLockState(statuses: ProviderUsageStatus[]): AppLockState {
  const lockedProvider = statuses.find(status => status.state === 'locked') ?? null
  return {
    isLocked: Boolean(lockedProvider),
    lockedProvider: lockedProvider?.provider ?? null,
    message: lockedProvider ? buildProviderLockMessage(lockedProvider) : null,
    availableAt: lockedProvider?.availableAt ?? null,
  }
}

function mapPeriodToStatus(period: ProviderPeriod): ProviderUsageStatus {
  return {
    provider: period.provider,
    label: period.label,
    used: period.used,
    limit: period.limit,
    ratio: period.limit === 0 ? 0 : period.used / period.limit,
    advisoryAt: Math.floor(period.limit * PROVIDER_WARNING_FRACTIONS.advisory),
    elevatedAt: Math.floor(period.limit * PROVIDER_WARNING_FRACTIONS.elevated),
    hardStopAt: Math.floor(period.limit * PROVIDER_WARNING_FRACTIONS.hardStop),
    state: period.state,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    availableAt: period.periodEnd,
  }
}

function deriveHealthState(used: number, limit: number): ProviderHealthState {
  const hardStopAt = Math.floor(limit * PROVIDER_WARNING_FRACTIONS.hardStop)
  const advisoryAt = Math.floor(limit * PROVIDER_WARNING_FRACTIONS.advisory)

  if (used >= hardStopAt) {
    return 'locked'
  }

  if (used >= advisoryAt) {
    return 'warning'
  }

  return 'healthy'
}

function getQuotaStub(env: Env) {
  return env.QUOTA_GATE.getByName('provider-quota-gate')
}

function getProviderConfigs(env: Env): ProviderConfig[] {
  return [
    {
      provider: 'azure.search',
      label: 'Azure Maps Search',
      limit: parsePositiveInt(env.AZURE_MONTHLY_SEARCH_LIMIT, 5000),
      billingDay: parseBillingDay(env.AZURE_BILLING_CYCLE_DAY, 1),
    },
    {
      provider: 'mapbox.map_load',
      label: 'Mapbox map loads',
      limit: parsePositiveInt(env.MAPBOX_MONTHLY_MAP_LOAD_LIMIT, 50000),
      billingDay: parseBillingDay(env.MAPBOX_BILLING_CYCLE_DAY, 1),
    },
  ]
}

function computeBillingPeriod(now: Date, billingDay: number) {
  const currentYear = now.getUTCFullYear()
  const currentMonth = now.getUTCMonth()
  const currentDay = now.getUTCDate()

  const startMonthOffset = currentDay >= billingDay ? 0 : -1
  const start = new Date(Date.UTC(currentYear, currentMonth + startMonthOffset, billingDay, 0, 0, 0, 0))
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, billingDay, 0, 0, 0, 0))
  return { start, end }
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseBillingDay(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.min(28, Math.max(1, parsed))
}

function isMissingQuotaLimitColumnError(error: unknown) {
  return error instanceof Error && error.message.includes('no column named quota_limit')
}
