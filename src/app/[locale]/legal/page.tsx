import type { Metadata } from 'next'
import { getTranslations, setRequestLocale } from 'next-intl/server'

import type { Locale } from '@/i18n/routing'
import { getLegalInfo } from '@/lib/content'
import { pageMetadata } from '@/lib/seo'
import { findMissingLegalFields } from '@/globals/LegalInfo'

export const revalidate = 300

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'Legal' })
  return pageMetadata({ locale: locale as Locale, path: '/legal', title: t('legalNoticeTitle') })
}

export default async function LegalNoticePage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  setRequestLocale(locale)

  const t = await getTranslations({ locale, namespace: 'Legal' })
  const legal = await getLegalInfo(locale as Locale)

  // Belt-and-suspenders publish gate (FUNCTIONALITY §2.5 / TECHSPEC §6.9): show
  // the notice only when the global is *published* AND every required
  // registration field is present. `findGlobal` returns published-only data to
  // the public, and this reuses the same checker the publish hook enforces with,
  // so placeholder/draft legal details can never surface here.
  const isComplete =
    legal?._status === 'published' && findMissingLegalFields(legal).length === 0

  const rows: Array<{ label: string; value?: string | null; multiline?: boolean }> = legal
    ? [
        { label: t('legalNameLabel'), value: legal.legalName },
        { label: t('legalFormLabel'), value: legal.legalForm },
        { label: t('addressLabel'), value: legal.registeredAddress, multiline: true },
        { label: t('rcsLabel'), value: legal.rcsNumber },
        { label: t('vatLabel'), value: legal.vatNumber },
        { label: t('legalEmailLabel'), value: legal.legalContactEmail },
      ]
    : []

  return (
    <>
      <section className="grid-bg" style={{ padding: '4rem 0 3rem' }}>
        <div className="container">
          <h1 className="display-lg" style={{ color: '#fff' }}>
            {t('legalNoticeTitle')}
          </h1>
        </div>
      </section>

      <section className="section bg-white">
        <div className="container" style={{ maxWidth: 760 }}>
          {isComplete ? (
            <dl>
              {rows
                .filter((r) => r.value)
                .map((r) => (
                  <div key={r.label} className="contact-item" style={{ display: 'block' }}>
                    <dt className="contact-meta">{r.label}</dt>
                    <dd className="contact-value" style={{ whiteSpace: r.multiline ? 'pre-line' : undefined }}>
                      {r.value}
                    </dd>
                  </div>
                ))}
            </dl>
          ) : (
            <div className="empty-state">
              <p className="empty-state-title">{t('notAvailableTitle')}</p>
              <p className="empty-state-body">{t('notAvailableBody')}</p>
            </div>
          )}
        </div>
      </section>
    </>
  )
}
