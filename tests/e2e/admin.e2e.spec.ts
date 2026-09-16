import { test, expect, Page } from '@playwright/test'
import { login } from '../helpers/login'
import { seedTestUser, cleanupTestUser, testUser, testUserTotpSecret } from '../helpers/seedUser'
import { SAMPLE_SERVICE_TITLE } from '../helpers/sampleContent'

test.describe('Admin Panel', () => {
  let page: Page

  test.beforeAll(async ({ browser }, _testInfo) => {
    await seedTestUser()

    const context = await browser.newContext()
    page = await context.newPage()

    // testUser is seeded with 2FA already enabled (see seedUser.ts) — these
    // specs are about collection CRUD, not the 2FA flow itself (that's
    // covered by totp.e2e.spec.ts), so login() completes both factors here.
    await login({ page, user: testUser, totpSecret: testUserTotpSecret })
  })

  test.afterAll(async () => {
    await cleanupTestUser()
  })

  test('can navigate to dashboard', async () => {
    await page.goto('http://localhost:3000/admin')
    await expect(page).toHaveURL('http://localhost:3000/admin')
    const dashboardArtifact = page.locator('.adash-greet__title').first()
    await expect(dashboardArtifact).toBeVisible()
  })

  test('can navigate to list view', async () => {
    await page.goto('http://localhost:3000/admin/collections/users')
    await expect(page).toHaveURL('http://localhost:3000/admin/collections/users')
    const listViewArtifact = page.locator('h1', { hasText: 'Users' }).first()
    await expect(listViewArtifact).toBeVisible()
  })

  test('can navigate to edit view', async () => {
    await page.goto('http://localhost:3000/admin/collections/users/create')
    await expect(page).toHaveURL(/\/admin\/collections\/users\/[a-zA-Z0-9-_]+/)
    const editViewArtifact = page.locator('input[name="email"]')
    await expect(editViewArtifact).toBeVisible()
  })

  // ── One list design for every collection (2026-09-14) ────────────────────
  // Services moved from a bespoke Root View onto Payload's native list, restyled
  // and carrying its extras through list slots. These pin the pieces a config
  // typo would silently drop: the order banner and card header (beforeListTable),
  // the Home-page card-count card (afterList), the bulk-select column, the drag
  // handle Payload only renders for `orderable` collections sorted by `_order`,
  // and the redirect that keeps the old /admin/services path alive.
  test('services list is the native list with banner, settings card, select + drag columns', async () => {
    await page.goto('http://localhost:3000/admin/collections/services')
    await expect(page.locator('.alist-banner')).toContainText('Home page')
    await expect(page.locator('.alist-head__title')).toContainText('All Services')
    await expect(page.locator('.alist-settings')).toBeVisible()
    await expect(page.locator('#alist-limit')).toBeVisible()
    await expect(page.locator('th#heading-_select')).toBeAttached()
    await expect(page.locator('th#heading-_dragHandle')).toBeAttached()
    // The prototype's columns, unchanged.
    for (const heading of ['Service Title', 'Home Page Card', 'Calculator Fields', 'Status', 'Actions']) {
      await expect(page.locator('.table thead')).toContainText(heading)
    }
  })

  test('/admin/services (the old bespoke screen) redirects to the native list', async () => {
    await page.goto('http://localhost:3000/admin/services')
    await expect(page).toHaveURL(/\/admin\/collections\/services/)
  })

  test('projects and media lists are drag-orderable with bulk selection', async () => {
    for (const slug of ['projects', 'media']) {
      await page.goto(`http://localhost:3000/admin/collections/${slug}`)
      await expect(page.locator('.alist-head__title')).toBeVisible()
      await expect(page.locator('th#heading-_select')).toBeAttached()
      await expect(page.locator('th#heading-_dragHandle')).toBeAttached()
    }
  })

  // ── Price formula bar (2026-09-14) ────────────────────────────────────────
  // The Services `formula` field is a free-form expression editor over the
  // seeded sample service's fields (area / finish / rush). This drives it the
  // way an admin does — type, read the "in words" echo, test a price, break it —
  // and pins the one guarantee that matters most: an invalid formula cannot be
  // published (the field's validate refuses the draft marker).
  test('formula bar: compiles, echoes in words, previews a price, blocks publishing when broken', async () => {
    // Several server round trips (form state on every edit, then a refused
    // publish) on a dev server shared with the parallel specs — give it room.
    test.setTimeout(90_000)
    // Leaving the page with unsaved edits raises a beforeunload dialog — accept it.
    page.on('dialog', (dialog) => void dialog.accept())

    // Straight to the editor by id (the admin session's cookies ride along on
    // page.request), instead of waiting on the list view to render under load.
    const found = (await (
      await page.request.get(
        `http://localhost:3000/api/services?where[title][equals]=${encodeURIComponent(SAMPLE_SERVICE_TITLE)}&limit=1&depth=0`,
      )
    ).json()) as { docs: { id: number }[] }
    expect(found.docs).toHaveLength(1)
    await page.goto(`http://localhost:3000/admin/collections/services/${found.docs[0].id}`)

    // The section renders lazily once it scrolls into view.
    await page.locator('.asec--formula').scrollIntoViewIfNeeded()
    const input = page.locator('.fb-input')
    await expect(input).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.fb-chip--field')).toHaveCount(3)

    await input.fill('area × 12 × (1 + 17%)')
    await expect(page.locator('.fb-status--ok')).toContainText('Area (m²) × 12 × (1 + 0.17)')
    // Syntax colouring behind the textarea: the field key is a field token.
    await expect(page.locator('.fb-hl .fb-hl--field').first()).toHaveText('area')

    // Test / Preview runs the same computePrice(): 10 × 12 × 1.17 = 140.40.
    await page.locator('#fb-tab-test').click()
    await page.locator('#fb-panel-test input[type="number"]').first().fill('10')
    await expect(page.locator('#fb-panel-test .fb-preview-amount')).toHaveText('€140.40', {
      timeout: 10_000,
    })

    // Break it: the plain-language error settles, then Publish is refused.
    await page.locator('#fb-tab-compose').click()
    await input.fill('area ×')
    await expect(page.locator('.fb-status--error')).toContainText('Something is missing after "×"')
    await page.getByRole('button', { name: 'Publish changes' }).click()
    await expect(page.getByText(/following field is invalid/i)).toBeVisible({ timeout: 15_000 })
    // Still on the editor (nothing saved), with the error on the field.
    await expect(page).toHaveURL(/\/admin\/collections\/services\/\d+/)
    await expect(page.locator('.fb.error')).toBeVisible()
  })
})
