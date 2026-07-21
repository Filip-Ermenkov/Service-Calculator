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
