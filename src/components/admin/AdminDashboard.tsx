import React from 'react'

/**
 * Presentational admin dashboard (rendered by DashboardView inside Payload's
 * DefaultTemplate). Pure server component — links only. Matches the project's
 * /prototype/admin/dashboard: a greeting, a 4-up KPI strip, then a "Recent
 * Content Changes" table beside a "Quick Actions" column.
 */

export type RecentChange = {
  title: string
  type: 'Service' | 'Project' | 'Career'
  when: string
  updatedAt: string
  status: 'draft' | 'published'
}

type Props = {
  adminRoute: string
  userName: string
  counts: { services: number; projects: number; careers: number; pendingTranslations: number }
  recent: RecentChange[]
}

const I = {
  services: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="4" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></svg>),
  projects: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 9l9-6 9 6v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M9 21V12h6v9" /></svg>),
  careers: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" /></svg>),
  translations: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 5h10M9 3v2c0 5-2.5 8-6 9M6 9c0 3 3 5 7 6M14 21l4-9 4 9M15.5 18h5" /></svg>),
  warning: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M12 8v5M12 16.5h.01" /></svg>),
  check: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="m8 12.5 2.5 2.5L16 9.5" /></svg>),
}

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

export function AdminDashboard({ adminRoute, userName, counts, recent }: Props) {
  const a = adminRoute.replace(/\/$/, '')
  const name = userName ? userName.charAt(0).toUpperCase() + userName.slice(1) : 'Admin'

  const kpis = [
    { key: 'services', label: 'Services', value: counts.services, href: `${a}/collections/services`, icon: I.services, action: 'Manage' },
    { key: 'projects', label: 'Projects', value: counts.projects, href: `${a}/collections/projects`, icon: I.projects, action: 'Manage' },
    { key: 'careers', label: 'Open Positions', value: counts.careers, href: `${a}/collections/career-listings`, icon: I.careers, action: 'Manage' },
    { key: 'translations', label: 'Pending Translations', value: counts.pendingTranslations, href: `${a}/translations`, icon: I.translations, action: 'Review', accent: true },
  ]

  return (
    <div className="adash">
      {/* The prototype puts the page name in the top bar (`.admin-page-title`)
          and the "View website" button beside it — both are supplied globally
          here (AdminPageTitle + ViewWebsiteAction), so the content starts with
          the greeting rather than repeating the title. */}
      <header className="adash-greet">
        <div>
          <h1 className="adash-greet__title">
            {greeting()}, {name}
          </h1>
          <p className="adash-greet__sub">Here&rsquo;s a summary of your website content.</p>
        </div>
      </header>

      <div className="adash-kpis">
        {kpis.map((k) => (
          <a key={k.key} className="adash-kpi" href={k.href}>
            <span className="adash-kpi__icon">{k.icon}</span>
            <span className="adash-kpi__label">{k.label}</span>
            <span className={k.accent ? 'adash-kpi__value adash-kpi__value--accent' : 'adash-kpi__value'}>{k.value}</span>
            <span className="adash-kpi__link">{k.action} →</span>
          </a>
        ))}
      </div>

      <div className="adash-cols">
        {/* Recent content changes */}
        <section className="adash-card adash-recent">
          <div className="adash-card__head"><h2>Recent Content Changes</h2></div>
          {recent.length === 0 ? (
            <p className="adash-recent__empty">No recent changes yet.</p>
          ) : (
            /* `data-label` on each cell is what lets custom.scss re-flow this
               table into one card per row below 769px — the column heading is
               drawn from the attribute, so the markup stays a single semantic
               table at every screen size. */
            <table className="adash-recent__table">
              <thead>
                <tr><th>Item</th><th>Type</th><th>Modified</th></tr>
              </thead>
              <tbody>
                {recent.map((r, i) => (
                  <tr key={i}>
                    <td data-label="Item" data-primary>
                      <span className="adash-recent__item">{r.title}</span>
                      <span className="adash-recent__sub">{r.status === 'draft' ? 'Draft saved' : `${r.type} updated`}</span>
                    </td>
                    <td data-label="Type"><span className={`adash-badge adash-badge--${r.type.toLowerCase()}`}>{r.type}</span></td>
                    <td data-label="Modified" className="adash-recent__when">{r.when}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* Quick actions + the prototype's translation-review callout */}
        <aside className="adash-side">
          <section className="adash-card adash-actions">
            <div className="adash-actions__label">Quick Actions</div>
            <div className="adash-actions__body">
              <a className="adash-qa adash-qa--primary" href={`${a}/collections/services/create`}>+ New Service</a>
              <a className="adash-qa adash-qa--outline" href={`${a}/collections/projects/create`}>+ New Project</a>
              <a className="adash-qa adash-qa--dark" href={`${a}/collections/career-listings/create`}>+ New Job Opening</a>
            </div>
          </section>

          {/* Same number as the KPI above, restated as the thing to DO about it
              (/prototype/admin/dashboard.html). Nothing to say when the
              translations are all up to date, so the card stays away. */}
          <section className="adash-card adash-actions">
            <div className="adash-actions__label">Translation Review</div>
            {counts.pendingTranslations > 0 ? (
              <>
                <p className="adash-callout">
                  {I.warning}
                  <span>
                    <strong>{counts.pendingTranslations}</strong>{' '}
                    {counts.pendingTranslations === 1 ? 'string still needs' : 'strings still need'} a
                    French or German translation.
                  </span>
                </p>
                <a className="adash-actions__link" href={`${a}/translations`}>
                  Review now →
                </a>
              </>
            ) : (
              <p className="adash-callout adash-callout--ok">
                {I.check}
                <span>Every string is translated into French and German.</span>
              </p>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}
