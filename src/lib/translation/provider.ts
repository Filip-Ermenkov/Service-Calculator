/**
 * Machine-translation provider for the Phase 5 pipeline — AWS Translate.
 *
 * Why AWS Translate (decision re-made 2026-08-01, see docs/PROGRESS.md): DeepL
 * retired its recurring free API tier (new accounts get a ONE-TIME 1M-character
 * Developer allowance, then paid Growth). For this app the right call on both
 * cost and architecture is AWS Translate:
 *   • Cost — $15 / million characters, pay-as-you-go, plus 2M chars/month free
 *     for the first 12 months. This site's entire content is well under 100K
 *     characters, so a full translation is ~$1.50 and edits are fractions of a
 *     cent (and $0 for the first year). No monthly minimum or base fee.
 *   • Architecture — the app already runs entirely on AWS in a dedicated
 *     account. Translate authenticates via the Lambda execution role (IAM), so
 *     there is NO new API-key secret to manage/rotate, and it adds NO new
 *     external sub-processor (it removes DeepL from the DPA list). One credential
 *     model, fewer moving parts — the Well-Architected choice.
 *   • Capability — EN→FR/DE with a FORMAL register (the business tone this site
 *     wants; AWS supports Formality for both fr and de). Any imperfect string is
 *     correctable via the manual per-locale override in the admin.
 *
 * The engine is isolated behind this module's small interface
 * (`translateTexts` / `buildTranslationMap` / `isTranslationConfigured`); the
 * registry, Lexical walker, orchestrator and hook are all engine-agnostic, so
 * swapping providers again would touch only this file.
 *
 * Enablement: gated by the TRANSLATE_ENABLED env flag (SST sets it 'true' on
 * deployed stages, where the execution role carries `translate:TranslateText`).
 * Unset locally/CI ⇒ the pipeline is a no-op and FR/DE fall back to the EN source
 * via Payload's localization.fallback — so local dev and CI need no AWS Translate
 * access. To exercise it locally, set TRANSLATE_ENABLED=true with AWS credentials
 * that allow translate:TranslateText (or just test on staging).
 */

import { TranslateClient, TranslateTextCommand } from '@aws-sdk/client-translate'

/** The languages this site translates INTO. EN is the authoring source. */
export type TargetLocale = 'fr' | 'de'

const SOURCE_LANGUAGE_CODE = 'en'
/** Business/services site addressing customers ⇒ formal register (Sie / vous). */
const FORMALITY = 'FORMAL' as const

/**
 * AWS Translate's real-time `TranslateText` is ONE string per request (no array
 * batching) with a DEFAULT account quota of 20 requests/second. If we fire many
 * calls concurrently we burst past 20 TPS, get throttled, and the SDK's
 * exponential-backoff retries balloon a single document's translation into tens
 * of seconds — which, because the Payload afterChange hook runs INSIDE the save
 * transaction, used to hit the Lambda timeout and roll the publish back.
 *
 * So we deliberately PACE call starts below the quota (a tiny token bucket) — no
 * throttling means no backoff, so throughput is steady and predictable. At ~16/s
 * a typical edit (a handful of strings) finishes in well under a second; a large
 * never-before-translated document is bounded by the caller's deadline instead of
 * hanging. `maxAttempts: 2` keeps any residual retry from stacking.
 */
const MAX_REQUESTS_PER_SECOND = 16
const MIN_CALL_INTERVAL_MS = 1000 / MAX_REQUESTS_PER_SECOND

/** True when the pipeline is switched on (deployed stages set this to 'true'). */
export function isTranslationConfigured(): boolean {
  return process.env.TRANSLATE_ENABLED === 'true'
}

let client: TranslateClient | null = null
function getClient(): TranslateClient {
  if (!client) {
    // Region from the standard env (SST sets AWS_REGION; defaults for safety).
    // maxAttempts: 2 — one retry only, so a throttle can't cascade into long
    // backoff (we pace below the quota precisely to avoid throttling in the
    // first place, per the note above).
    client = new TranslateClient({
      region: process.env.AWS_REGION || 'eu-central-1',
      maxAttempts: 2,
    })
  }
  return client
}

// Token bucket: the timestamp the next call is allowed to START. Shared across
// all in-flight translations (both target locales) so the combined rate stays
// under the account quota.
let nextAllowedStart = 0
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Translation deadline exceeded'))
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('Translation deadline exceeded'))
      },
      { once: true },
    )
  })
}
async function paceCall(signal?: AbortSignal): Promise<void> {
  const now = Date.now()
  const wait = Math.max(0, nextAllowedStart - now)
  nextAllowedStart = Math.max(now, nextAllowedStart) + MIN_CALL_INTERVAL_MS
  if (wait > 0) await sleep(wait, signal)
}

/**
 * Seam for unit tests: when set, replaces the single-string AWS call so the
 * pipeline can be exercised with no AWS access (mirrors the `__reset…ForTests`
 * pattern used elsewhere in the codebase). Test impl bypasses pacing/AWS.
 */
type TranslateImpl = (text: string, target: TargetLocale) => Promise<string>
let translateImplForTests: TranslateImpl | null = null
export function __setTranslateImplForTests(fn: TranslateImpl | null): void {
  translateImplForTests = fn
}

/** Translate a single string EN → target via AWS Translate (or the test seam). */
async function translateOne(
  text: string,
  target: TargetLocale,
  signal?: AbortSignal,
): Promise<string> {
  if (translateImplForTests) return translateImplForTests(text, target)
  await paceCall(signal) // stay under the TPS quota (no throttling → no backoff)
  const res = await getClient().send(
    new TranslateTextCommand({
      Text: text,
      SourceLanguageCode: SOURCE_LANGUAGE_CODE,
      TargetLanguageCode: target,
      Settings: { Formality: FORMALITY },
    }),
    { abortSignal: signal },
  )
  return res.TranslatedText ?? text
}

/**
 * Translate an ordered batch of plain strings EN → `target`, preserving order.
 * Fans out (calls overlap in flight) but each call's START is paced below the TPS
 * quota, so throughput is steady and never triggers throttling/backoff. Rejects
 * if the shared `signal` deadline fires or an underlying call throws; the caller
 * (the hook) makes a failure non-fatal to the content save.
 */
export async function translateTexts(
  texts: string[],
  target: TargetLocale,
  signal?: AbortSignal,
): Promise<string[]> {
  if (texts.length === 0) return []
  const out = new Array<string>(texts.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < texts.length) {
      const index = cursor++
      out[index] = await translateOne(texts[index], target, signal)
    }
  }
  // Enough workers to keep the paced pipeline full without over-allocating.
  const workerCount = Math.min(texts.length, MAX_REQUESTS_PER_SECOND)
  await Promise.all(Array.from({ length: workerCount }, worker))
  return out
}

/**
 * Translate a set of unique strings and return a lookup map (source →
 * translated). Empty/whitespace-only sources are dropped and never sent. Callers
 * translate once per target and reuse the map to fill every occurrence
 * (including repeated strings), minimising cost.
 */
export async function buildTranslationMap(
  sources: Iterable<string>,
  target: TargetLocale,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(Array.from(sources).filter((s) => s.trim().length > 0)))
  if (unique.length === 0) return new Map()
  const translated = await translateTexts(unique, target, signal)
  const map = new Map<string, string>()
  unique.forEach((src, idx) => map.set(src, translated[idx] ?? src))
  return map
}
