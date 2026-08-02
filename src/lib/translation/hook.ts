/**
 * The auto-translation hook (Phase 5) — wires the pure orchestrator
 * (translateDocument.ts) to real Payload reads/writes and the translation
 * provider (AWS Translate).
 *
 * Engine: AWS Translate (see src/lib/translation/provider.ts for the DeepL →
 * AWS Translate decision). This hook is engine-agnostic — it only depends on the
 * provider's small interface.
 *
 * Design (a deliberate, researched deviation from TECHSPEC §6.7's Jobs-Queue
 * proposal — see docs/PROGRESS.md): translation runs SYNCHRONOUSLY in an
 * `afterChange` hook instead of an async queue. Payload's `autoRun` job worker is
 * explicitly not for serverless, Next's `after()` is unsupported on OpenNext AWS,
 * and a true async worker would need Payload bundled into a second Lambda — heavy
 * for a single-admin, low-volume CMS. So the synchronous hook is the proportionate
 * choice: simpler, migration-free, and the translation is present the instant the
 * save completes. It is made safe/fast by four properties below (pacing, deadline,
 * no-throw, sequential). A typical edit finishes in well under a second; the FIRST
 * translation of a large document takes a few seconds (bounded by the deadline).
 * If write volume ever grows, the async-worker upgrade is the documented path.
 *
 * Safety properties:
 *   • Only fires for saves in the source locale (EN). A save in FR/DE (a manual
 *     edit / future override) is left untouched.
 *   • Never recurses: before doing its own FR/DE writes it sets `skipAutoTranslate`
 *     on the SHARED `req.context` (a mutation, not the ambiguous per-call `context`
 *     argument), and those writes share `req`, so their afterChange re-entry hits
 *     Guard 2 and no-ops. (Getting this wrong is what caused a multi-minute,
 *     re-translating loop — see the block comment on the mutation below.)
 *   • Never blocks/rolls back the content save: AWS calls are paced under the TPS
 *     quota (no throttle→no backoff), the whole pass is bounded by a hard deadline
 *     (< the Lambda timeout), and each target is wrapped in try/catch — so a
 *     provider outage, a deadline hit, or a slow document logs a warning and the EN
 *     save still commits (FR/DE fall back to EN via Payload's localization).
 *   • Sequential, not parallel: the two locales share this save's single Postgres
 *     transaction, which can't run concurrent queries.
 *   • A no-op when TRANSLATE_ENABLED is unset (local dev / CI): the EN save
 *     proceeds and nothing is translated.
 *   • Self-healing & override-safe: a field is (re)translated when its EN source
 *     changed OR the target is still the untranslated EN fallback. So content that
 *     predates the pipeline, a field left untouched in an edit, or a field a prior
 *     run failed on all get filled on the next save — while a real translation or a
 *     manual per-locale override (both differ from the source) are left untouched.
 *     A save where every field is already translated writes nothing (no quota).
 */

import type {
  CollectionAfterChangeHook,
  GlobalAfterChangeHook,
  Payload,
  PayloadRequest,
} from 'payload'

import { buildTranslationMap, isTranslationConfigured, type TargetLocale } from './provider'
import {
  applyTranslations,
  changedTopKeys,
  collectSources,
  selectPathsToTranslate,
} from './translateDocument'

const TARGETS: TargetLocale[] = ['fr', 'de']
const SOURCE_LOCALE = 'en'

// Hard ceiling on how long translation may run inside the save. Payload's
// afterChange runs INSIDE the save transaction, so if translation ever ran long
// enough to hit the Lambda timeout the whole publish would roll back. This
// deadline (well under the function's own timeout — see sst.config.ts) guarantees
// that can't happen: if translation can't finish in time it's abandoned for this
// save (the content still commits; the untranslated fields are picked up on the
// next save by the self-healing pass). At the paced request rate this is only
// ever reached by pathologically large content, never a normal edit.
const TRANSLATION_DEADLINE_MS = 12_000

