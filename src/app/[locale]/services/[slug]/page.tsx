import type { Metadata } from 'next'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { JsonLd } from '@/components/site/JsonLd'
import { RichText } from '@/components/site/RichText'
import { ServiceCalculator } from '@/components/site/ServiceCalculator'
import { ArrowLeft, Bolt, Info } from '@/components/site/icons'
import { Link } from '@/i18n/navigation'
import { routing, type Locale } from '@/i18n/routing'
import {
  getCompanyInfo,
  getPublishedServiceSlugs,
  getServiceBySlug,
  mediaProps,
} from '@/lib/content'
import { lexicalToPlainText } from '@/lib/lexical'
import { toPricingFields, type JsonLogic } from '@/lib/pricing'
import { SITE_URL, pageMetadata } from '@/lib/seo'

export const revalidate = 300

// Pre-render published services per locale; unknown/new slugs are generated
// on-demand (dynamicParams defaults to true) and then cached.
export async function generateStaticParams() {
  const slugs = await getPublishedServiceSlugs()
  return routing.locales.flatMap((locale) =>
    slugs.map((slug) => ({ locale, slug })),
  )
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>
}): Promise<Metadata> {
  const { locale, slug } = await params
  const service = await getServiceBySlug(slug, locale as Locale)
  if (!service) return {}
  const img = mediaProps(service.heroImage)
  return pageMetadata({
    locale: locale as Locale,
    path: `/services/${service.slug}`,
    title: service.title,
    description: service.card?.cardDescription ?? undefined,
    images: img ? [img.url] : undefined,
  })
}

export default async function ServicePage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>
}) {
  const { locale, slug } = await params
  setRequestLocale(locale)

  const service = await getServiceBySlug(slug, locale as Locale)
  if (!service) notFound()

  const t = await getTranslations({ locale, namespace: 'Service' })
  const company = await getCompanyInfo(locale as Locale)
  const hero = mediaProps(service.heroImage)
  // Project the CMS calculator fields into the client-safe pricing model (plain
  // strings/numbers, locale-resolved labels) — the live evaluator is Phase 3.
  const pricingFields = toPricingFields(service.calculatorFields)
  const hasCalculator = pricingFields.length > 0
  const formula = (service.formula ?? null) as JsonLogic | null
  // A rich-text field that's been *cleared* in the admin isn't null — Lexical
  // stores an empty document (a truthy object), so presence alone isn't enough.
  // Fall back to the sitewide default unless the disclaimer has real text.
  const hasOwnDisclaimer =
    !!service.disclaimer && lexicalToPlainText(service.disclaimer).trim().length > 0

  const serviceSchema = {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: service.title,
    areaServed: 'LU',
    provider: { '@type': 'LocalBusiness', name: 'Bulbau' },
    url: `${SITE_URL}/${locale}/services/${service.slug}`,
  }

  return (
    <>
      <JsonLd data={serviceSchema} />

      {/* Service hero */}
      <section className="grid-bg" style={{ padding: '4rem 0 3.5rem' }}>
        <div className="container">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: '3rem', alignItems: 'center' }} className="service-hero-grid">
            <div>
              <Link
                href="/"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', color: 'var(--g500)', fontWeight: 500, letterSpacing: '0.04em', marginBottom: '1.5rem' }}
              >
                <ArrowLeft width={12} height={12} strokeWidth={2.5} />
                {t('backToServices')}
              </Link>
              <span className="eyebrow">{t('eyebrow')}</span>
              <h1 className="display-lg" style={{ color: '#fff' }}>
                {service.title}
              </h1>
              {service.description && (
                <RichText data={service.description} className="prose prose-invert" />
              )}
            </div>
            <div className="img-ph" style={{ height: 200 }}>
              {hero ? <img src={hero.url} alt={hero.alt} className="media-cover" /> : <Bolt style={{ width: 80, height: 80 }} />}
            </div>
          </div>
        </div>
      </section>

      {/* Estimate disclaimer (prominent, before the calculator — FUNCTIONALITY §3.3).
          Only shown when there IS a calculator: with no estimator there's no
          estimate to disclaim (the no-calculator empty state speaks for itself).
          Priority: this service's own disclaimer → the sitewide default estimate
          notice (trilingual message catalog, with live contact details injected). */}
      {hasCalculator && (
        <div className="container" style={{ marginTop: '2rem' }}>
          <div className="disclaimer">
            <Info />
            <div className="disclaimer-text">
              {hasOwnDisclaimer ? (
                <RichText data={service.disclaimer} />
              ) : (
                t.rich('disclaimerDefault', {
                  strong: (chunks) => <strong>{chunks}</strong>,
                  phone: company?.phone ?? '—',
                  email: company?.email ?? '—',
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* Live price calculator (Phase 3) — real-time evaluation via @/lib/pricing */}
      <section className="section bg-white">
        <div className="container">
          <div style={{ marginBottom: '1.5rem' }}>
            <span className="eyebrow">{t('estimatorEyebrow')}</span>
            <h2 className="display-md heading-accent">{t('estimatorTitle')}</h2>
          </div>

          {!hasCalculator ? (
            <div className="empty-state">
              <p className="empty-state-title">{t('noCalculator')}</p>
            </div>
          ) : (
            <ServiceCalculator
              fields={pricingFields}
              formula={formula}
              slug={service.slug ?? slug}
              phone={company?.phone ?? null}
              email={company?.email ?? null}
            />
          )}
        </div>
      </section>
    </>
  )
}
