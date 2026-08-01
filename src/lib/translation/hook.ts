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
 * explicitly not for serverless, and the queue-on-Lambda alternative (an external
 * cron hitting /api/payload-jobs/run) adds a jobs table + migration + a cron
 * Lambda + cron-auth secret AND breaks the spec's own "immediately live in all
 * three languages" requirement by up to a cron interval. For a single-admin,
 * low-volume CMS the synchronous hook is simpler, immediate, migration-free, and
 * fits the "periodic maintenance only" goal. The translation latency (well under
 * a second at this string volume) is borne only by the admin, never a visitor.
 *
 * Safety properties:
 *   • Only fires for saves in the source locale (EN). A save in FR/DE (a manual
 *     edit / future override) is left untouched.
 *   • Never recurses: our own FR/DE writes carry `skipAutoTranslate` in context
 *     AND run in a non-EN locale, so both guards stop re-entry.
 *   • Never blocks the content save: each target is wrapped in try/catch, so a
 *     translation-provider outage/error logs a warning and the EN save still
 *     succeeds (FR/DE then fall back to EN via Payload's localization fallback).
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

  const writeContext = { skipAutoTranslate: true, disableRevalidate: true }

  for (const target of TARGETS) {
    try {
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
      if (paths.length === 0) continue

      const sources = collectSources(slug, enSource, paths)
      const map =
        sources.length > 0 ? await buildTranslationMap(sources, target) : new Map<string, string>()
      const data = applyTranslations(slug, base, enSource, paths, map)
      if (hasDrafts) data._status = status

      if (isGlobal) {
        await (payload.updateGlobal as CallableFunction)({
          slug,
          locale: target,
          data,
          draft: isDraft,
          overrideAccess: true,
          context: writeContext,
          req,
        })
      } else {
        await (payload.update as CallableFunction)({
          collection: slug,
          id,
          locale: target,
          data,
          draft: isDraft,
          overrideAccess: true,
          context: writeContext,
          req,
        })
      }
    } catch (err) {
      payload.logger?.warn?.(
        `[translate] ${slug}${id !== undefined ? `#${id}` : ''} → ${target} failed: ${
          (err as Error)?.message ?? err
        }`,
      )
    }
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
