/**
 * Canonical identifiers for the sample CMS content seeded into CI's (empty)
 * database so the `/services/[slug]` template — the live price calculator and
 * the Download-PDF action, i.e. the core interactive surface of the site — can
 * be exercised by the Lighthouse SEO/perf gate, the axe WCAG gate, and the
 * calculator/quote end-to-end tests, instead of 404-ing on an empty DB.
 *
 * This module is intentionally DEPENDENCY-FREE (no `payload` import) so that
 * Playwright specs can import the slug/path without dragging the whole Payload
 * config into the test process. The actual seeding lives in `seedContent.ts`.
 */

export const SAMPLE_SERVICE_SLUG = 'ci-sample-service'
export const SAMPLE_SERVICE_TITLE = 'CI Sample Service'

/** English service-detail path for the seeded sample service. */
export const SAMPLE_SERVICE_PATH_EN = `/en/services/${SAMPLE_SERVICE_SLUG}`

/**
 * One published sample project (linked to the sample service) and the photo it
 * carries — added 2026-09-14 so the Projects and Media admin lists have a row
 * in CI (Payload renders no table at all on an empty collection, so the drag
 * handle / bulk-select columns could not be asserted otherwise) and so the
 * public `/projects` grid is audited with real content rather than its empty
 * state. Identified by title / alt text: projects have no slug, and Payload
 * de-duplicates upload filenames, so those are the stable handles.
 */
export const SAMPLE_PROJECT_TITLE = 'CI Sample Project'
export const SAMPLE_MEDIA_ALT = 'CI sample photo'
