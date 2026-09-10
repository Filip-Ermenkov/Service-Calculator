/**
 * Liveness endpoint — the target of the external uptime check (AWS Well-
 * Architected: Operational Excellence / Reliability).
 *
 * GET /api/health → 200 { status: 'ok', … }   |   503 { status: 'degraded', … }
 *
 * ── What it proves ───────────────────────────────────────────────────────────
 * That a request reached this deployment and the Next/Payload server function
 * booted with its required runtime configuration present. In other words it
 * covers the whole visitor-facing chain end to end — DNS → the ACM certificate →
 * CloudFront → the origin Lambda → this handler — which is exactly the chain a
 * `HealthCheckStatus` alarm should watch (`infra/terraform/uptime.tf`).
 *
 * ── What it deliberately does NOT do: touch the database ─────────────────────
 * The obvious "deep" health check would run a query. It must not, and this is a
 * real architectural constraint rather than laziness: **Neon scale-to-zero is a
 * load-bearing part of this project's cost model** (TECHSPEC §3/§9 — the free
 * tier's 100 CU-hours/month only holds because the database sleeps when idle).
 * An uptime probe every 30 seconds that opened a connection would keep Neon
 * awake 24/7 and blow through the free tier on its own — monitoring that breaks
 * the thing it monitors.
 *
 * The database-failure case is covered a different, free way: every resilient
 * read in `src/lib/content.ts` emits an `OPS_ALERT` line on failure
 * (`src/lib/observability/opsLog.ts`), which a CloudWatch Logs metric filter in
 * `sst.config.ts` turns into an alarm. The trade-off, stated plainly: that fires
 * when a real request hits the fault rather than proactively — which for a
 * cached, low-traffic marketing site is the right bar, because a fault nobody's
 * request has hit yet is a fault nobody has experienced.
 *
 * ── Response-body policy ─────────────────────────────────────────────────────
 * The endpoint is public and unauthenticated (it has to be — Route 53's checkers
 * carry no credentials), so the body is deliberately dull: a status, the stage
 * name, and a timestamp. No versions, no dependency states, no error strings, no
 * env-var names — nothing that helps an attacker fingerprint the deployment.
 * `Cache-Control: no-store` keeps CloudFront from ever answering on the origin's
 * behalf, so a green check always means the origin itself answered.
 */

import { NextResponse } from 'next/server'

import { logOpsEvent } from '@/lib/observability/opsLog'
import { getDeployStage } from '@/lib/observability/stage'

// Never prerendered, never cached — a health probe must reach this process.
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Runtime configuration without which the app cannot serve correctly:
 *  • DATABASE_URL     — every content read needs it (an unset value makes `pg`
 *                       silently fall back to localhost, which fails obscurely).
 *  • PAYLOAD_SECRET   — signs the admin session token.
 *  • TOTP_ENCRYPTION_KEY — `src/lib/totp/keys.ts` THROWS without it, which would
 *                       break the admin panel on load (this exact omission was a
 *                       real Phase 1.5 near-miss — see docs/PROGRESS.md).
 * Checked by presence only; values are never read into the response.
 */
const REQUIRED_ENV = ['DATABASE_URL', 'PAYLOAD_SECRET', 'TOTP_ENCRYPTION_KEY'] as const

const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
} as const

export async function GET(): Promise<Response> {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name])

  if (missing.length > 0) {
    // The NAMES go to CloudWatch (where they are useful and private), never to
    // the response body (where they would leak deployment detail).
    logOpsEvent('health.configuration', `missing required env: ${missing.join(', ')}`)
    return NextResponse.json(
      {
        status: 'degraded',
        reason: 'configuration',
        stage: getDeployStage(),
        time: new Date().toISOString(),
      },
      { status: 503, headers: NO_STORE },
    )
  }

  return NextResponse.json(
    {
      status: 'ok',
      stage: getDeployStage(),
      time: new Date().toISOString(),
    },
    { status: 200, headers: NO_STORE },
  )
}
