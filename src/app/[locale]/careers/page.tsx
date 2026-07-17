import type { Metadata } from 'next'
import { getTranslations, setRequestLocale } from 'next-intl/server'

import { RichText } from '@/components/site/RichText'
import { Briefcase, Info } from '@/components/site/icons'
import { Link } from '@/i18n/navigation'
import type { Locale } from '@/i18n/routing'
import { getCareers, getCompanyInfo, mediaProps } from '@/lib/content'
import { pageMetadata } from '@/lib/seo'

export const revalidate = 300

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'Careers' })
  return pageMetadata({
    locale: locale as Locale,
    path: '/careers',
    title: t('title'),
    description: t('subtitle'),
  })
}

export default async function CareersPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  setRequestLocale(locale)

  const t = await getTranslations({ locale, namespace: 'Careers' })
  const listings = await getCareers(locale as Locale)
  const company = await getCompanyInfo(locale as Locale)

  return (
    <>
      <section className="grid-bg" style={{ padding: '4rem 0 3rem' }}>
        <div className="container">
          <span className="eyebrow">{t('eyebrow')}</span>
          <h1 className="display-lg" style={{ color: '#fff' }}>
            {t('title')}
          </h1>
          <p style={{ color: 'var(--g400)', maxWidth: 540, marginTop: '0.75rem', fontSize: '0.9375rem' }}>
            {t('subtitle')}
          </p>
        </div>
      </section>

      {/* How to apply */}
      <div style={{ background: 'var(--orange)', padding: '1rem 0' }}>
        <div className="container">
          <div className="flex items-center gap-2 flex-wrap" style={{ color: '#fff' }}>
            <Info width={18} height={18} />
            <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>
              {t('applyNotice', {
                email: company?.email ?? '—',
                phone: company?.phone ?? '—',
              })}
            </span>
          </div>
        </div>
      </div>

      <section className="section bg-white">
        <div className="container">
          <div style={{ marginBottom: '2.5rem' }}>
            <span className="eyebrow">{t('openPositions')}</span>
            <h2 className="display-md heading-accent">{t('roleCount', { count: listings.length })}</h2>
          </div>

          {listings.length === 0 ? (
            <div className="empty-state">
              <p className="empty-state-title">{t('emptyTitle')}</p>
              <p className="empty-state-body">{t('emptyBody')}</p>
            </div>
          ) : (
            <div className="careers-grid">
              {listings.map((job) => {
                const img = mediaProps(job.photo)
                return (
                  <article className="career-card" key={job.id}>
                    <div className="career-card-img">
                      <div className="card-img-inner img-ph" style={{ height: 200 }}>
                        {img ? (
                          <img src={img.url} alt={img.alt} className="media-cover" loading="lazy" />
                        ) : (
                          <Briefcase style={{ width: 48, height: 48 }} />
                        )}
                      </div>
                    </div>
                    <div className="career-card-body">
                      <h3 className="career-card-title">{job.title}</h3>
                      {job.description && <RichText data={job.description} className="career-card-desc prose" />}
                    </div>
                    <div className="career-card-footer">
                      <span className="badge badge-green">{t('badgeOpen')}</span>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </div>
      </section>

      {/* Spontaneous application */}
      <section className="section-sm bg-black">
        <div className="container" style={{ textAlign: 'center' }}>
          <span className="eyebrow">{t('spontaneousEyebrow')}</span>
          <h2 className="display-md" style={{ color: '#fff', marginBottom: '1rem' }}>
            {t('spontaneousTitle')}
          </h2>
          <p style={{ color: 'var(--g400)', maxWidth: 480, margin: '0 auto 2rem', fontSize: '0.9375rem' }}>
            {t('spontaneousBody')}
          </p>
          <Link href="/about" className="btn btn-primary btn-lg">
            {t('spontaneousCta')}
          </Link>
        </div>
      </section>
    </>
  )
}