async function runAutoTranslation(params: {
  payload: Payload
  slug: string
  isGlobal: boolean
  id?: string | number
  doc: Record<string, unknown>
  previousDoc?: Record<string, unknown> | null
  req: PayloadRequest
}): Promise<void> {
  const { payload, slug, isGlobal, id, doc, previousDoc, req } = params

  // Guard 1: only translate FROM the source locale.
  const locale = req.locale ?? SOURCE_LOCALE
  if (locale !== SOURCE_LOCALE) return
  // Guard 2: don't re-enter on our own FR/DE writes.
  if ((req.context as Record<string, unknown> | undefined)?.skipAutoTranslate) return
  // Guard 3: pipeline off (TRANSLATE_ENABLED unset — dev/CI). EN save untouched.
  if (!isTranslationConfigured()) return

  // Which top-level fields changed vs the previous version (doc/previousDoc share
  // the afterChange depth, so their comparison is self-consistent).
  const changedTops = changedTopKeys(slug, doc, previousDoc)

  // Mirror the saved document's publish state onto the reads/writes below.
  const status = typeof doc._status === 'string' ? (doc._status as string) : undefined
  const hasDrafts = status !== undefined
  const isDraft = hasDrafts && status === 'draft'

  // Canonical EN source read at depth 0, so the per-field fallback comparison in
  // selectPathsToTranslate() lines up with the depth-0 target reads below (see the
  // DEPTH CONTRACT in translateDocument.ts — a populated relationship at a deeper
  // depth would otherwise make an untranslated field look already-translated).
  const enSource = (
    isGlobal
      ? await (payload.findGlobal as CallableFunction)({
          slug,
          locale: SOURCE_LOCALE,
          depth: 0,
          overrideAccess: true,
          draft: isDraft,
          req,
        })
      : await (payload.findByID as CallableFunction)({
          collection: slug,
          id,
          locale: SOURCE_LOCALE,
          depth: 0,
          overrideAccess: true,
          draft: isDraft,
          req,
        })
  ) as Record<string, unknown>

  // Bulletproof recursion + revalidation control via the SHARED req.context
  // (MUTATION, not the per-call `context` argument). Payload's handling of a
  // `context` argument WHEN a `req` is also passed is ambiguous, and if our flag
  // fails to reach the nested hook, our FR/DE writes re-trigger translation — and
  // because those writes make the FR/DE values differ from EN, every level sees a
  // "change" and re-translates, looping until the Lambda timeout (the multi-minute
  // save). Mutating the shared req.context is unambiguous:
  //   • skipAutoTranslate → the nested FR/DE writes' afterChange no-ops (Guard 2).
  //   • disableRevalidate → those writes don't each re-revalidate; it's reset in
  //     `finally` so the ORIGINAL save's revalidate hook (which runs right after
  //     this one) still fires exactly once.
  const ctx = req.context as Record<string, unknown>
  const originalSkipAutoTranslate = ctx.skipAutoTranslate
  const originalDisableRevalidate = ctx.disableRevalidate
  ctx.skipAutoTranslate = true
  ctx.disableRevalidate = true

  // Shared deadline for ALL translation calls this save, so afterChange can never
  // block the transaction long enough to hit the Lambda timeout (→ rollback). We
  // use an explicit controller (cleared in `finally`) rather than
  // AbortSignal.timeout so a fast, sub-second edit leaves no lingering timer.
  const deadlineController = new AbortController()
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(new Error('Translation deadline exceeded')),
    TRANSLATION_DEADLINE_MS,
  )
  const deadline = deadlineController.signal

  const translateTarget = async (target: TargetLocale): Promise<void> => {
    // Dynamic slug ⇒ Payload's per-collection generics can't be inferred here;
    // the reads/writes are dispatched through `any` (the runtime call is exact).
    const base = (
      isGlobal
        ? await (payload.findGlobal as CallableFunction)({
            slug,
            locale: target,
            depth: 0,
            overrideAccess: true,
            draft: isDraft,
            req,
          })
        : await (payload.findByID as CallableFunction)({
            collection: slug,
            id,
            locale: target,
            depth: 0,
            overrideAccess: true,
            draft: isDraft,
            req,
          })
    ) as Record<string, unknown>

    // Translate a field if its EN source changed OR the target is still the
    // untranslated fallback (self-healing; preserves real translations/overrides).
    const paths = selectPathsToTranslate(slug, enSource, base, changedTops)
    if (paths.length === 0) return

    const sources = collectSources(slug, enSource, paths)
    const map =
      sources.length > 0
        ? await buildTranslationMap(sources, target, deadline)
        : new Map<string, string>()
    const data = applyTranslations(slug, base, enSource, paths, map)
    if (hasDrafts) data._status = status

    if (isGlobal) {
      await (payload.updateGlobal as CallableFunction)({
        slug,
        locale: target,
        data,
        draft: isDraft,
        overrideAccess: true,
        req, // carries the mutated req.context (skip flags) — prevents recursion
      })
    } else {
      await (payload.update as CallableFunction)({
        collection: slug,
        id,
        locale: target,
        data,
        draft: isDraft,
        overrideAccess: true,
        req, // carries the mutated req.context (skip flags) — prevents recursion
      })
    }
  }

  // Targets are processed SEQUENTIALLY, not in parallel: they share this save's
  // single Payload transaction (`req`), and a Postgres transaction can't run
  // concurrent queries — parallel reads/writes on it would error or stall the
  // save. Sequential costs no extra wall-time here anyway, because the AWS calls
  // are throttle-paced by a SHARED global limiter regardless of ordering. Each
  // target is isolated in a catch so one failing (or the shared deadline firing)
  // never throws out of the hook → the EN save can't roll back.
  try {
    for (const target of TARGETS) {
      try {
        await translateTarget(target)
      } catch (err: unknown) {
        payload.logger?.warn?.(
          `[translate] ${slug}${id !== undefined ? `#${id}` : ''} → ${target} skipped: ${
            (err as Error)?.message ?? err
          }`,
        )
      }
    }
  } finally {
    clearTimeout(deadlineTimer)
    // Restore the caller's original flags (all nested writes are done by now).
    // Restoring disableRevalidate lets the ORIGINAL save's revalidate hook — which
    // runs immediately after this one — fire once. Restoring skipAutoTranslate
    // keeps this request able to translate a *different* document later (e.g. a
    // bulk/multi-save request), instead of silently skipping the rest.
    ctx.skipAutoTranslate = originalSkipAutoTranslate
    ctx.disableRevalidate = originalDisableRevalidate
  }
}

/** afterChange hook for translatable collections (Services/Projects/Careers). */
export const translateCollectionAfterChange: CollectionAfterChangeHook = async ({
  doc,
  previousDoc,
  req,
  collection,
}) => {
  await runAutoTranslation({
    payload: req.payload,
    slug: collection.slug,
    isGlobal: false,
    id: (doc as { id?: string | number }).id,
    doc: doc as Record<string, unknown>,
    previousDoc: previousDoc as Record<string, unknown> | null,
    req,
  })
  return doc
}

/** afterChange hook for translatable globals (CompanyInfo/LegalInfo). */
export const translateGlobalAfterChange: GlobalAfterChangeHook = async ({
  doc,
  previousDoc,
  req,
  global,
}) => {
  await runAutoTranslation({
    payload: req.payload,
    slug: global.slug,
    isGlobal: true,
    doc: doc as Record<string, unknown>,
    previousDoc: previousDoc as Record<string, unknown> | null,
    req,
  })
  return doc
}
