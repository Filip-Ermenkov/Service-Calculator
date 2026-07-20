/**
 * Server-side bridge from assembled quote HTML to PDF bytes (Phase 4).
 *
 * In a deployed stage this invokes the isolated PDF Lambda (see
 * `src/functions/pdf/handler.ts`) synchronously and returns the PDF buffer. The
 * function name is injected by SST as `PDF_FUNCTION_NAME`; the invoke permission
 * is granted by linking the function to the Web component in sst.config.ts.
 *
 * When `PDF_FUNCTION_NAME` is unset (local `next dev`, CI, tests — there is no
 * Chromium Lambda there) `renderPdf` returns `null`, and the route falls back to
 * serving the HTML so the template can still be inspected/printed in a browser.
 * This keeps the main app free of any Chromium dependency, per TECHSPEC §6.5.
 */

export interface RenderedPdf {
  buffer: Buffer
}

/**
 * Invoke the isolated PDF function. Returns the PDF bytes, or `null` when no PDF
 * backend is configured for this stage (caller then serves HTML instead).
 * Throws only on a genuine backend failure (so the route can surface an error).
 */
export async function renderPdf(html: string): Promise<RenderedPdf | null> {
  const functionName = process.env.PDF_FUNCTION_NAME
  if (!functionName) return null

  // Imported lazily so the AWS SDK is only pulled in on the code path that needs
  // it (and never in the HTML-preview fallback used by local dev / tests).
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda')
  const client = new LambdaClient({})

  const res = await client.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify({ html })),
    }),
  )

  // A Lambda that throws still returns HTTP 200 with FunctionError set.
  if (res.FunctionError) {
    const detail = res.Payload ? Buffer.from(res.Payload).toString('utf8') : ''
    throw new Error(`PDF function error (${res.FunctionError}): ${detail}`)
  }
  if (!res.Payload) {
    throw new Error('PDF function returned an empty payload')
  }

  const parsed = JSON.parse(Buffer.from(res.Payload).toString('utf8')) as {
    pdfBase64?: string
  }
  if (!parsed.pdfBase64) {
    throw new Error('PDF function returned no pdfBase64')
  }

  return { buffer: Buffer.from(parsed.pdfBase64, 'base64') }
}
