import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  formatOpsEvent,
  logOpsEvent,
  OPS_ALERT_MARKER,
  OPS_WARN_MARKER,
} from '@/lib/observability/opsLog'
import { __resetDeployStageForTests, getDeployStage } from '@/lib/observability/stage'

// Pure coverage for the operational-alert log contract
// (src/lib/observability/*). These are not cosmetic assertions: the CloudWatch
// Logs metric filter defined in sst.config.ts matches the literal token
// `OPS_ALERT` at the start of a SINGLE log event, so the shape asserted here IS
// the app↔infrastructure interface. If someone changes the marker, the prefix
// position, or the single-line guarantee, the production alarm silently stops
// firing with no other symptom — which is precisely the failure mode this whole
// slice exists to remove. These tests are the tripwire for that.

describe('observability/stage.ts — getDeployStage()', () => {
  const OLD = { ...process.env }

  beforeEach(() => {
    process.env = { ...OLD }
    __resetDeployStageForTests()
  })
  afterEach(() => {
    process.env = { ...OLD }
    __resetDeployStageForTests()
  })

  it('reads the stage out of the SST_RESOURCE_App JSON blob SST injects', () => {
    process.env.SST_RESOURCE_App = JSON.stringify({ name: 'bulbau-lu', stage: 'production' })
    expect(getDeployStage()).toBe('production')
  })

  it('falls back to SST_STAGE (sst dev) when SST_RESOURCE_App is absent', () => {
    delete process.env.SST_RESOURCE_App
    process.env.SST_STAGE = 'filip'
    expect(getDeployStage()).toBe('filip')
  })

  it('never throws on a malformed SST_RESOURCE_App — falls through to the env', () => {
    process.env.SST_RESOURCE_App = '{not json'
    process.env.SST_STAGE = 'fallback-stage'
    expect(getDeployStage()).toBe('fallback-stage')
  })

  it('falls back to NODE_ENV, then "unknown", when nothing SST-specific is set', () => {
    delete process.env.SST_RESOURCE_App
    delete process.env.SST_STAGE
    // NODE_ENV is read-only on the typed `process.env`, so poke it the same way
    // the runtime would see it.
    expect(getDeployStage()).toBe(process.env.NODE_ENV || 'unknown')
  })

  it('memoizes so repeated alert lines do not re-parse JSON per log call', () => {
    process.env.SST_RESOURCE_App = JSON.stringify({ stage: 'staging' })
    expect(getDeployStage()).toBe('staging')
    process.env.SST_RESOURCE_App = JSON.stringify({ stage: 'production' })
    expect(getDeployStage()).toBe('staging') // cached, not re-read
  })
})

