import type { Metadata } from 'next'
import { getTranslations, setRequestLocale } from 'next-intl/server'

import { RichText } from '@/components/site/RichText'
import { Facebook, Instagram, Mail, Phone } from '@/components/site/icons'
import type { Locale } from '@/i18n/routing'
import { getCompanyInfo } from '@/lib/content'
import { lexicalToPlainText } from '@/lib/lexical'
import { pageMetadata } from '@/lib/seo'

export const revalidate = 300

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'About' })
  const company = await getCompanyInfo(locale as Locale)
  return pageMetadata({
    locale: locale as Locale,
    path: '/about',
    title: t('title'),
    description: lexicalToPlainText(company?.aboutUsContent, 155) || undefined,
  })
}

export default async function AboutPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  setRequestLocale(locale)

  const t = await getTranslations({ locale, namespace: 'About' })
  const company = await getCompanyInfo(locale as Locale)

  return (
    <>
      <section className="grid-bg" style={{ padding: '4rem 0 3rem' }}>
        <div className="container">
          <span className="eyebrow">{t('eyebrow')}</span>
          <h1 className="display-lg" style={{ color: '#fff' }}>
            {t('title')}
          </h1>
        </div>
      </section>

      <section className="section bg-white">
        <div className="container">
          <div className="grid-2-about" style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: '3rem', alignItems: 'start' }}>
            <div>
              {company?.aboutUsContent ? (
                <RichText data={company.aboutUsContent} className="prose" />
              ) : (
                <p className="prose">{t('emptyContent')}</p>
              )}
            </div>

            <aside>
              <span className="eyebrow">{t('contactEyebrow')}</span>
              <h2 className="display-md heading-accent" style={{ marginBottom: '0.5rem' }}>
                {t('contactTitle')}
              </h2>
              <div>
                {company?.phone && (
                  <div className="contact-item">
                    <span className="contact-icon">
                      <Phone />
                    </span>
                    <div>
                      <div className="contact-meta">{t('phoneLabel')}</div>
                      <div className="contact-value">
                        <a href={`tel:${company.phone.replace(/\s+/g, '')}`}>{company.phone}</a>
                      </div>
                    </div>
                  </div>
                )}
                {company?.email && (
                  <div className="contact-item">
                    <span className="contact-icon">
                      <Mail />
                    </span>
                    <div>
                      <div className="contact-meta">{t('emailLabel')}</div>
                      <div className="contact-value">
                        <a href={`mailto:${company.email}`}>{company.email}</a>
                      </div>
                    </div>
                  </div>
                )}
                {company?.facebookUrl && (
                  <div className="contact-item">
                    <span className="contact-icon">
                      <Facebook />
                    </span>
                    <div>
                      <div className="contact-meta">{t('facebookLabel')}</div>
                      <div className="contact-value">
                        <a href={company.facebookUrl} target="_blank" rel="noopener noreferrer">
                          {t('facebookLabel')}
                        </a>
                      </div>
                    </div>
                  </div>
                )}
                {company?.instagramUrl && (
                  <div className="contact-item">
                    <span className="contact-icon">
                      <Instagram />
                    </span>
                    <div>
                      <div className="contact-meta">{t('instagramLabel')}</div>
                      <div className="contact-value">
                        <a href={company.instagramUrl} target="_blank" rel="noopener noreferrer">
                          {t('instagramLabel')}
                        </a>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              <p style={{ marginTop: '1.5rem', fontSize: '0.8125rem', color: 'var(--g500)', lineHeight: 1.6 }}>
                {t('formComingSoon')}
              </p>
            </aside>
          </div>
        </div>
      </section>
    </>
  )
}
