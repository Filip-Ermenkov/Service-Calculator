/**
 * On-demand CloudFront invalidation for the public site — the PROPER fix for the
 * OpenNext stale-edge problem (see docs/PROGRESS.md, "Phase 5 part 1" cache
 * gotcha). This is invoked from the revalidate hook (src/lib/revalidate.ts) after
 * `revalidatePath`.
 *
 * WHY THIS EXISTS
 * OpenNext's automatic CDN invalidation is a DUMMY no-op by default, so when the
 * admin publishes/edits/deletes content, `revalidatePath` refreshes the S3 origin
 * cache but CloudFront keeps serving its cached HTML until `s-maxage` expires.
 * Until now that was worked around by driving every content page's ISR window
 * down to 10s. This module is the real fix: after `revalidatePath`, it asks
 * CloudFront to invalidate `/*` once, so an edit appears at the edge within
 * seconds regardless of the cache window — which lets the window go back up
 * (fewer origin regenerations = cheaper).
 *
 * WHY THE DISTRIBUTION ID COMES FROM SSM (not a plain env var)
 * The natural approach — pass CLOUDFRONT_DISTRIBUTION_ID to the server function —
 * is impossible in a single SST pass: the server function would depend on the
 * distribution's id while the distribution depends on the server function's URL
 * as its origin. That is a dependency cycle (SST issue #5990). So sst.config.ts
 * writes the id into an SSM parameter AFTER the Nextjs component is created (the
 * parameter depends on the distribution, the distribution does not depend on the
 * parameter — no cycle), and passes only the parameter NAME (a static string) to
 * the server function as `CDN_DISTRIBUTION_ID_PARAM`. This module reads the id
 * from that parameter at runtime and caches it (the id is stable for the life of
 * a stage), so the SSM read happens at most once per warm Lambda instance.
 *
 * SAFETY (mirrors src/lib/revalidate.ts)
 * This runs inside the Payload afterChange/afterDelete hook, i.e. INSIDE the save
 * transaction. It must therefore NEVER throw and must be time-boxed — a
 * CDN-invalidation failure must not roll back a content save. Every path is
 * try/caught, the AWS calls are bounded by an AbortController deadline, and the
 * whole thing is a no-op when `CDN_DISTRIBUTION_ID_PARAM` is unset (local dev, CI,
 * tests, or any stage without the wiring), so no AWS access is required there and
 * FR/DE/EN content still commits.
 *
 * COST
 * A single `/*` invalidation counts as ONE path, and AWS gives 1,000 free
 * invalidation paths per month. The revalidate hook fires once per top-level save
 * (nested translation writes set `disableRevalidate`), so one content edit = one
 * invalidation — far under the free tier at this site's edit volume.
 */

import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from '@aws-sdk/client-cloudfront'
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'

/** Invalidating `/*` is a single billable path and covers every locale/route. */
const DEFAULT_PATHS = ['/*'] as const

/**
 * Hard ceiling on the SSM + CloudFront calls combined. Well under the Web
 * function's 30s Lambda timeout (sst.config.ts) so this can never sit in the save
 * transaction long enough to risk a rollback. CreateInvalidation returns as soon
 * as the invalidation is CREATED (it does not wait for it to complete), so the
 * real call is fast; the deadline only guards a pathological hang.
 */
const AWS_CALL_TIMEOUT_MS = 5_000

/** True when SST has wired the distribution-id parameter for this stage. */
export function isCdnInvalidationConfigured(): boolean {
  return Boolean(process.env.CDN_DISTRIBUTION_ID_PARAM)
}

/**
 * Seams for unit tests (mirrors the __…ForTests pattern in translation/provider).
 * When set, they replace the SSM read and the CloudFront call so the module can
 * be exercised with no AWS access. Setting them also resets the cached id so each
 * test starts clean.
 */
