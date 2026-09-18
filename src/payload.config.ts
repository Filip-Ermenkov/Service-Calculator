import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { s3Storage } from '@payloadcms/storage-s3'
import path from 'path'
import { buildConfig } from 'payload'
import { fileURLToPath } from 'url'

import { isFullyVerified } from './access/publicRead'
import { Users } from './collections/Users'
import { MEDIA_MAX_FILE_BYTES, Media } from './collections/Media'
import { MEDIA_S3_PREFIX, mediaPublicUrl } from './lib/media/publicUrl'
import { Services } from './collections/Services'
import { Projects } from './collections/Projects'
import { CareerListings } from './collections/CareerListings'
import { CompanyInfo } from './globals/CompanyInfo'
import { LegalInfo } from './globals/LegalInfo'
import { HomeSettings } from './globals/HomeSettings'
import { ALLOW_REMOTE_PUSH_ENV, remotePushProblem } from './lib/dbGuard'
import { payloadEmailAdapter } from './lib/email/payloadEmailAdapter'
import { isDeployedWithoutServerUrl, resolveServerUrl } from './lib/serverUrl'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

// Schema-push mode (see the adapter's `push` below) may only ever target a LOCAL
// database. A dev server accidentally pointed at a stage's Neon branch pushed
// schema + the dev-migration marker into staging three times in two days; this
// makes that a refused start with an actionable message instead. See src/lib/dbGuard.ts.
const pushSchema = process.env.NODE_ENV !== 'production'
const pushProblem = remotePushProblem({
  databaseUrl: process.env.DATABASE_URL || '',
  push: pushSchema,
  override: process.env[ALLOW_REMOTE_PUSH_ENV],
})
if (pushProblem) throw new Error(pushProblem)

// The one absolute origin Payload may put in emails (the admin password-reset
// link) and — because Payload's sanitizer copies `serverURL` onto `csrf` — the
// one `Origin` it accepts cookie-authenticated requests from. Resolved from the
// stage's NEXT_PUBLIC_SITE_URL (the SST `SiteUrl` secret), else the production
// domain on the production stage, else localhost outside production mode. See
// src/lib/serverUrl.ts for why leaving this unset was two real gaps at once.
const serverURL = resolveServerUrl(process.env)
if (isDeployedWithoutServerUrl(process.env)) {
  console.warn(
    '[payload.config] NEXT_PUBLIC_SITE_URL is not set on this deployed stage, so Payload has ' +
      'no serverURL: password-reset links will be RELATIVE (unusable) and the cookie CSRF ' +
      'allowlist stays open. Fix: `npx sst secret set SiteUrl https://<this-stage-origin> ' +
      '--stage <stage>` and redeploy.',
  )
}

