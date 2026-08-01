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
/** Bound fan-out so a rich-text field with many leaves can't burst the API. */
const MAX_CONCURRENCY = 5

/** True when the pipeline is switched on (deployed stages set this to 'true'). */
export function isTranslationConfigured(): boolean {
  return process.env.TRANSLATE_ENABLED === 'true'
}

let client: TranslateClient | null = null
function getClient(): TranslateClient {
  if (!client) {
    // Region from the standard env (SST sets AWS_REGION; defaults for safety).
    client = new TranslateClient({ region: process.env.AWS_REGION || 'eu-central-1' })
  }
  return client
}

/**
 * Seam for unit tests: when set, replaces the single-string AWS call so the
 * pipeline can be exercised with no AWS access (mirrors the `__reset…ForTests`
 * pattern used elsewhere in the codebase).
 */
type TranslateImpl = (text: string, target: TargetLocale) => Promise<string>
let translateImplForTests: TranslateImpl | null = null
export function __setTranslateImplForTests(fn: TranslateImpl | null): void {
  translateImplForTests = fn
}

/** Translate a single string EN → target via AWS Translate (or the test seam). */
async function translateOne(text: string, target: TargetLocale): Promise<string> {
  if (translateImplForTests) return translateImplForTests(text, target)
  const res = await getClient().send(
    new TranslateTextCommand({
      Text: text,
      SourceLanguageCode: SOURCE_LANGUAGE_CODE,
      TargetLanguageCode: target,
      Settings: { Formality: FORMALITY },
    }),
  )
  return res.TranslatedText ?? text
}

/**
 * Translate an ordered batch of plain strings EN → `target`, preserving order.
 * AWS Translate's real-time API is one-string-per-call, so this fans out with a
 * small concurrency cap (the string counts here are tiny — a handful per save).
 * Throws if any underlying call throws; the caller (the hook) makes a failure
 * non-fatal to the content save.
 */
export async function translateTexts(texts: string[], target: TargetLocale): Promise<string[]> {
  if (texts.length === 0) return []
  const out = new Array<string>(texts.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < texts.length) {
      const index = cursor++
      out[index] = await translateOne(texts[index], target)
    }
  }
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, texts.length) }, worker)
  await Promise.all(workers)
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
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(Array.from(sources).filter((s) => s.trim().length > 0)))
  if (unique.length === 0) return new Map()
  const translated = await translateTexts(unique, target)
  const map = new Map<string, string>()
  unique.forEach((src, idx) => map.set(src, translated[idx] ?? src))
  return map
}
