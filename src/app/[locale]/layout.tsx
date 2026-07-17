import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Inter, Barlow_Condensed } from 'next/font/google'
import { NextIntlClientProvider, hasLocale } from 'next-intl'
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { Footer } from '@/components/site/Footer'
import { Header } from '@/components/site/Header'
import { routing } from '@/i18n/routing'
import { IS_INDEXABLE, SITE_URL } from '@/lib/seo'

import './globals.css'

// Self-hosted via next/font (no layout shift, no third-party webfont request).
// Exposed as CSS variables consumed by globals.css (--font-inter/--font-barlow).
const inter = Inter({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700', '900'],
  variable: '--font-inter',
  display: 'swap',
})
const barlow = Barlow_Condensed({
  subsets: ['latin'],
  weight: ['500', '600', '700', '800', '900'],
  variable: '--font-barlow',
  display: 'swap',
})

// Render every locale at build time (next-intl static-rendering requirement).
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'Metadata' })
  return {
    metadataBase: new URL(SITE_URL),
    title: { default: t('defaultTitle'), template: `%s — ${t('siteName')}` },
    description: t('defaultDescription'),
    // Only the real production origin is indexable — staging/preview stay out of
    // search results without any manual toggling.
    robots: IS_INDEXABLE
      ? { index: true, follow: true }
      : { index: false, follow: false },
    openGraph: { siteName: t('siteName'), type: 'website', locale },
  }
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params

  // Reject any non-locale top segment that reached this dynamic route (e.g. a
  // stray path). Static routes like /admin and /api take precedence and never
  // land here; this is the safety net.
  if (!hasLocale(routing.locales, locale)) {
    notFound()
  }

  // Enable static rendering for this request (distributes the locale to
  // next-intl's server APIs without opting into dynamic `headers()` reads).
  setRequestLocale(locale)

  const t = await getTranslations({ locale, namespace: 'Header' })
  // Forward locale + messages explicitly so client components (Header) always
  // have them, independent of next-intl provider auto-inheritance behaviour.
  const messages = await getMessages({ locale })

  return (
    <html lang={locale} className={`${inter.variable} ${barlow.variable}`}>
      <body>
        {/* Keyboard/screen-reader: first focusable element jumps past the nav */}
        <a href="#main" className="skip-link">
          {t('skipToContent')}
        </a>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Header />
          <main id="main">{children}</main>
          <Footer locale={locale} />
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
