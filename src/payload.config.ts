import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { s3Storage } from '@payloadcms/storage-s3'
import path from 'path'
import { buildConfig } from 'payload'
import { fileURLToPath } from 'url'

import { Users } from './collections/Users'
import { Media } from './collections/Media'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
    components: {
      // Additive slot (renders before the default Dashboard contents, does
      // not replace them) — the redirect gate for "logged in but hasn't
      // completed TOTP yet". See BeforeDashboardTotpGate.tsx for why this
      // slot specifically, and src/access/requireTotpVerified.ts for the
      // actual enforcement (this component is UX, not the security boundary).
      beforeDashboard: ['/components/admin/BeforeDashboardTotpGate'],
      views: {
        // New Root Views (not overrides of any built-in Payload view) for
        // the TOTP enrollment and per-login verification steps. Payload's
        // own /admin/login view is untouched — it still handles the
        // password (first) factor exactly as it always has.
        totpSetup: {
          Component: '/components/admin/TotpSetupView',
          path: '/totp-setup',
        },
        totpVerify: {
          Component: '/components/admin/TotpVerifyView',
          path: '/totp-verify',
        },
      },
    },
  },
  collections: [Users, Media],
  editor: lexicalEditor(),
  secret: process.env.PAYLOAD_SECRET || '',
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  db: postgresAdapter({
    pool: {
      connectionString: process.env.DATABASE_URL || '',
      // Lambda-friendly: keep the per-invocation connection count low and let
      // Neon's PgBouncer pooler (the `-pooler` hostname) do the multiplexing.
      // Safe locally too — Postgres/Neon both handle a handful of connections fine.
      max: process.env.NODE_ENV === 'production' ? 3 : 10,
    },
  }),
  // sharp intentionally omitted: it's optional as of Payload 3.x, and the
  // Media collection (src/collections/Media.ts) doesn't configure any
  // sharp-dependent feature (imageSizes, resizeOptions, focal point) yet.
  // sharp ships architecture-specific native binaries, which conflicts with
  // building on ubuntu-latest (x64) CI runners while deploying to arm64
  // Lambda (see sst.config.ts) — OpenNext also excludes it from the main
  // server bundle by default regardless, since it assumes sharp is only used
  // by Next's own separate image-optimizer function. Revisit properly
  // (matching CI/Lambda architecture, or a prebuilt arm64 Sharp Lambda
  // Layer) once Media actually needs resizing — tracked as a follow-up, not
  // a Phase 0 blocker.
  plugins: [
    s3Storage({
      collections: {
        media: true,
      },
      bucket: process.env.S3_BUCKET || '',
      // Real AWS (staging/production, and local dev pointed at a real
      // bucket): uploads go browser -> S3 directly (presigned URL), not
      // through this Lambda. Avoids routing file bytes through the
      // function's payload size limits — a real risk for a media library,
      // not a theoretical one. Needs CORS PUT allowed on the bucket;
      // sst.aws.Bucket's default CORS (wildcard origins, includes PUT)
      // already covers this, see https://sst.dev/docs/component/aws/bucket/#cors
      //
      // S3Mock (local dev/CI, whenever S3_ENDPOINT is set): clientUploads is
      // turned OFF instead. S3Mock's CORS support is known-incomplete (see
      // https://github.com/adobe/S3Mock/issues/74 — only ever partially
      // fixed, GET only) and isn't configurable at all (no
      // PutBucketCors/GetBucketCors support), so a browser PUT straight to
      // localhost:9090 fails as an opaque `TypeError: Failed to fetch`
      // (blocked CORS preflight) — this was hit via the admin UI, not caught
      // by tests/int/media.int.spec.ts, since that test uses the Local API,
      // which never takes the clientUploads path in the first place (see
      // below). With clientUploads off, the browser instead POSTs to this
      // same Next.js dev server (same-origin, no CORS involved at all), and
      // the server relays the bytes to S3Mock itself — a plain
      // server-to-server call, which browser CORS rules never apply to.
      // There's no Lambda payload-size concern locally to weigh against
      // that, so this is a strict improvement for local dev, not a
      // trade-off.
      //
      // Note: clientUploads only changes the REST/admin-UI upload path
      // either way. Local API calls (payload.create/update with a `file`)
      // always go through handleUpload -> a real server-side S3 PutObject,
      // unaffected by this flag — that's what makes the media Local-API
      // integration test (tests/int/media.int.spec.ts) able to exercise real
      // S3 semantics without a browser, and why it never caught this.
      clientUploads: !process.env.S3_ENDPOINT,
      config: {
        region: process.env.AWS_REGION || 'eu-central-1',
        // No explicit credentials by default: Lambda's own execution role —
        // granted S3 access via `link: [media, ...]` in sst.config.ts — is
        // picked up automatically by the AWS SDK's default credential
        // provider chain.
        //
        // S3_ENDPOINT is only set locally/in CI, to point at the S3Mock
        // container (docker-compose.yml / .github/workflows/ci.yml) instead
        // of real AWS — see docs/PROGRESS.md for why S3Mock (not MinIO or
        // LocalStack) was chosen. Never set in staging/production, so this
        // branch never runs against real infrastructure.
        ...(process.env.S3_ENDPOINT && {
          endpoint: process.env.S3_ENDPOINT,
          forcePathStyle: true,
          credentials: {
            accessKeyId: process.env.S3_ACCESS_KEY_ID || 'test',
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || 'test',
          },
        }),
      },
    }),
  ],
  localization: {
    locales: ['en'],
    fallback: true,
    defaultLocale: 'en',
  },
})
