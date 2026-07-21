/**
 * Standalone entry point for seeding the sample CMS content, run by the CI
 * `verify` job (see .github/workflows/ci.yml) via Payload's own runner:
 *
 *   payload run tests/helpers/seedContent.run.ts
 *
 * `payload run` loads env the way Next.js does and initializes tsx, so no dotenv
 * or extra transpiler is needed (Payload docs, "Using Payload outside Next.js").
 *
 * IMPORTANT: this uses a TOP-LEVEL await (not a floating `.then()` chain).
 * `payload run` only waits for the module's synchronous top level to finish; a
 * floating promise is abandoned the instant that returns, so the async seed
 * would be killed before Payload even boots — a silent no-op with no output and
 * no data written. Top-level await keeps the process alive until the seed
 * completes (the Payload docs' seed example does the same).
 *
 * The seeding logic + its safety guard (ALLOW_CONTENT_SEED) live in
 * `seedContent.ts`; this file is only the invocation, kept separate so the specs
 * can import the pure helpers without triggering a seed on import.
 */
import { seedSampleContent } from './seedContent'

try {
  await seedSampleContent()
} catch (err) {
  console.error('[seed] failed:', err)
  process.exit(1)
}

// getPayload holds a Postgres pool open, so the event loop won't drain on its
// own — exit explicitly once the seed has completed successfully.
process.exit(0)