type ResolveFn = () => Promise<string | null>
type SendFn = (
  distributionId: string,
  paths: string[],
  signal: AbortSignal,
) => Promise<void>
let resolveForTests: ResolveFn | null = null
let sendForTests: SendFn | null = null
export function __setCdnImplsForTests(
  impls: { resolve?: ResolveFn | null; send?: SendFn | null } | null,
): void {
  resolveForTests = impls?.resolve ?? null
  sendForTests = impls?.send ?? null
  cachedDistributionId = undefined
}

// The distribution id is stable for a stage, so resolve it at most once per warm
// instance. `undefined` = not yet resolved; a string = resolved. A failed/absent
// lookup is intentionally NOT cached, so the next content change retries instead
// of being disabled until the Lambda recycles.
let cachedDistributionId: string | undefined

let ssmClient: SSMClient | null = null
function getSsmClient(): SSMClient {
  if (!ssmClient) {
    ssmClient = new SSMClient({
      region: process.env.AWS_REGION || 'eu-central-1',
      maxAttempts: 2,
    })
  }
  return ssmClient
}

let cloudFrontClient: CloudFrontClient | null = null
function getCloudFrontClient(): CloudFrontClient {
  if (!cloudFrontClient) {
    cloudFrontClient = new CloudFrontClient({
      region: process.env.AWS_REGION || 'eu-central-1',
      maxAttempts: 2,
    })
  }
  return cloudFrontClient
}

/** Read the distribution id from SSM (or the test seam). No caching here. */
async function loadDistributionId(signal: AbortSignal): Promise<string | null> {
  if (resolveForTests) return resolveForTests()
  const paramName = process.env.CDN_DISTRIBUTION_ID_PARAM
  if (!paramName) return null
  const res = await getSsmClient().send(
    new GetParameterCommand({ Name: paramName }),
    { abortSignal: signal },
  )
  const value = res.Parameter?.Value?.trim()
  return value ? value : null
}

/** Cached wrapper: resolves the distribution id once per warm instance. */
async function resolveDistributionId(signal: AbortSignal): Promise<string | null> {
  if (cachedDistributionId !== undefined) return cachedDistributionId
  const value = await loadDistributionId(signal)
  if (value) cachedDistributionId = value
  return value
}

/** Create the CloudFront invalidation (or call the test seam). */
async function sendInvalidation(
  distributionId: string,
  paths: string[],
  signal: AbortSignal,
): Promise<void> {
  if (sendForTests) return sendForTests(distributionId, paths, signal)
  await getCloudFrontClient().send(
    new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: {
        // Unique per call so CloudFront never treats two distinct edits as the
        // same request.
        CallerReference: `content-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        Paths: { Quantity: paths.length, Items: paths },
      },
    }),
    { abortSignal: signal },
  )
}

/**
 * Invalidate the public CloudFront cache so an edit appears at the edge within
 * seconds. No-op (and no AWS access) when unconfigured. NEVER throws — a failure
 * is logged and swallowed, and the time-based ISR window remains the safety net.
 */
export async function invalidateCdn(
  paths: readonly string[] = DEFAULT_PATHS,
): Promise<void> {
  if (!isCdnInvalidationConfigured()) {
    console.warn('[cdn] skip: CDN_DISTRIBUTION_ID_PARAM is not set')
    return
  }
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error('CDN invalidation timed out')),
    AWS_CALL_TIMEOUT_MS,
  )
  try {
    const distributionId = await resolveDistributionId(controller.signal)
    if (!distributionId) {
      console.warn(
        `[cdn] skip: distribution id resolved empty from SSM parameter ${process.env.CDN_DISTRIBUTION_ID_PARAM}`,
      )
      return
    }
    await sendInvalidation(distributionId, [...paths], controller.signal)
    console.warn(
      `[cdn] invalidation created for distribution ${distributionId} (${paths.join(', ')})`,
    )
  } catch (err) {
    console.warn(
      '[cdn] invalidation skipped (content still served via the ISR window):',
      (err as Error)?.message ?? err,
    )
  } finally {
    clearTimeout(timer)
  }
}
