/**
 * Which deployed stage this process is running as (`staging`, `production`, …).
 *
 * SST only sets a plain `SST_STAGE` env var in `sst dev`; on a real deployed
 * Lambda the stage is carried inside `SST_RESOURCE_App`, a JSON blob SST always
 * injects (`{"name":"bulbau-lu","stage":"production"}` — see
 * `.sst/platform/src/components/aws/function.ts`). Reading it here, once and
 * defensively, keeps that detail out of every call site.
 *
 * Used by the operational alert lines (`src/lib/observability/opsLog.ts`) and by
 * `GET /api/health`, so an alarm email or an uptime probe says which stage it
 * came from — the two stages share one AWS account and one SNS topic.
 */

let cached: string | undefined

/**
 * The SST stage name ONLY when SST itself declared it (`SST_RESOURCE_App`, or
 * `SST_STAGE` under `sst dev`) — `null` anywhere else, including a CI `next build`
 * / `next start` that happens to run with NODE_ENV=production. Pure, never throws.
 *
 * Use this — not `getDeployStage()` — for any decision that must be TRUE only on
 * a real deployed stage (e.g. "fall back to the production domain"): the latter
 * deliberately falls back to NODE_ENV, which reads 'production' on the CI runner.
 */
export function readSstStage(
  env: { SST_RESOURCE_App?: string; SST_STAGE?: string } = process.env as Record<string, string | undefined>,
): string | null {
  const resourceApp = env.SST_RESOURCE_App
  if (resourceApp) {
    try {
      const parsed = JSON.parse(resourceApp) as { stage?: unknown }
      if (typeof parsed.stage === 'string' && parsed.stage.length > 0) return parsed.stage
    } catch {
      // Malformed — fall through to SST_STAGE.
    }
  }
  const stage = env.SST_STAGE?.trim()
  return stage ? stage : null
}

/** Never throws; falls back to `NODE_ENV`, then `'unknown'`. */
export function getDeployStage(): string {
  if (cached !== undefined) return cached
  cached = readSstStage() ?? (process.env.NODE_ENV || 'unknown')
  return cached
}

/** Test-only: clears the memoized value so a test can vary the environment. */
export function __resetDeployStageForTests(): void {
  cached = undefined
}
