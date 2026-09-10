import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { Result } from 'axe-core'

import { SAMPLE_SERVICE_PATH_EN } from '../helpers/sampleContent'

const BASE = 'http://localhost:3000'

// Automated WCAG 2.2 AA accessibility gate for the public site (TECHSPEC §6.11 /
// §7B). This is the machine-checkable half of accessibility — it reliably
// catches the ~30–40% of WCAG criteria that tooling can verify (missing labels,
// color contrast, ARIA misuse, landmark/heading structure, lang attributes).
// The remaining criteria still need the manual keyboard/screen-reader pass done
// at each slice sign-off; automated green is necessary, not sufficient.
//
// Like frontend.e2e.spec.ts, this runs against CI's EMPTY Postgres, so it
// asserts the accessibility of the SHELL + every page's empty state — the design
// system, navigation, language switcher, headings and landmarks that render
// regardless of seeded content. Once real content can be seeded in CI, the CMS
// rich-text surfaces (which axe also covers) come along for free.
//
// The gate is scoped to SERIOUS + CRITICAL impact. Moderate/minor findings are
// surfaced in the attached report for triage but do not fail the build, which
// keeps the gate high-signal (a common, documented axe-in-CI practice) — tighten
// to include moderate later if desired.

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
const BLOCKING_IMPACTS = new Set(['serious', 'critical'])

// Scan the SETTLED page, not a frame of its entrance animation.
//
// The design system fades content in with `fade-rise` (opacity 0 → 1 over 0.6s,
// staggered up to 0.34s — src/app/[locale]/globals.css), and axe samples
// whatever colours are composited at the instant it runs. Mid-fade, the hero's
// white-on-orange CTA composites to ~4.1–4.5:1 and axe reports a SERIOUS
// color-contrast violation — even though the settled state (#FFFFFF on #BF4C00)
// is 4.94:1 and passes. That made this gate genuinely NON-DETERMINISTIC: which
// page failed moved around between runs with render timing (first observed when
// seeding CMS content into the local DB made the render slower). It can fail a
// good build and, on a fast render, could equally PASS over a real defect.
//
// Emulating `prefers-reduced-motion: reduce` is NOT sufficient here (verified,
// not assumed): the entrance animations are guarded by
// `@media (prefers-reduced-motion: no-preference)`, but Playwright's
// `reducedMotion` emulation did not reach the page in this setup — a probe
// reported `matchMedia('(prefers-reduced-motion: reduce)').matches === false`
// while the animating wrapper still sat at `opacity: 0`. And a fixed
// `waitForTimeout` would only make the race less likely, never remove it —
// scroll-driven `animation-timeline: view()` animations never "finish" at all.
//
// So the scan explicitly neutralises animation and transition for the audited
// document. This is what the WCAG 1.4.3 contrast criterion is actually about
// (the stable rendered state), and it is what makes the gate reproducible.
const DISABLE_ANIMATIONS_CSS = `
  *, *::before, *::after {
    animation-delay: -1ms !important;
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    animation-fill-mode: forwards !important;
    transition-duration: 1ms !important;
    transition-delay: -1ms !important;
    scroll-behavior: auto !important;
  }
`

// Pages that render in every environment (no seeded content required). The
// service-detail template (/services/[slug]) is covered separately below,
// because it requires seeded content — CI seeds one sample service (npm run
// seed:ci); locally the test skips if the DB has no such service.
// NB: /en/contact was missing here until 2026-09 — the single most
// accessibility-sensitive public surface after the calculator (labelled
// inputs, a required-field pattern, an error/success live region, and a
// third-party Turnstile iframe) shipped in Phase 6 with no automated WCAG
// coverage at all. It renders on an empty DB, so it belongs in this list.
const EN_PAGES = [
  '/en',
  '/en/projects',
  '/en/about',
  '/en/careers',
  '/en/contact',
  '/en/legal',
  '/en/privacy',
]
// Home in the other two locales too — cheap, and catches locale-specific issues
// (html lang, translated nav, the language switcher's active state).
const LOCALE_HOMES = ['/fr', '/de']

function summarize(violations: Result[]): string {
  return violations
    .map((v) => {
      const nodes = v.nodes.map((n) => `      → ${n.target.join(' ')}`).join('\n')
      return `  [${v.impact}] ${v.id}: ${v.help}\n    ${v.helpUrl}\n${nodes}`
    })
    .join('\n\n')
}

async function auditPage(page: import('@playwright/test').Page, path: string) {
  const res = await page.goto(`${BASE}${path}`)
  expect(res?.status(), `${path} should render (status < 400)`).toBeLessThan(400)
  // Wait for the main landmark so we scan the fully-rendered page, not a shell.
  await expect(page.locator('main#main')).toBeVisible()

  // Fast-forward every entrance animation to its end state (see above), so the
  // colours axe measures are the ones a visitor actually reads.
  await page.addStyleTag({ content: DISABLE_ANIMATIONS_CSS })

  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()

  const blocking = results.violations.filter(
    (v) => v.impact && BLOCKING_IMPACTS.has(v.impact),
  )

  // Attach the FULL report (all impacts) to the Playwright HTML report for triage.
  if (results.violations.length > 0) {
    console.log(`\naxe findings on ${path} (${results.violations.length} total):\n${summarize(results.violations)}`)
  }

  expect(
    blocking,
    `Serious/critical WCAG violations on ${path}:\n${summarize(blocking)}`,
  ).toEqual([])
}

test.describe('Accessibility — WCAG 2.2 AA (serious/critical)', () => {
  for (const path of EN_PAGES) {
    test(`no serious/critical a11y violations on ${path}`, async ({ page }) => {
      await auditPage(page, path)
    })
  }

  for (const path of LOCALE_HOMES) {
    test(`no serious/critical a11y violations on ${path}`, async ({ page }) => {
      await auditPage(page, path)
    })
  }

  // Service detail — the live calculator (number/select/toggle inputs, the
  // aria-live total) and the Download-PDF button. This is the most
  // interaction-heavy public surface, so it's exactly where axe adds the most
  // value; it was previously unaudited because it 404s on an empty DB. CI seeds
  // a sample service so it renders here; when unseeded (a local run against an
  // empty DB) the test skips rather than failing on the 404.
  test(`no serious/critical a11y violations on ${SAMPLE_SERVICE_PATH_EN}`, async ({ page }) => {
    const res = await page.goto(`${BASE}${SAMPLE_SERVICE_PATH_EN}`)
    test.skip(res?.status() === 404, 'no seeded sample service in this environment (empty DB)')
    await auditPage(page, SAMPLE_SERVICE_PATH_EN)
  })
})
