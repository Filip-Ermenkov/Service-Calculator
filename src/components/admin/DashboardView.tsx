import { Gutter } from '@payloadcms/ui'
import { redirect } from 'next/navigation'
import type { AdminViewServerProps } from 'payload'

import { isStepUpVerifiedFromCookieMap } from '@/lib/totp/requestHelpers'
import { buildInventory, summarize, type InventoryInput } from '@/lib/translation/inventory'
import { TRANSLATABLE_FIELDS } from '@/lib/translation/registry'

import { AdminDashboard, type RecentChange } from './AdminDashboard'
import { AdminPageTitle } from './AdminPageTitle'

/**
 * Custom admin Dashboard — overrides Payload's default `/admin` view. Payload
 * renders it INSIDE DefaultTemplate, so we output content only (no template
 * wrapper — that would double the shell). Auth + TOTP gate applied here.
 */

const RECENT_COLLECTIONS: { slug: 'services' | 'projects' | 'career-listings'; type: RecentChange['type'] }[] = [
  { slug: 'services', type: 'Service' },
  { slug: 'projects', type: 'Project' },
  { slug: 'career-listings', type: 'Career' },
]

function relativeTime(iso: string | undefined): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffMs = Date.now() - then
  const mins = Math.round(diffMs / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  const sameDay = new Date(then).toDateString() === new Date().toDateString()
  if (sameDay) return `Today, ${new Date(then).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
  const days = Math.round(hrs / 24)
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`
  const weeks = Math.round(days / 7)
  if (weeks < 5) return `${weeks} week${weeks > 1 ? 's' : ''} ago`
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default async function DashboardView(props: AdminViewServerProps) {
  const { initPageResult, payload } = props
  const { req, cookies } = initPageResult

  if (!req.user) redirect('/admin/login')
  if (!req.user.totpEnabled) redirect('/admin/totp-setup')
  if (!isStepUpVerifiedFromCookieMap(cookies, String(req.user.id))) redirect('/admin/totp-verify')

  const adminRoute = payload.config.routes?.admin || '/admin'

  const countOf = async (collection: 'services' | 'projects' | 'career-listings'): Promise<number> => {
    try {
      const res = await payload.count({ collection, overrideAccess: true, req })
      return res.totalDocs
    } catch {
      return 0
    }
  }

  // Recent content changes across the three content collections.
  const collectRecent = async (): Promise<RecentChange[]> => {
    const out: RecentChange[] = []
    for (const { slug, type } of RECENT_COLLECTIONS) {
      try {
        const res = await payload.find({
          collection: slug,
          locale: 'en',
          depth: 0,
          limit: 5,
          sort: '-updatedAt',
          overrideAccess: true,
          draft: true,
          req,
        })
        for (const doc of res.docs as unknown as Record<string, unknown>[]) {
          out.push({
            title: (typeof doc.title === 'string' && doc.title) || `${type} #${String(doc.id)}`,
            type,
            when: relativeTime(doc.updatedAt as string | undefined),
            updatedAt: (doc.updatedAt as string) || '',
            status: (doc._status as string) === 'draft' ? 'draft' : 'published',
          })
        }
      } catch {
        /* ignore a failing collection */
      }
    }
    return out
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
      .slice(0, 5)
  }

  // Pending translations = target leaves still untranslated (same inventory the
  // Translations screen uses). Best-effort; 0 on any failure.
  const pendingTranslations = async (): Promise<number> => {
    try {
      const inputs: InventoryInput[] = []
      const collections: { slug: string; label: string }[] = [
        { slug: 'services', label: 'Services' },
        { slug: 'projects', label: 'Projects' },
        { slug: 'career-listings', label: 'Career Listings' },
      ]
      const globals: { slug: string; label: string }[] = [
        { slug: 'company-info', label: 'Company Info' },
        { slug: 'legal-info', label: 'Legal & Privacy' },
      ]
      for (const { slug, label } of collections) {
        if (!(slug in TRANSLATABLE_FIELDS)) continue
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
          inputs.push({ entity: slug, isGlobal: false, docId: doc.id as string | number, docLabel: label, data: doc })
        }
      }
      for (const { slug, label } of globals) {
        if (!(slug in TRANSLATABLE_FIELDS)) continue
        const data = (await payload.findGlobal({ slug: slug as never, locale: 'all', depth: 0, overrideAccess: true, draft: true, req })) as Record<string, unknown>
        inputs.push({ entity: slug, isGlobal: true, docLabel: label, data })
      }
      const stats = summarize(buildInventory(inputs))
      return stats.untranslated.fr + stats.untranslated.de
    } catch {
      return 0
    }
  }

  const [services, projects, careers, recent, pending] = await Promise.all([
    countOf('services'),
    countOf('projects'),
    countOf('career-listings'),
    collectRecent(),
    pendingTranslations(),
  ])

  const firstName = (() => {
    const email = typeof (req.user as { email?: unknown }).email === 'string' ? (req.user as { email: string }).email : ''
    return email ? email.split('@')[0] : 'Admin'
  })()

  return (
    <Gutter>
      {/* The top bar carries the page title on every admin screen; a custom
          Root View has to publish its own breadcrumb for it (see
          AdminPageTitle.tsx). */}
      <AdminPageTitle title="Dashboard" />
      <AdminDashboard
        adminRoute={adminRoute}
        userName={firstName}
        counts={{ services, projects, careers, pendingTranslations: pending }}
        recent={recent}
      />
    </Gutter>
  )
}
