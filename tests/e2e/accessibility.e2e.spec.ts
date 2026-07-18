import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { Result } from 'axe-core'

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

// Pages that render in every environment (no seeded content required). Service
// detail (/services/[slug]) is intentionally omitted: with an empty CI database
// there are no published services, so those URLs 404 — they'll be added to this
// gate once CI can seed content.
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
})
