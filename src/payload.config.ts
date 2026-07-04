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
      // Uploads go browser -> S3 directly (presigned URL), not through this
      // Lambda. Avoids routing file bytes through the function's payload
      // size limits — a real risk for a media library, not a theoretical
      // one. Needs CORS PUT allowed on the bucket; sst.aws.Bucket's default
      // CORS (wildcard origins, includes PUT) already covers this, see
      // https://sst.dev/docs/component/aws/bucket/#cors
      //
      // Note: clientUploads only changes the REST/admin-UI upload path
      // (browser gets redirected to a presigned URL). Local API calls
      // (payload.create/update with a `file`) always go through
      // handleUpload -> a real server-side S3 PutObject, unaffected by this
      // flag — that's what makes the media Local-API integration test
      // (tests/int/media.int.spec.ts) able to exercise real S3 semantics
      // without a browser.
      clientUploads: true,
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
