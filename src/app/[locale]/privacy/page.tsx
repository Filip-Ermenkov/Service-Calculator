import type { Metadata } from 'next'
import { getTranslations, setRequestLocale } from 'next-intl/server'

import { RichText } from '@/components/site/RichText'
import type { Locale } from '@/i18n/routing'
import { getLegalInfo } from '@/lib/content'
import { pageMetadata } from '@/lib/seo'

export const revalidate = 300

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'Legal' })
  const tm = await getTranslations({ locale, namespace: 'Metadata' })
  return pageMetadata({
    locale: locale as Locale,
    path: '/privacy',
    title: t('privacyTitle'),
    description: tm('privacyDescription'),
  })
}

export default async function PrivacyPolicyPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  setRequestLocale(locale)

  const t = await getTranslations({ locale, namespace: 'Legal' })
  const legal = await getLegalInfo(locale as Locale)

  // Same publish gate as the Legal Notice: only a *published* LegalInfo exposes
  // its Privacy Policy content publicly (drafts stay private).
  const showContent = legal?._status === 'published' && Boolean(legal?.privacyPolicyContent)

  return (
    <>
      <section className="grid-bg" style={{ padding: '4rem 0 3rem' }}>
        <div className="container">
          <h1 className="display-lg" style={{ color: '#fff' }}>
            {t('privacyTitle')}
          </h1>
        </div>
      </section>

      <section className="section bg-white">
        <div className="container" style={{ maxWidth: 760 }}>
          {showContent ? (
            <RichText data={legal!.privacyPolicyContent} className="prose" />
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
