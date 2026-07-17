import type { Metadata } from 'next'
import { getTranslations, setRequestLocale } from 'next-intl/server'

import { Bolt } from '@/components/site/icons'
import type { Locale } from '@/i18n/routing'
import { getProjects, mediaProps } from '@/lib/content'
import { lexicalToPlainText } from '@/lib/lexical'
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
          {projects.length === 0 ? (
            <div className="empty-state">
              <p className="empty-state-title">{t('emptyStateTitle')}</p>
              <p className="empty-state-body">{t('emptyStateBody')}</p>
            </div>
          ) : (
            <>
              <p style={{ fontSize: '0.8rem', color: 'var(--g500)', fontWeight: 500, marginBottom: '1.25rem' }}>
                {t('resultCount', { count: projects.length })}
              </p>
              <div className="projects-grid">
                {projects.map((project) => {
                  const img = mediaProps(project.photo)
                  const serviceName =
                    project.service && typeof project.service === 'object'
                      ? project.service.title
                      : t('untitledService')
                  const blurb = lexicalToPlainText(project.description, 130)
                  return (
                    <article className="project-card" key={project.id}>
                      <div className="project-card-img">
                        <div className="card-img-inner img-ph" style={{ height: 180 }}>
                          {img ? (
                            <img src={img.url} alt={img.alt} className="media-cover" loading="lazy" />
                          ) : (
                            <Bolt style={{ width: 40, height: 40 }} />
                          )}
                        </div>
                      </div>
                      <div className="project-card-body">
                        <h2 className="project-card-title">{project.title}</h2>
                        {blurb && <p className="project-card-desc">{blurb}</p>}
                        <div className="project-meta">
                          <span className="project-date">
                            {project.completionDate ? dateFmt.format(new Date(project.completionDate)) : ''}
                          </span>
                          <span className="project-tag">{serviceName}</span>
                        </div>
                      </div>
                    </article>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </section>
    </>
  )
}
