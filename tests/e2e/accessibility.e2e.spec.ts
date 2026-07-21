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

// Pages that render in every environment (no seeded content required). The
// service-detail template (/services/[slug]) is covered separately below,
// because it requires seeded content — CI seeds one sample service (npm run
// seed:ci); locally the test skips if the DB has no such service.
const EN_PAGES = ['/en', '/en/projects', '/en/about', '/en/careers', '/en/legal', '/en/privacy']
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
