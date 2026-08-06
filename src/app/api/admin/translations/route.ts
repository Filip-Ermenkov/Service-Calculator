/**
 * Translation Management write API (Phase 5 part 2) — FUNCTIONALITY.md §5.7.
 *
 * The Translation Management admin screen is read-only on its own (a server
 * component renders the inventory). This route is its WRITE side: it saves a
 * manual translation override for a single PLAIN-text leaf, or re-generates that
 * leaf's machine translation ("Re-translate from English").
 *
 * Rich-text leaves are NOT edited here — the screen deep-links those to Payload's
 * native localized document editor (the right tool for a Lexical tree). So this
 * route only ever touches one plain string.
 *
 * SECURITY: this is an unlocalized `/api/*` route, so `src/proxy.ts` does NOT gate
 * it (the matcher excludes `/api`). It authenticates itself: a valid Payload
 * session AND a valid TOTP step-up cookie (the same second factor the admin panel
 * requires) — mirroring the boundary in src/access/requireTotpVerified.ts. Without
 * both it returns 401/403 and never touches content.
 *
 * WRITE SAFETY: the target-locale document is read with `fallbackLocale: false`
 * (so untranslated sibling leaves come back absent, never as EN copies), a single
 * top-level field is reconstructed with the one changed leaf (src/lib/translation
 * /inventory.ts `setPlainLeaf`), and only THAT field is written — the current
 * `_status` (draft/published) is preserved exactly like the auto-translation hook,
 * so an override on published content is live immediately (§5.7) and a draft stays
 * a draft. `skipAutoTranslate` is set on the write's context as defence-in-depth
 * (the translation hook already ignores non-EN saves); the standard revalidate
 * hook still fires, so the edit reaches the public site.
 */

import { headers as getHeaders } from 'next/headers'
import { NextResponse } from 'next/server'

import { getPayloadClient } from '@/lib/content'
import { setPlainLeaf, TARGET_LOCALES, type TargetLocaleCode } from '@/lib/translation/inventory'
import {
  buildTranslationMap,
  isTranslationConfigured,
} from '@/lib/translation/provider'
import { resolveLeaves, TRANSLATABLE_FIELDS } from '@/lib/translation/registry'
import { isStepUpVerified } from '@/lib/totp/requestHelpers'

export const dynamic = 'force-dynamic'

interface WriteBody {
  entity?: string
  isGlobal?: boolean
  docId?: string | number
  registryPath?: string
  leafIndex?: number
  locale?: string
  action?: 'save' | 'retranslate'
  value?: string
}

function bad(status: number, error: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...extra }, { status })
}

