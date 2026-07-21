import { getPayload } from 'payload'
import config from '@payload-config'

import {
  SAMPLE_SERVICE_SLUG,
  SAMPLE_SERVICE_TITLE,
} from './sampleContent'

/**
 * Idempotently seed ONE published sample service into the current database.
 *
 * Why this exists: CI runs the whole `verify` job against an EMPTY ephemeral
 * Postgres, so `/services/[slug]` (the page the live calculator and the
 * Download-PDF button live on) always 404-ed there — which is why it was
 * excluded from the Lighthouse and axe gates and why the calculator/quote e2e
 * tests could only `test.skip()`. Seeding a single deterministic service closes
 * that coverage hole: the row persists in the job's Postgres service for every
 * later step (build's static generation, `lhci`, and the e2e dev server), so
 * one seed call covers all three consumers.
 *
 * SAFETY: this mutates a database, so it refuses to run unless explicitly
 * opted-in via `ALLOW_CONTENT_SEED=true`, and never runs with
 * `NODE_ENV=production`. That guard is what makes it safe to keep the runner in
 * the repo — a stray `payload run` can't silently write to a real Neon branch
 * or a deployed stage.
 *
 * Idempotent by delete-then-create on the fixed slug, so re-running (e.g. a CI
 * retry) always converges to exactly one copy.
 *
 * No media is attached (uploads would need real/mock S3 and add nothing to the
 * audits); the service page renders its placeholder icon when `heroImage` is
 * unset. The `formula` is left empty on purpose so the calculator exercises the
 * DEFAULT per-field summation path (the common case); the custom-formula path
 * is already covered exhaustively by the pure unit tests.
 */
export async function seedSampleContent(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[seed] refusing to run with NODE_ENV=production — this content seed is for CI/dev only.',
    )
  }
  if (process.env.ALLOW_CONTENT_SEED !== 'true') {
    throw new Error(
      '[seed] refusing to run without ALLOW_CONTENT_SEED=true. This guard prevents ' +
        'accidentally seeding a real (e.g. staging/dev Neon) database. Set the env var ' +
        'explicitly to opt in.',
    )
  }

  const payload = await getPayload({ config })
  // These operations run OUTSIDE a Next request scope, where `revalidatePath`
  // legitimately throws — skip the ISR revalidation hooks (src/lib/revalidate.ts).
  const context = { disableRevalidate: true }

  // Idempotent: remove any prior copy of the sample service first.
  await payload.delete({
    collection: 'services',
    where: { slug: { equals: SAMPLE_SERVICE_SLUG } },
    context,
  })

  await payload.create({
    collection: 'services',
    context,
    data: {
      title: SAMPLE_SERVICE_TITLE,
      slug: SAMPLE_SERVICE_SLUG,
      _status: 'published',
      card: {
        cardDescription:
          'A sample service seeded for automated accessibility, SEO and ' +
          'end-to-end audits of the price calculator.',
      },
      // One of each field type, so the calculator renders a number input, a
      // <select>, and a toggle — the full a11y/interaction surface.
      calculatorFields: [
        {
          fieldKey: 'area',
          label: 'Area (m²)',
          type: 'number',
          unitPrice: 12,
          sign: 'add',
          required: true,
        },
        {
          fieldKey: 'finish',
          label: 'Finish',
          type: 'dropdown',
          unitPrice: 1,
          sign: 'add',
          options: [
            { optionLabel: 'Standard', value: 0 },
            { optionLabel: 'Premium', value: 150 },
          ],
        },
        {
          fieldKey: 'rush',
          label: 'Rush job',
          type: 'toggle',
          unitPrice: 200,
          sign: 'add',
        },
      ],
    },
  })

  payload.logger.info(
    `[seed] published sample service "${SAMPLE_SERVICE_SLUG}" (idempotent).`,
  )
}
