'use client'

import React from 'react'
import { usePathname } from 'next/navigation'
import { useAuth, useNav } from '@payloadcms/ui'

/**
 * Custom admin sidebar — replaces Payload's default Nav (registered under
 * admin.components.Nav) with the project's own `/prototype/admin` sidebar:
 * a Bulbau logo header, grouped sections (Overview / Content / Settings /
 * Localisation / Account) with icon + label nav items, an orange active rail,
 * and a "logged in as" footer. Rendered inside Payload's DefaultTemplate, so it
 * appears on every admin page.
 *
 * Client component: it reads the current path (usePathname) to mark the active
 * item and the signed-in user (useAuth) for the footer. The admin base path is
 * '/admin' (Payload default; this config doesn't override admin.routes.admin).
 */

const ADMIN = '/admin'

const icons = {
  dashboard: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></svg>
  ),
  services: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="4" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></svg>
  ),
  projects: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-6 9 6v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M9 21V12h6v9" /></svg>
  ),
  careers: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="7" width="18" height="13" rx="1" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
  ),
  media: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="1" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></svg>
  ),
  company: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="3" width="16" height="18" rx="1" /><path d="M9 8h2M13 8h2M9 12h2M13 12h2M9 16h6" /></svg>
  ),
  legal: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /></svg>
  ),
  translations: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.5 3.8 5.7 3.8 9S14.5 18.5 12 21C9.5 18.5 8.2 15.3 8.2 12S9.5 5.5 12 3z" /></svg>
  ),
  account: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" /></svg>
  ),
  logout: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>
  ),
} as const

type Item = { href: string; label: string; icon: React.ReactNode; exact?: boolean; activePrefixes?: string[] }
type Section = { label: string; items: Item[] }

const SECTIONS: Section[] = [
  { label: 'Overview', items: [{ href: `${ADMIN}`, label: 'Dashboard', icon: icons.dashboard, exact: true }] },
  {
    label: 'Content',
    items: [
      { href: `${ADMIN}/services`, label: 'Services', icon: icons.services, activePrefixes: [`${ADMIN}/collections/services`] },
      { href: `${ADMIN}/collections/projects`, label: 'Projects', icon: icons.projects },
      { href: `${ADMIN}/collections/career-listings`, label: 'Careers', icon: icons.careers },
      { href: `${ADMIN}/globals/company-info`, label: 'About & Company Info', icon: icons.company },
      { href: `${ADMIN}/collections/media`, label: 'Media', icon: icons.media },
    ],
  },
  {
    label: 'Settings',
    items: [
      { href: `${ADMIN}/globals/legal-info`, label: 'Legal & Privacy', icon: icons.legal },
    ],
  },
  { label: 'Localisation', items: [{ href: `${ADMIN}/translations`, label: 'Translations', icon: icons.translations }] },
  {
    label: 'Account',
    items: [
      { href: `${ADMIN}/account`, label: 'Account Settings', icon: icons.account },
      { href: `${ADMIN}/logout`, label: 'Sign Out', icon: icons.logout },
    ],
  },
]

export default function AdminNav() {
  const pathname = usePathname() || ''
  const { user } = useAuth()
  const { setNavOpen } = useNav()
  const email = user && typeof (user as { email?: unknown }).email === 'string' ? (user as { email: string }).email : ''

  const isActive = (item: Item) => {
    if (item.exact) return pathname === item.href
    if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return true
    return (item.activePrefixes ?? []).some((p) => pathname === p || pathname.startsWith(`${p}/`))
  }

  return (
    <aside className="bnav">
      {/* Mobile-only close button — Payload's default nav ships one (.nav__mobile-close);
          a custom nav must provide its own or there's no way to dismiss the
          full-screen mobile nav. useNav() drives Payload's open/close state. */}
      <button
        type="button"
        className="bnav-close"
        aria-label="Close menu"
        onClick={() => setNavOpen(false)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
      <a href={ADMIN} className="bnav-logo">
        <span className="bnav-logo-mark" aria-hidden="true">B</span>
        <span className="bnav-logo-text">
          <strong>Bulbau</strong>
          <span>Admin Panel</span>
        </span>
      </a>

      <nav className="bnav-scroll" aria-label="Admin">
        {SECTIONS.map((section) => (
          <div className="bnav-section" key={section.label}>
            <div className="bnav-label">{section.label}</div>
            {section.items.map((item) => {
              const active = isActive(item)
              return (
                <a
                  key={item.href}
                  href={item.href}
                  className={active ? 'bnav-item active' : 'bnav-item'}
                  aria-current={active ? 'page' : undefined}
                >
                  <span className="bnav-item-icon" aria-hidden="true">{item.icon}</span>
                  <span>{item.label}</span>
                </a>
              )
            })}
          </div>
        ))}
      </nav>

      {email ? (
        <div className="bnav-user">
          <div className="bnav-user-label">Logged in as</div>
          <div className="bnav-user-email">{email}</div>
        </div>
      ) : null}
    </aside>
  )
}
