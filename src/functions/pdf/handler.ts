/**
 * Isolated PDF-rendering Lambda (Phase 4 — TECHSPEC §6.5, §13).
 *
 * A deliberately dumb, stateless HTML -> PDF renderer. It holds NO business
 * logic and has NO database access: the main app assembles the fully-resolved
 * quote HTML (pricing, i18n, company details all live there) and hands it over,
 * so this function only launches headless Chromium and prints. Keeping it
 * separate is exactly why TECHSPEC §13 flags "Payload's bundle + Chromium in one
 * function" as a risk — this function carries neither Payload nor a DB client.
 *
 * Runtime: x86_64 Node. The npm `@sparticuz/chromium` package ships **x64
 * binaries only** (arm64 needs the -min package + a self-hosted remote pack),
 * so this function is x86_64 even though the main Web function is arm64 — they
 * are isolated, so the mismatch is irrelevant and keeps this function
 * self-contained (the binary is bundled; nothing is fetched at cold start).
 */

import chromium from '@sparticuz/chromium'
import puppeteer from 'puppeteer-core'

export interface RenderPdfEvent {
  /** The complete, self-contained HTML document to render. */
  html: string
}

export interface RenderPdfResult {
  /** Base64-encoded PDF bytes (well under Lambda's 6 MB sync-response cap). */
  pdfBase64: string
}

export const handler = async (event: RenderPdfEvent): Promise<RenderPdfResult> => {
  if (!event || typeof event.html !== 'string' || event.html.length === 0) {
    throw new Error('renderPdf: missing `html` in event payload')
  }

  // WebGL is not needed for a text/CSS quote — disabling it skips the
  // swiftshader extraction and saves ~1s of cold-start time.
  chromium.setGraphicsMode = false

  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    // @sparticuz/chromium v133+ dropped the `defaultViewport`/`headless`
    // convenience exports (removed from the module's types), so we pass the
    // values directly instead of reading them off `chromium`. The build is
    // headless_shell, so 'shell' is the correct headless mode; viewport is
    // irrelevant for PDF output (page.pdf drives the A4 page sizing).
    headless: 'shell',
  })

  try {
    const page = await browser.newPage()
    // The HTML is fully self-contained (inlined CSS, no remote assets), so
    // `load` is sufficient and avoids waiting on a network that never fires.
    await page.setContent(event.html, { waitUntil: 'load' })
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
    })
    return { pdfBase64: Buffer.from(pdf).toString('base64') }
  } finally {
    // Always close, even on error — Chromium can otherwise hang the invocation.
    for (const p of await browser.pages()) {
      await p.close().catch(() => {})
    }
    await browser.close().catch(() => {})
  }
}
