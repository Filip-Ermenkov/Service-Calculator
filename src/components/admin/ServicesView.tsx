import { DefaultTemplate } from '@payloadcms/next/templates'
import { Gutter } from '@payloadcms/ui'
import { redirect } from 'next/navigation'
import type { AdminViewServerProps } from 'payload'

import { isStepUpVerifiedFromCookieMap } from '@/lib/totp/requestHelpers'

import { AdminPageTitle } from './AdminPageTitle'
import { ServicesManager, type ServiceRow } from './ServicesManager'

/**
 * Services management — a custom admin Root View at /admin/services, matching
 * /prototype/admin/services. It REPLACES Payload's default Services list as the
 * screen the admin nav points to (AdminNav "Services" → /admin/services), while
 * document editing still uses Payload's native editor at
 * /admin/collections/services/<id>.
 *
 * It lists every service in drag order (the order the public Home page uses),
 * with a compact summary of each (Home-page card completeness, calculator-field
 * count, publish status) and inline Edit / Preview / Delete actions, plus the
 * Home-page "number of cards" setting. Reads go through the Local API with the
 * TOTP gate applied here first (mirrors TranslationsView); all writes go through
 * /api/admin/services, which re-checks the same boundary independently.
 */

function relativeEdited(iso: string | undefined): string {
  if (!iso) return 'Last edited: —'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'Last edited: —'
  const days = Math.floor((Date.now() - then) / 86_400_000)
  if (days <= 0) return 'Last edited: today'
  if (days === 1) return 'Last edited: yesterday'
  if (days < 7) return `Last edited: ${days} days ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `Last edited: ${weeks} week${weeks > 1 ? 's' : ''} ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `Last edited: ${months} month${months > 1 ? 's' : ''} ago`
  const years = Math.floor(days / 365)
  return `Last edited: ${years} year${years > 1 ? 's' : ''} ago`
}

function hasUpload(v: unknown): boolean {
  return typeof v === 'number' || (typeof v === 'object' && v !== null)
}

export default async function ServicesView(props: AdminViewServerProps) {
  const { initPageResult, params, searchParams, i18n, payload, permissions, locale } = props
  const { req, cookies } = initPageResult

  if (!req.user) redirect('/admin/login')
  if (!req.user.totpEnabled) redirect('/admin/totp-setup')
  if (!isStepUpVerifiedFromCookieMap(cookies, String(req.user.id))) redirect('/admin/totp-verify')

  const adminRoute = payload.config.routes?.admin || '/admin'

  const res = await payload.find({
    collection: 'services',
    locale: 'en',
    depth: 1,
    limit: 1000,
    pagination: false,
    sort: '_order',
    overrideAccess: true,
    draft: true,
    req,
  })

  const rows: ServiceRow[] = (res.docs as unknown as Record<string, unknown>[]).map((d) => {
    const card = (d.card as Record<string, unknown> | undefined) ?? {}
    const hasPhoto = hasUpload(card.cardImage) || hasUpload(d.heroImage)
    const hasText =
      (typeof card.cardTitle === 'string' && card.cardTitle.trim().length > 0) ||
      (typeof card.cardDescription === 'string' && card.cardDescription.trim().length > 0)
    const fieldCount = Array.isArray(d.calculatorFields) ? (d.calculatorFields as unknown[]).length : 0
    const status = (d._status as string) === 'draft' ? 'draft' : 'published'
    return {
      id: d.id as string | number,
      title: (typeof d.title === 'string' && d.title) || `Service #${String(d.id)}`,
      slug: typeof d.slug === 'string' ? d.slug : String(d.id),
      edited: relativeEdited(d.updatedAt as string | undefined),
      homeCard: `${hasPhoto ? 'Photo set' : 'No photo'} · ${hasText ? 'Card text set' : 'No card text'}`,
      fieldCount,
      status,
    }
  })

  let limit = 0
  try {
    const settings = (await payload.findGlobal({
      slug: 'home-settings' as never,
      depth: 0,
      overrideAccess: true,
      req,
    })) as Record<string, unknown>
    if (typeof settings?.serviceCardLimit === 'number') limit = settings.serviceCardLimit
  } catch {
    // The home-settings singleton may not exist yet on a first boot (before the
    // migration/push has run), so fall back to 0 = show all.
    //
    // NB: keep this a `//` comment. Written as a block comment starting with the
    // word "global", ESLint parses it as a `/* global ... */` CONFIGURATION
    // directive and declares every word in it as a global variable — which is
    // exactly what happened here, producing 13 phantom `no-unused-vars` warnings
    // ('may', 'not', 'exist', …) that looked like noise from the linter rather
    // than a comment defect.
  }

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
        <AdminPageTitle title="Services" />
        <ServicesManager rows={rows} adminRoute={adminRoute} previewBase="/en" limit={limit} />
      </Gutter>
    </DefaultTemplate>
  )
}
