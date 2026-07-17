'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'

import { Bolt, Search } from '@/components/site/icons'
import {
  filterProjects,
  projectCategories,
  type ProjectCard,
} from '@/lib/projects'

/**
 * Public Projects page — client-side search + service-category filter
 * (FUNCTIONALITY.md §3.2). Runs entirely in the browser over the small,
 * server-pre-fetched list (this site's project count doesn't justify a search
 * backend — TECHSPEC §6.2), so results update instantly as the visitor types or
 * changes the filter, with no page reload and no extra request.
 *
 * Progressive enhancement: the server still renders the full grid, so the
 * projects are present and crawlable even before this component hydrates; the
 * search/filter simply become interactive once JS loads.
 */
export function ProjectsBrowser({ items }: { items: ProjectCard[] }) {
  const t = useTranslations('Projects')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')

  const categories = useMemo(() => projectCategories(items), [items])
  const results = useMemo(
    () => filterProjects(items, query, category),
    [items, query, category],
  )

  return (
    <>
      <div className="filter-bar" role="search">
        <div className="search-input-wrap">
          <Search />
          <input
            type="search"
            className="search-input"
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {categories.length > 0 && (
          <select
            className="filter-select"
            aria-label={t('allCategories')}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">{t('allCategories')}</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
      </div>

      <p
        style={{
          fontSize: '0.8rem',
          color: 'var(--g500)',
          fontWeight: 500,
          marginBottom: '1.25rem',
        }}
        aria-live="polite"
      >
        {t('resultCount', { count: results.length })}
      </p>

      {results.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-title">{t('emptyTitle')}</p>
          <p className="empty-state-body">{t('emptyBody')}</p>
        </div>
      ) : (
        <div className="projects-grid">
          {results.map((project) => (
            <article className="project-card" key={project.id}>
              <div className="project-card-img">
                <div className="card-img-inner img-ph" style={{ height: 180 }}>
                  {project.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={project.imageUrl}
                      alt={project.imageAlt}
                      className="media-cover"
                      loading="lazy"
                    />
                  ) : (
                    <Bolt style={{ width: 40, height: 40 }} />
                  )}
                </div>
              </div>
              <div className="project-card-body">
                <h2 className="project-card-title">{project.title}</h2>
                {project.blurb && (
                  <p className="project-card-desc">{project.blurb}</p>
                )}
                <div className="project-meta">
                  <span className="project-date">{project.dateLabel}</span>
                  {project.category && (
                    <span className="project-tag">{project.category}</span>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  )
}
