'use client'

/**
 * Section headers for the Service editor — the titled bars of the prototype's
 * `.admin-form-section-header` (/prototype/admin/service-editor.html): a small
 * orange line-icon followed by the section name in condensed uppercase.
 *
 * Each export is wired to one `collapsible` field in `src/collections/Services.ts`
 * via `admin.components.Label`, which Payload renders inside the collapsible's
 * own header row (`.collapsible-field__row-label-wrap`) — so the sections stay
 * real Payload collapsibles (collapse state, error pills, preferences) and only
 * their *label* is ours. Styling lives in `src/app/(payload)/custom.scss`
 * (`.asec__label` / `.asec__icon`).
 */

import React from 'react'

function SectionLabel({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <span className="asec__label">
      <svg
        aria-hidden="true"
        className="asec__icon"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        viewBox="0 0 24 24"
      >
        {children}
      </svg>
      {title}
    </span>
  )
}

export const BasicInfoLabel = () => (
  <SectionLabel title="Basic Information">
    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
  </SectionLabel>
)

export const HomePageCardLabel = () => (
  <SectionLabel title="Home Page Card">
    <rect height="18" rx="2" width="18" x="3" y="3" />
    <path d="M3 9h18M9 21V9" />
  </SectionLabel>
)

export const CalculatorFieldsLabel = () => (
  <SectionLabel title="Calculator Fields">
    <rect height="20" rx="2" width="16" x="4" y="2" />
    <line x1="8" x2="16" y1="6" y2="6" />
    <line x1="8" x2="16" y1="10" y2="10" />
    <line x1="8" x2="12" y1="14" y2="14" />
  </SectionLabel>
)

export const PriceFormulaLabel = () => (
  <SectionLabel title="Price Formula Builder">
    <path d="M4 7h16M4 12h16M4 17h10" />
  </SectionLabel>
)

export const ProjectDetailsLabel = () => (
  <SectionLabel title="Project Details">
    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
  </SectionLabel>
)

export const JobOpeningLabel = () => (
  <SectionLabel title="Job Opening">
    <rect height="14" rx="2" width="20" x="2" y="7" />
    <path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2" />
  </SectionLabel>
)

export const AboutContentLabel = () => (
  <SectionLabel title="About Us Page — Main Content">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
  </SectionLabel>
)

export const ContactDetailsLabel = () => (
  <SectionLabel title="Company Contact Details">
    <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6A19.79 19.79 0 012.12 4.18 2 2 0 014.11 2h3a2 2 0 012 1.72c.13.96.36 1.9.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0122 16.92z" />
  </SectionLabel>
)

export const LegalDetailsLabel = () => (
  <SectionLabel title="Legal &amp; Privacy">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </SectionLabel>
)
