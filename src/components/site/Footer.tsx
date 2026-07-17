import { getTranslations } from 'next-intl/server'

import { Link } from '@/i18n/navigation'
import type { Locale } from '@/i18n/routing'
import { getCompanyInfo } from '@/lib/content'
import { Facebook, Instagram } from './icons'

/**
 * Sitewide footer (FUNCTIONALITY §2.4). Server component: pulls contact details
 * and social links from the CompanyInfo global so a single admin edit
 * propagates everywhere. Every element is rendered defensively — the site still
 * looks right before the admin has filled CompanyInfo in.
 */
export async function Footer({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: 'Footer' })
  const tn = await getTranslations({ locale, namespace: 'Nav' })
  const company = await getCompanyInfo(locale)
  const siteName = 'Bulbau'
  const year = String(new Date().getFullYear())

  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div className="footer-col">
          <Link href="/" className="logo" style={{ marginBottom: '1rem', display: 'inline-flex' }}>
            <span className="logo-mark" aria-hidden="true">
              B
            </span>
            <span className="logo-name" style={{ marginLeft: '0.75rem' }}>
              {siteName}
            </span>
          </Link>
          <p>{t('tagline')}</p>
          {(company?.facebookUrl || company?.instagramUrl) && (
            <div className="footer-social">
              {company?.facebookUrl && (
                <a
                  href={company.facebookUrl}
                  aria-label={t('facebook')}
                  title={t('facebook')}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Facebook width={16} height={16} />
                </a>
              )}
              {company?.instagramUrl && (
                <a
                  href={company.instagramUrl}
                  aria-label={t('instagram')}
                  title={t('instagram')}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Instagram width={16} height={16} />
                </a>
              )}
            </div>
          )}
        </div>

        <div className="footer-col">
          <h4>{t('navigation')}</h4>
          <ul>
            <li>
              <Link href="/">{tn('home')}</Link>
            </li>
            <li>
              <Link href="/projects">{tn('projects')}</Link>
            </li>
            <li>
              <Link href="/about">{tn('about')}</Link>
            </li>
            <li>
              <Link href="/careers">{tn('careers')}</Link>
            </li>
          </ul>
        </div>

        <div className="footer-col">
          <h4>{t('legal')}</h4>
          <ul>
            <li>
              <Link href="/privacy">{t('privacyPolicy')}</Link>
            </li>
            <li>
              <Link href="/legal">{t('legalNotice')}</Link>
            </li>
          </ul>
        </div>

        <div className="footer-col">
          <h4>{t('contact')}</h4>
          <ul>
            {company?.phone && (
              <li>
                <a href={`tel:${company.phone.replace(/\s+/g, '')}`}>{company.phone}</a>
              </li>
            )}
            {company?.email && (
              <li>
                <a href={`mailto:${company.email}`}>{company.email}</a>
              </li>
            )}
          </ul>
        </div>
      </div>
      <div className="footer-bottom">
        <span>{t('rights', { year, name: siteName })}</span>
        <span>bulbau.lu</span>
      </div>
    </footer>
  )
}
