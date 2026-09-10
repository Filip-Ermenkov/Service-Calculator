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

/** Never throws; falls back to `NODE_ENV`, then `'unknown'`. */
export function getDeployStage(): string {
  if (cached !== undefined) return cached

  const resourceApp = process.env.SST_RESOURCE_App
  if (resourceApp) {
    try {
      const parsed = JSON.parse(resourceApp) as { stage?: unknown }
      if (typeof parsed.stage === 'string' && parsed.stage.length > 0) {
        cached = parsed.stage
        return cached
      }
    } catch {
      // Malformed/absent — fall through to the env fallbacks below.
    }
  }

  cached = process.env.SST_STAGE || process.env.NODE_ENV || 'unknown'
  return cached
}

/** Test-only: clears the memoized value so a test can vary the environment. */
export function __resetDeployStageForTests(): void {
  cached = undefined
}
