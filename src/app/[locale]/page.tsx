import type { Metadata } from 'next'
import { getTranslations, setRequestLocale } from 'next-intl/server'

import { JsonLd } from '@/components/site/JsonLd'
import { ArrowRight, Bolt } from '@/components/site/icons'
import { Link } from '@/i18n/navigation'
import type { Locale } from '@/i18n/routing'
import { getCompanyInfo, getServices, mediaProps } from '@/lib/content'
import { SITE_URL, pageMetadata } from '@/lib/seo'

// ISR: statically generated, revalidated at most every 5 minutes (the always-
// correct safety net alongside the on-demand revalidation in src/lib/revalidate.ts).
export const revalidate = 300

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'Metadata' })
  return pageMetadata({ locale: locale as Locale, path: '/', description: t('defaultDescription') })
}

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  setRequestLocale(locale)

  const t = await getTranslations({ locale, namespace: 'Home' })
  const services = await getServices(locale as Locale)
  const company = await getCompanyInfo(locale as Locale)

  const localBusiness = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: 'Bulbau',
    url: `${SITE_URL}/${locale}`,
    areaServed: 'LU',
    ...(company?.email ? { email: company.email } : {}),
    ...(company?.phone ? { telephone: company.phone } : {}),
  }

  return (
    <>
      <JsonLd data={localBusiness} />

      {/* Hero */}
      <section className="grid-bg hero" style={{ minHeight: 640, padding: '6rem 0' }}>
        <div
          aria-hidden="true"
          style={{ position: 'absolute', top: '2.5rem', left: '2rem', width: 40, height: 40, borderTop: '2px solid rgba(224,90,0,0.4)', borderLeft: '2px solid rgba(224,90,0,0.4)' }}
        />
        <div
          aria-hidden="true"
          style={{ position: 'absolute', bottom: '2.5rem', right: '2rem', width: 40, height: 40, borderBottom: '2px solid rgba(224,90,0,0.4)', borderRight: '2px solid rgba(224,90,0,0.4)' }}
        />
        <div className="container">
          <div className="hero-content">
            <div className="hero-badge">{t('heroBadge')}</div>
            <h1 className="display-xl" style={{ color: '#fff', maxWidth: 780, lineHeight: 1.02 }}>
              {t('heroTitleLine1')}
              <br />
              <span style={{ color: 'var(--orange)' }}>{t('heroTitleAccent')}</span>
              <br />
              {t('heroTitleLine3')}
            </h1>
            <p style={{ color: 'var(--g400)', fontSize: '1.0625rem', marginTop: '1.5rem', maxWidth: 500, lineHeight: 1.7 }}>
              {t('heroSubtitle')}
            </p>
            <div className="flex gap-2 flex-wrap" style={{ marginTop: '2.5rem' }}>
              <Link href="/about" className="btn btn-primary btn-lg">
                {t('heroGetInTouch')}
              </Link>
              <Link href="/projects" className="btn btn-outline-white btn-lg">
                {t('heroViewProjects')}
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Services */}
      <section className="section bg-white">
        <div className="container">
          <div style={{ marginBottom: '3rem' }}>
            <span className="eyebrow">{t('servicesEyebrow')}</span>
            <h2 className="display-lg heading-accent">{t('servicesTitle')}</h2>
            <p style={{ color: 'var(--g500)', maxWidth: 540, marginTop: '0.75rem', fontSize: '0.9375rem' }}>
              {t('servicesSubtitle')}
            </p>
          </div>

          {services.length === 0 ? (
            <div className="empty-state">
              <p className="empty-state-title">{t('servicesEmpty')}</p>
            </div>
          ) : (
            <div className="services-grid">
              {services.map((service) => {
                const img = mediaProps(service.card?.cardImage ?? service.heroImage)
                const title = service.card?.cardTitle || service.title
                return (
                  <Link key={service.id} href={`/services/${service.id}`} className="service-card">
                    <div className="service-card-img">
                      <div className="card-img-inner img-ph" style={{ height: 200 }}>
                        {img ? (
                          <img src={img.url} alt={img.alt} className="media-cover" loading="lazy" />
                        ) : (
                          <Bolt />
                        )}
                      </div>
                    </div>
                    <div className="service-card-body">
                      <div className="service-card-title">{title}</div>
                      {service.card?.cardDescription && (
                        <p className="service-card-desc">{service.card.cardDescription}</p>
                      )}
                      <div className="card-arrow">
                        {t('cardCalculate')}
                        <ArrowRight width={14} height={14} strokeWidth={2.5} />
                      </div>
                    </div>
                  </Link>
                )
              })}
            </div>
          )}
        </div>
      </section>

      {/* Stats strip */}
      <section className="section grid-bg-light">
        <div className="container">
          <div className="grid-3" style={{ gap: '2.5rem' }}>
            {[
              { value: t('statProjects'), label: t('statProjectsLabel') },
              { value: t('statYears'), label: t('statYearsLabel') },
              { value: t('statCertified'), label: t('statCertifiedLabel') },
            ].map((stat) => (
              <div key={stat.label}>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: '3rem', fontWeight: 900, color: 'var(--orange)', lineHeight: 1 }}>
                  {stat.value}
                </div>
                <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--g600)', marginTop: '0.35rem' }}>
                  {stat.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="section bg-black">
        <div className="container" style={{ textAlign: 'center' }}>
          <span className="eyebrow">{t('ctaEyebrow')}</span>
          <h2 className="display-lg" style={{ color: '#fff', maxWidth: 600, margin: '0 auto 1.5rem' }}>
            {t('ctaTitle')}
          </h2>
          <p style={{ color: 'var(--g400)', maxWidth: 480, margin: '0 auto 2rem', fontSize: '0.9375rem' }}>
            {t('ctaSubtitle')}
          </p>
          <div className="flex gap-2 justify-center flex-wrap">
            <Link href="/about" className="btn btn-primary btn-lg">
              {t('ctaContact')}
            </Link>
            <Link href="/projects" className="btn btn-outline-white btn-lg">
              {t('ctaSeeWork')}
            </Link>
          </div>
        </div>
      </section>
    </>
  )
}