describe('observability/opsLog.ts — the CloudWatch metric-filter contract', () => {
  const OLD = { ...process.env }

  beforeEach(() => {
    process.env = { ...OLD }
    __resetDeployStageForTests()
  })
  afterEach(() => {
    process.env = { ...OLD }
    __resetDeployStageForTests()
    vi.restoreAllMocks()
  })

  it('starts the line with the exact marker the metric filter matches', () => {
    const line = formatOpsEvent('content.getServices', new Error('boom'))
    expect(OPS_ALERT_MARKER).toBe('OPS_ALERT')
    expect(line.startsWith(`${OPS_ALERT_MARKER} `)).toBe(true)
  })

  it('emits exactly ONE line — a multi-line error can never split the log event', () => {
    const err = new Error('line one\nline two\r\nline three\tand a tab')
    const line = formatOpsEvent('content.getProjects', err)
    expect(line.includes('\n')).toBe(false)
    expect(line.includes('\r')).toBe(false)
    // The message survives, just flattened.
    expect(line).toContain('line one line two line three and a tab')
  })

  it('carries scope, severity and stage as parseable JSON after the marker', () => {
    process.env.SST_RESOURCE_App = JSON.stringify({ stage: 'production' })
    const line = formatOpsEvent('email.send', new Error('SES rejected'), 'error')
    const json = JSON.parse(line.slice(OPS_ALERT_MARKER.length + 1))
    expect(json).toMatchObject({
      scope: 'email.send',
      severity: 'error',
      message: 'SES rejected',
      stage: 'production',
    })
  })

  it('defaults to severity "error" and supports "warn" for self-healing faults', () => {
    expect(JSON.parse(formatOpsEvent('a', 'x').slice(10)).severity).toBe('error')
    const warnLine = formatOpsEvent('a', 'x', 'warn')
    expect(JSON.parse(warnLine.slice(OPS_WARN_MARKER.length + 1)).severity).toBe('warn')
  })

  it('gives warnings their OWN marker so the paging filter never matches them', () => {
    // The CloudWatch metric filter is the literal "OPS_ALERT". A self-healing
    // degradation must therefore NOT contain that token anywhere in its line,
    // or a missed CDN purge would page someone at 3am.
    const warnLine = formatOpsEvent('cdn.invalidate', new Error('timeout'), 'warn')
    expect(warnLine.startsWith(`${OPS_WARN_MARKER} `)).toBe(true)
    expect(warnLine).not.toContain(OPS_ALERT_MARKER)

    const errorLine = formatOpsEvent('content.getServices', new Error('db down'), 'error')
    expect(errorLine.startsWith(`${OPS_ALERT_MARKER} `)).toBe(true)
    expect(errorLine).not.toContain(OPS_WARN_MARKER)
  })

  it('merges short scalar context but drops undefined values', () => {
    const line = formatOpsEvent('content.getServiceBySlug', 'nope', 'error', {
      slug: 'roof-cleaning',
      locale: 'fr',
      absent: undefined,
    })
    const json = JSON.parse(line.slice(OPS_ALERT_MARKER.length + 1))
    expect(json.slug).toBe('roof-cleaning')
    expect(json.locale).toBe('fr')
    expect('absent' in json).toBe(false)
  })

  it('truncates a pathological message so one fault cannot flood CloudWatch', () => {
    const line = formatOpsEvent('x', 'y'.repeat(5000))
    const json = JSON.parse(line.slice(OPS_ALERT_MARKER.length + 1))
    expect(json.message.length).toBeLessThanOrEqual(300)
    expect(json.message.endsWith('…')).toBe(true)
  })

  it('accepts non-Error throwables (strings, numbers, null) without throwing', () => {
    expect(() => formatOpsEvent('x', 'a string')).not.toThrow()
    expect(() => formatOpsEvent('x', 42)).not.toThrow()
    expect(() => formatOpsEvent('x', null)).not.toThrow()
    expect(JSON.parse(formatOpsEvent('x', 42).slice(OPS_ALERT_MARKER.length + 1)).message).toBe('42')
  })

  it('logOpsEvent writes the line to stderr via console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logOpsEvent('content.getCareers', new Error('db down'))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(spy.mock.calls[0][0])).toContain(`${OPS_ALERT_MARKER} {`)
  })

  it('never throws even if console.error itself blows up (invariant 3)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('stderr is gone')
    })
    expect(() => logOpsEvent('content.getServices', new Error('x'))).not.toThrow()
  })
})

describe('GET /api/health — the uptime-probe contract', () => {
  const OLD = { ...process.env }

  beforeEach(() => {
    process.env = { ...OLD }
    __resetDeployStageForTests()
  })
  afterEach(() => {
    process.env = { ...OLD }
    __resetDeployStageForTests()
    vi.restoreAllMocks()
  })

  async function callHealth() {
    // Imported lazily so each case sees the env set in its own beforeEach.
    const { GET } = await import('@/app/api/health/route')
    return GET()
  }

  it('returns 200 { status: "ok" } with the stage when configured', async () => {
    process.env.DATABASE_URL = 'postgresql://x'
    process.env.PAYLOAD_SECRET = 'x'
    process.env.TOTP_ENCRYPTION_KEY = 'x'
    process.env.SST_RESOURCE_App = JSON.stringify({ stage: 'production' })

    const res = await callHealth()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(body.stage).toBe('production')
    expect(typeof body.time).toBe('string')
  })

  it('is never cacheable — a green probe must mean the ORIGIN answered', async () => {
    process.env.DATABASE_URL = 'postgresql://x'
    process.env.PAYLOAD_SECRET = 'x'
    process.env.TOTP_ENCRYPTION_KEY = 'x'

    const res = await callHealth()
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('returns 503 "degraded" when a required runtime secret is missing', async () => {
    process.env.DATABASE_URL = 'postgresql://x'
    process.env.PAYLOAD_SECRET = 'x'
    delete process.env.TOTP_ENCRYPTION_KEY // would break the admin panel on load

    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await callHealth()
    expect(res.status).toBe(503)
    expect((await res.json()).status).toBe('degraded')
  })

  it('never leaks WHICH secret is missing to the public body (only to CloudWatch)', async () => {
    delete process.env.PAYLOAD_SECRET
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await callHealth()
    const raw = JSON.stringify(await res.json())
    expect(raw).not.toContain('PAYLOAD_SECRET')
    expect(raw).not.toContain('DATABASE_URL')
    // …but the operator does get the detail, as an alertable OPS_ALERT line.
    expect(String(spy.mock.calls[0][0])).toContain('PAYLOAD_SECRET')
    expect(String(spy.mock.calls[0][0])).toContain(OPS_ALERT_MARKER)
  })
})
