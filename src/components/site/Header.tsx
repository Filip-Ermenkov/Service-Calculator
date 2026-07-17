'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'

import { Link, usePathname } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { Close, Menu } from './icons'

const NAV = [
  { href: '/', key: 'home' },
  { href: '/projects', key: 'projects' },
  { href: '/about', key: 'about' },
  { href: '/careers', key: 'careers' },
] as const

/**
 * Sitewide header: logo, primary nav, language switcher, and a mobile menu.
 * Client component because it owns the mobile-menu open state and reads the
 * active route (usePathname) to mark the current nav item. Labels come from the
 * i18n message catalogs; the language switcher renders real, crawlable anchors
 * (progressive enhancement — it works without JavaScript) that keep the current
 * path while swapping the locale prefix.
 */
export function Header() {
  const t = useTranslations('Nav')
  const th = useTranslations('Header')
  const tl = useTranslations('LanguageSwitcher')
  const locale = useLocale()
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  const isActive = (href: string) =>
    href === '/'
      ? pathname === '/'
      : pathname === href || pathname.startsWith(`${href}/`)

  return (
    <header className="site-header">
      <nav aria-label="Primary">
        <Link href="/" className="logo" aria-label={th('homeAria')}>
          <span className="logo-mark" aria-hidden="true">
            B
          </span>
          <span className="logo-name">Bulbau</span>
        </Link>

        <ul className="nav-links">
          {NAV.map(({ href, key }) => (
            <li key={key}>
              <Link
                href={href}
                className={isActive(href) ? 'active' : undefined}
                aria-current={isActive(href) ? 'page' : undefined}
              >
                {t(key)}
              </Link>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-2">
          <div className="lang-switcher" role="group" aria-label={tl('label')}>
            {routing.locales.map((loc) => (
              <Link
                key={loc}
                href={pathname}
                locale={loc}
                hrefLang={loc}
                className={loc === locale ? 'lang-btn active' : 'lang-btn'}
                aria-current={loc === locale ? 'true' : undefined}
              >
                {tl(loc)}
              </Link>
            ))}
          </div>

          <button
            type="button"
            className="hamburger"
            aria-label={open ? th('closeMenu') : th('openMenu')}
            aria-expanded={open}
            aria-controls="mobile-menu"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <Close width={22} height={22} /> : <Menu width={22} height={22} />}
          </button>
        </div>
      </nav>

      <div className={open ? 'mobile-menu open' : 'mobile-menu'} id="mobile-menu">
        {NAV.map(({ href, key }) => (
          <Link
            key={key}
            href={href}
            className={isActive(href) ? 'active' : undefined}
            aria-current={isActive(href) ? 'page' : undefined}
            onClick={() => setOpen(false)}
          >
            {t(key)}
          </Link>
        ))}
      </div>
    </header>
  )
}
