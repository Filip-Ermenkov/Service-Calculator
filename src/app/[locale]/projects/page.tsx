import type { Metadata } from 'next'
import { getTranslations, setRequestLocale } from 'next-intl/server'

import { ProjectsBrowser } from '@/components/site/ProjectsBrowser'
import type { Locale } from '@/i18n/routing'
import { getProjects, mediaProps } from '@/lib/content'
import { lexicalToPlainText } from '@/lib/lexical'
import type { ProjectCard } from '@/lib/projects'
import { pageMetadata } from '@/lib/seo'

export const revalidate = 300

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'Projects' })
  return pageMetadata({
    locale: locale as Locale,
    path: '/projects',
    title: t('title'),
    description: t('subtitle'),
  })
}

export default async function ProjectsPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  setRequestLocale(locale)

  const t = await getTranslations({ locale, namespace: 'Projects' })
  const projects = await getProjects(locale as Locale)
  const dateFmt = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' })

  // Map each CMS project to a lightweight, serialisable card for the client
  // component. The category label is the LIVE service title while the service
  // exists, or the retained `serviceName` snapshot once it's deleted
  // (FUNCTIONALITY.md §7); falling back to the "uncategorised" label otherwise.
  const cards: ProjectCard[] = projects.map((project) => {
    const img = mediaProps(project.photo)
    const liveTitle =
      project.service && typeof project.service === 'object'
        ? project.service.title
        : null
    const category = liveTitle ?? project.serviceName ?? ''
    return {
      id: project.id,
      title: project.title,
      blurb: lexicalToPlainText(project.description, 130),
      dateLabel: project.completionDate
        ? dateFmt.format(new Date(project.completionDate))
        : '',
      imageUrl: img?.url ?? null,
      imageAlt: img?.alt ?? '',
      category,
    }
  })

  return (
    <>
      <section className="grid-bg" style={{ padding: '4rem 0 3rem' }}>
        <div className="container">
          <span className="eyebrow">{t('eyebrow')}</span>
          <h1 className="display-lg" style={{ color: '#fff' }}>
            {t('title')}
          </h1>
          <p style={{ color: 'var(--g400)', maxWidth: 520, marginTop: '0.75rem', fontSize: '0.9375rem' }}>
            {t('subtitle')}
          </p>
        </div>
      </section>

      <section className="section bg-white">
        <div className="container">
          {cards.length === 0 ? (
            // No projects at all → the friendly "empty portfolio" state, rendered
            // server-side (no search/filter to show when there's nothing yet).
            <div className="empty-state">
              <p className="empty-state-title">{t('emptyStateTitle')}</p>
              <p className="empty-state-body">{t('emptyStateBody')}</p>
            </div>
          ) : (
            <ProjectsBrowser items={cards} />
          )}
        </div>
      </section>
    </>
  )
}