export default buildConfig({
  serverURL,
  // Transactional mail for Payload's own flows (today: the admin password reset)
  // rides the same SES v2 path as the quote/contact emails. Without an adapter
  // Payload only LOGS "email attempted without being configured" and reports
  // success to the admin — see src/lib/email/payloadEmailAdapter.ts.
  email: payloadEmailAdapter({ fromName: 'Bulbau' }),
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
    components: {
      // Brand graphics (Phase 1 of the bespoke admin) — replace Payload's
      // default logo/icon with the Bulbau mark so the login screen and sidebar
      // carry the public site's identity. The design tokens themselves live in
      // src/app/(payload)/custom.scss (auto-loaded by the admin RootLayout).
      // NOTE: after adding/removing entries here, regenerate the import map:
      //   npm run generate:importmap
      graphics: {
        Logo: '/components/admin/BrandLogo',
        Icon: '/components/admin/BrandIcon',
      },
      // Top-bar actions, rendered by Payload into `.app-header__actions` on
      // EVERY admin view — the prototype's topbar "View website" button
      // (/prototype/admin/*.html). Declared once here rather than repeated per
      // screen. Styled by `.atopbar-link` in src/app/(payload)/custom.scss.
      actions: ['/components/admin/ViewWebsiteAction'],
      // "Admin Login" heading above the login fields + a "Back to website" link
      // below them (the wordmark comes from graphics.Logo). Styled in custom.scss.
      beforeLogin: ['/components/admin/LoginIntro'],
      afterLogin: ['/components/admin/BackToWebsite'],
      // Replace Payload's default sidebar with the project's own bespoke admin
      // sidebar (grouped sections + logo header + user footer), matching
      // /prototype/admin. Rendered inside DefaultTemplate on every admin page.
      // NB: because this REPLACES Payload's <Nav>, the `afterNavLinks` slot (which
      // only the default Nav renders) is dead here — the Translations link lives
      // directly in AdminNav.tsx instead. Likewise `beforeDashboard` only renders
      // inside Payload's default Dashboard view, which the custom `dashboard`
      // view below replaces; DashboardView.tsx applies the TOTP gate itself.
      // Both slots were registered here until 2026-09-13 and never rendered.
      Nav: '/components/admin/AdminNav',
      views: {
        // Custom Dashboard — OVERRIDES Payload's default `/admin` landing view
        // with the bespoke industrial dashboard (KPI cards + quick actions).
        // See DashboardView.tsx: it re-applies the TOTP gate itself (the
        // `beforeDashboard` slot does not render on a replaced view).
        dashboard: {
          Component: '/components/admin/DashboardView',
        },
        // `/admin/services` was the bespoke Services screen until 2026-09-14;
        // it is now Payload's native list at /admin/collections/services (see
        // src/collections/Services.ts — the banner, summary columns and the
        // Home-page card-count setting moved into list slots). Kept only as a
        // redirect so old links don't 404.
        services: {
          Component: '/components/admin/ServicesRedirect',
          path: '/services',
        },
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
        // Translation Management (Phase 5 part 2, FUNCTIONALITY.md §5.7): a
        // cross-collection review + override screen for the FR/DE translations
        // produced by the auto-translation pipeline. New Root View at
        // /admin/translations.
        translations: {
          Component: '/components/admin/TranslationsView',
          path: '/translations',
        },
      },
    },
  },
  // Auth-screen label overrides to match the prototype wording. Payload
  // deep-merges these onto the built-in English strings (deepMergeSimple), so
  // every other translation is preserved. NOTE: config changes require a dev
  // server restart to take effect (they don't hot-reload).
  i18n: {
    translations: {
      en: {
        authentication: {
          login: 'Continue',
          forgotPassword: 'Reset Password',
          forgotPasswordEmailInstructions:
            "Enter your email and we'll send you a reset link. The link expires after 1 hour.",
        },
        general: {
          email: 'Email Address',
        },
      },
    },
  },
  // Nothing in this app speaks GraphQL: the public site reads through the Local
  // API, the admin panel through REST + server functions, and the custom routes
  // are plain handlers. Payload nevertheless exposed `POST /api/graphql` — an
  // unauthenticated, introspectable query engine (with its own complexity
  // budget to defend) — on every stage. Disabling it removes that surface and
  // skips building the schema at boot; the two generated route files under
  // src/app/(payload)/api/graphql* were deleted with it (2026-09-18).
  graphQL: {
    disable: true,
  },
  // One media file may be at most MEDIA_MAX_FILE_BYTES (see src/collections/
  // Media.ts for the rationale — since media is served by CloudFront straight
  // from S3 this is a page-weight guard, no longer the Lambda 6 MB ceiling).
  // `limits.fileSize` is busboy's cap on the multipart path (local/S3Mock and any
  // server-side upload) — `abortOnLimit` makes it a 413 instead of a silently
  // truncated file — and @payloadcms/storage-s3 reads the SAME option when it
  // mints presigned PUT URLs for direct-to-S3 browser uploads on deployed stages,
  // refusing an oversized request and signing `content-length` so S3 enforces it
  // too. Media's own `beforeValidate` hook is the third, path-independent check.
  upload: {
    limits: { fileSize: MEDIA_MAX_FILE_BYTES },
    abortOnLimit: true,
    responseOnLimit: `File too large — the limit is ${MEDIA_MAX_FILE_BYTES / (1024 * 1024)} MB.`,
  },
  collections: [Users, Media, Services, Projects, CareerListings],
  globals: [CompanyInfo, LegalInfo, HomeSettings],
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
    // Where `payload migrate:create` writes and `payload migrate` reads. Set
    // explicitly (rather than relying on Payload's best-effort default search)
    // so the CLI resolves the same directory regardless of the cwd it's invoked
    // from — local shell, CI, or a future container. Tracked migrations live in
    // src/migrations/ (committed to the repo).
    migrationDir: path.resolve(dirname, 'migrations'),
    // Schema-management strategy (see docs/PROGRESS.md "DB migrations workflow"):
    //   • Local dev + CI tests (NODE_ENV !== 'production'): Drizzle `push` is ON.
    //     The dev DB / ephemeral CI Postgres is a sandbox — Payload syncs the
    //     schema to the config on boot, so no migration run is needed there.
    //   • Deployed (Lambda, NODE_ENV === 'production'): `push` is OFF. The schema
    //     is changed ONLY by tracked migrations, applied by `payload migrate` in
    //     the CI deploy job BEFORE `sst deploy` (see .github/workflows/ci.yml).
    // This is Payload's own default (push⇔dev); we set it explicitly so the
    // boundary is documented and can't drift silently.
    push: pushSchema,
    // NOTE: `prodMigrations` is deliberately NOT set. That option runs pending
    // migrations at Payload init (server startup), which is correct for a
    // long-running container but wrong for Lambda: it would run on every cold
    // start and let concurrent cold starts race on the same DDL. On serverless,
    // migrations must run once per deploy in CI, not per invocation at runtime.
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
        media: {
          // Every object lives under `media/` and is served at `/media/<file>`
          // — the public URL path IS the S3 key (src/lib/media/publicUrl.ts).
          // That one rule is what lets a CloudFront `/media/*` behaviour serve
          // the bucket directly (sst.config.ts) and a local `next dev` serve the
          // identical URLs through one rewrite to S3Mock (next.config.ts). The
          // plugin records the prefix on each document (`prefix` column, added
          // by migration 20260918_*_media_prefix) so a future prefix change never
          // strands old files.
          prefix: MEDIA_S3_PREFIX,
          // Payload's own file route (`/api/media/file/<name>`) is switched
          // off: it proxied every byte through the BUFFERED Web Lambda (6 MB
          // response cap → a >4.5 MB photo 502'd for visitors) and cost one
          // invocation + an S3 round-trip per image view. Media `read` is
          // public anyway, so there is no access control to lose — CloudFront
          // + S3 with an origin access control is the serving path now.
          disablePayloadAccessControl: true,
          // The `url` Payload stores/returns for a file. Relative on purpose:
          // correct on every stage (bulbau.lu, the staging CloudFront host,
          // localhost) with nothing to configure, and Next resolves it against
          // `metadataBase` wherever an absolute URL is required (Open Graph).
          generateFileURL: ({ filename, prefix }) => mediaPublicUrl({ filename, prefix }),
        },
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
      //
      // `access` gates the presigned-URL endpoint the browser calls first
      // (`POST /api/storage-s3-generate-signed-url`). The plugin's default is
      // `!!req.user` — i.e. a PASSWORD-ONLY session, one that never completed
      // the mandatory TOTP step, could still obtain signed PUT URLs and write
      // arbitrary bytes into the media bucket (the Media document itself would
      // then be refused by `create: requireTotpVerified`, but the object is
      // already in S3). Same three checks as every other admin write.
      clientUploads: process.env.S3_ENDPOINT
        ? false
        : { access: ({ req }) => isFullyVerified(req) },
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
  // EN is the authoring source; FR/DE are populated by the translation
  // pipeline in Phase 5 (TECHSPEC §5, §6.7). All three locales are enabled now
  // so localized fields have their final shape and no schema migration is
  // needed when FR/DE go live. `fallback: true` means a locale with no value
  // yet falls back to the EN source, so the site is coherent before Phase 5.
  localization: {
    locales: [
      { code: 'en', label: 'English' },
      { code: 'fr', label: 'Français' },
      { code: 'de', label: 'Deutsch' },
    ],
    defaultLocale: 'en',
    fallback: true,
  },
})
