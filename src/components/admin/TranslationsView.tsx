import { DefaultTemplate } from '@payloadcms/next/templates'
import { Gutter } from '@payloadcms/ui'
import { redirect } from 'next/navigation'
import type { AdminViewServerProps } from 'payload'

import {
  buildInventory,
  summarize,
  type InventoryInput,
} from '@/lib/translation/inventory'
import { TRANSLATABLE_FIELDS } from '@/lib/translation/registry'
import { isStepUpVerifiedFromCookieMap } from '@/lib/totp/requestHelpers'

import { TranslationManager } from './TranslationManager'

/**
 * Translation Management — a custom admin Root View at /admin/translations
 * (FUNCTIONALITY.md §5.7, Phase 5 part 2). Registered in payload.config.ts under
 * admin.components.views; linked from the nav by TranslationsNavLink.tsx.
 *
 * It is a single cross-collection place to REVIEW every translatable string with
 * its EN source and the current FR/DE values side by side, edit a translation
 * override inline (plain text) or in the native editor (rich text), and
 * re-generate the machine translation for a field. It reads the raw per-locale
 * values via the Local API at `locale: 'all'` (no fallback), then the pure
 * inventory builder (src/lib/translation/inventory.ts) flattens them for the
 * table. Writes go through /api/admin/translations.
 *
 * Auth: this is a full Root View, so it receives initPageResult. We redirect a
 * caller who isn't logged in, or who hasn't completed the TOTP step-up, exactly
 * like TotpSetupView — and content is read with overrideAccess only AFTER that
 * gate. (The API route enforces the same boundary independently for writes.)
 */

const COLLECTION_ENTITIES: { slug: string; label: string }[] = [
  { slug: 'services', label: 'Services' },
  { slug: 'projects', label: 'Projects' },
  { slug: 'career-listings', label: 'Career Listings' },
]

const GLOBAL_ENTITIES: { slug: string; label: string }[] = [
  { slug: 'company-info', label: 'Company Info' },
  { slug: 'legal-info', label: 'Legal & Privacy' },
]

function docLabelFrom(data: Record<string, unknown>, fallback: string): string {
  const title = data.title as { en?: unknown } | undefined
  if (title && typeof title.en === 'string' && title.en.trim().length > 0) return title.en
  return fallback
}

export default async function TranslationsView(props: AdminViewServerProps) {
  const { initPageResult, params, searchParams, i18n, payload, permissions, locale } = props
  const { req, cookies } = initPageResult

  if (!req.user) {
    redirect('/admin/login')
  }
  if (!req.user.totpEnabled) {
    redirect('/admin/totp-setup')
  }
  if (!isStepUpVerifiedFromCookieMap(cookies, String(req.user.id))) {
    redirect('/admin/totp-verify')
  }

  // Read every translatable document/global at ALL locales (raw, no fallback).
  const inputs: InventoryInput[] = []

  for (const { slug, label } of COLLECTION_ENTITIES) {
    if (!(slug in TRANSLATABLE_FIELDS)) continue
    try {
      const res = await payload.find({
        collection: slug as never,
        locale: 'all',
        depth: 0,
        pagination: false,
        overrideAccess: true,
        draft: true,
        req,
      })
      for (const doc of res.docs as Record<string, unknown>[]) {
        inputs.push({
          entity: slug,
          isGlobal: false,
          docId: doc.id as string | number,
          docLabel: docLabelFrom(doc, `${label} #${String(doc.id)}`),
          data: doc,
        })
      }
    } catch (err) {
      payload.logger?.warn?.(`[translations] read ${slug} failed: ${(err as Error)?.message}`)
    }
  }

  for (const { slug, label } of GLOBAL_ENTITIES) {
    if (!(slug in TRANSLATABLE_FIELDS)) continue
    try {
      const data = (await payload.findGlobal({
        slug: slug as never,
        locale: 'all',
        depth: 0,
        overrideAccess: true,
        draft: true,
        req,
      })) as Record<string, unknown>
      inputs.push({ entity: slug, isGlobal: true, docLabel: label, data })
    } catch (err) {
      payload.logger?.warn?.(`[translations] read ${slug} failed: ${(err as Error)?.message}`)
    }
  }

  const entries = buildInventory(inputs)
  const stats = summarize(entries)
  const adminRoute = payload.config.routes?.admin || '/admin'

  return (
    <DefaultTemplate
      i18n={i18n}
      locale={locale}
      params={params}
      payload={payload}
      permissions={permissions}
      searchParams={searchParams}
      user={req.user}
      visibleEntities={initPageResult.visibleEntities}
    >
      <Gutter>
        <TranslationManager entries={entries} stats={stats} adminRoute={adminRoute} />
      </Gutter>
    </DefaultTemplate>
  )
}
