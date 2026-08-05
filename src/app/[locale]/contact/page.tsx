import type { Metadata } from 'next'
import { getTranslations, setRequestLocale } from 'next-intl/server'

import { ContactForm } from '@/components/site/ContactForm'
import { Facebook, Instagram, Mail, Phone } from '@/components/site/icons'
import type { Locale } from '@/i18n/routing'
import { getCompanyInfo } from '@/lib/content'
import { pageMetadata } from '@/lib/seo'

// Static page (no CMS-localized body); the contact details come from CompanyInfo,
// revalidated on demand like the rest of the site. ISR safety-net window.
export const revalidate = 300

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'Contact' })
  return pageMetadata({
    locale: locale as Locale,
    path: '/contact',
    title: t('title'),
    description: t('metaDescription'),
  })
}

export default async function ContactPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  setRequestLocale(locale)

  const t = await getTranslations({ locale, namespace: 'Contact' })
  const company = await getCompanyInfo(locale as Locale)

  return (
    <>
      <section className="grid-bg" style={{ padding: '4rem 0 3rem' }}>
        <div className="container">
          <span className="eyebrow">{t('eyebrow')}</span>
          <h1 className="display-lg" style={{ color: '#fff' }}>
            {t('title')}
          </h1>
          <p style={{ color: 'var(--g300)', maxWidth: '38rem', marginTop: '0.75rem' }}>
            {t('intro')}
          </p>
        </div>
      </section>

      <section className="section bg-white">
        <div className="container">
          <div
            className="grid-2-about"
            style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: '3rem', alignItems: 'start' }}
          >
            <div>
              <span className="eyebrow">{t('formEyebrow')}</span>
              <h2 className="display-md heading-accent" style={{ marginBottom: '1.5rem' }}>
                {t('formTitle')}
              </h2>
              <ContactForm phone={company?.phone ?? null} email={company?.email ?? null} />
            </div>

            <aside>
              <span className="eyebrow">{t('detailsEyebrow')}</span>
              <h2 className="display-md heading-accent" style={{ marginBottom: '0.5rem' }}>
                {t('detailsTitle')}
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
                {t('privacyNote')}
              </p>
            </aside>
          </div>
        </div>
      </section>
    </>
  )
}