export async function POST(request: Request): Promise<Response> {
  // Bound the body (a single short string; no reason for anything large).
  const contentLength = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(contentLength) && contentLength > 64 * 1024) {
    return bad(413, 'payload_too_large')
  }

  let body: WriteBody
  try {
    body = (await request.json()) as WriteBody
  } catch {
    return bad(400, 'invalid_json')
  }

  const { entity, isGlobal, docId, registryPath, leafIndex, action } = body
  const locale = body.locale as TargetLocaleCode | undefined

  // ── Validate the request shape against the registry (never trust the client) ──
  if (!entity || !(entity in TRANSLATABLE_FIELDS)) return bad(400, 'unknown_entity')
  if (!locale || !TARGET_LOCALES.includes(locale)) return bad(400, 'invalid_locale')
  if (action !== 'save' && action !== 'retranslate') return bad(400, 'invalid_action')
  if (typeof registryPath !== 'string') return bad(400, 'invalid_path')
  if (typeof leafIndex !== 'number' || leafIndex < 0 || !Number.isInteger(leafIndex)) {
    return bad(400, 'invalid_leaf')
  }
  if (!isGlobal && (docId === undefined || docId === null || docId === '')) {
    return bad(400, 'missing_doc_id')
  }

  const field = TRANSLATABLE_FIELDS[entity].find((f) => f.path === registryPath)
  if (!field) return bad(400, 'unknown_field')
  // This route only edits plain leaves; rich text is edited in the native editor.
  if (field.type !== 'plain') return bad(400, 'not_plain_text')

  if (action === 'save' && typeof body.value !== 'string') return bad(400, 'missing_value')
  if (action === 'save' && body.value!.length > 20_000) return bad(413, 'value_too_large')

  // ── AuthN/AuthZ: valid session + valid TOTP step-up cookie ──
  const payload = await getPayloadClient()
  const headers = await getHeaders()
  const { user } = await payload.auth({ headers })
  if (!user) return bad(401, 'unauthenticated')
  if (!isStepUpVerified(headers, String(user.id))) return bad(403, 'step_up_required')

  // ── Resolve the value to write ──
  let value: string
  if (action === 'save') {
    value = body.value as string
  } else {
    // Re-translate: needs the pipeline configured (deployed stages).
    if (!isTranslationConfigured()) return bad(400, 'translation_not_configured')
    const enSource = (await readDoc(payload, entity, !!isGlobal, docId, 'en')) as
      | Record<string, unknown>
      | null
    if (!enSource) return bad(404, 'document_not_found')
    const enLeaves = resolveLeaves(enSource, registryPath)
    const enLeaf = enLeaves[leafIndex]
    const enValue = typeof enLeaf?.get() === 'string' ? (enLeaf!.get() as string) : ''
    if (enValue.trim().length === 0) return bad(400, 'empty_source')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('translate_timeout')), 12_000)
    try {
      const map = await buildTranslationMap([enValue], locale, controller.signal)
      value = map.get(enValue) ?? enValue
    } catch {
      return bad(502, 'translation_failed')
    } finally {
      clearTimeout(timer)
    }
  }

  // ── Read the TARGET-locale doc without fallback, set the one leaf, write it ──
  const target = (await readDoc(payload, entity, !!isGlobal, docId, locale)) as
    | Record<string, unknown>
    | null
  if (!target) return bad(404, 'document_not_found')

  const written = setPlainLeaf(target, registryPath, leafIndex, value)
  if (!written) return bad(409, 'leaf_index_out_of_range')

  // Preserve the current publish state exactly (mirrors the translation hook).
  const status = typeof target._status === 'string' ? (target._status as string) : undefined
  const hasDrafts = status !== undefined
  const isDraft = hasDrafts && status === 'draft'

  const data: Record<string, unknown> = { [written.topLevelField]: written.fieldValue }
  if (hasDrafts) data._status = status

  const context = { skipAutoTranslate: true }

  try {
    if (isGlobal) {
      await (payload.updateGlobal as CallableFunction)({
        slug: entity,
        locale,
        fallbackLocale: false,
        depth: 0,
        draft: isDraft,
        overrideAccess: true,
        data,
        context,
      })
    } else {
      await (payload.update as CallableFunction)({
        collection: entity,
        id: docId,
        locale,
        fallbackLocale: false,
        depth: 0,
        draft: isDraft,
        overrideAccess: true,
        data,
        context,
      })
    }
  } catch (err) {
    payload.logger?.error?.(
      `[translations] write failed for ${entity}${docId !== undefined ? `#${docId}` : ''} ${registryPath}[${leafIndex}] → ${locale}: ${(err as Error)?.message ?? err}`,
    )
    return bad(500, 'write_failed')
  }

  return NextResponse.json({ ok: true, value })
}

/** Read one document/global at a locale with NO fallback (raw stored values). */
async function readDoc(
  payload: Awaited<ReturnType<typeof getPayloadClient>>,
  entity: string,
  isGlobal: boolean,
  docId: string | number | undefined,
  locale: string,
): Promise<Record<string, unknown> | null> {
  try {
    if (isGlobal) {
      return (await (payload.findGlobal as CallableFunction)({
        slug: entity,
        locale,
        fallbackLocale: false,
        depth: 0,
        overrideAccess: true,
        draft: true,
      })) as Record<string, unknown>
    }
    return (await (payload.findByID as CallableFunction)({
      collection: entity,
      id: docId,
      locale,
      fallbackLocale: false,
      depth: 0,
      overrideAccess: true,
      draft: true,
    })) as Record<string, unknown>
  } catch {
    return null
  }
}
