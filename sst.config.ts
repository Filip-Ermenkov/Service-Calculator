// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- required by SST; top-level imports are not allowed in sst.config.ts (confirmed via `sst install`)
/// <reference path="./.sst/platform/config.d.ts" />

// SST (Ion) app config. Lives at the repo root because the SST CLI resolves
// `sst.config.ts` relative to the directory it's run from — it cannot be
// relocated into infra/ without also changing how every `sst <command>` is
// invoked, so this deviates from docs/TECHSPEC.md §4's original proposal.
// Standalone Terraform (for anything outside SST's native components, e.g.
// the Neon project/branch itself — see §10.3) still lives in infra/.
export default $config({
  app(input) {
    return {
      name: 'bulbau-lu',
      removal: input?.stage === 'production' ? 'retain' : 'remove',
      protect: ['production'].includes(input?.stage),
      home: 'aws',
      providers: {
        aws: {
          region: 'eu-central-1',
        },
      },
    }
  },
  async run() {
    // Populated via `sst secret set <Name> <value> --stage <stage>`.
    // Never hardcoded here — see README.md "Deploying" section.
    const databaseUrl = new sst.Secret('DatabaseUrl')
    const payloadSecret = new sst.Secret('PayloadSecret')
    // Required at runtime by the mandatory TOTP 2FA (src/lib/totp/keys.ts throws
    // if it's missing, which would break the admin panel on first load). It is a
    // SEPARATE secret from PayloadSecret on purpose (key separation) and MUST be
    // set before deploying, or `sst deploy` will fail — that hard failure is the
    // point: it makes "2FA has no key on this stage" impossible to ship silently.
    const totpEncryptionKey = new sst.Secret('TotpEncryptionKey')
    // Rate limiting for the 2FA verify endpoint (src/lib/totp/rateLimit.ts).
    // Given a default of '' so they're OPTIONAL: if unset, the limiter falls back
    // to its in-memory limiter (fine for a single warm instance pre-launch). Set
    // real Upstash values before production, where multiple Lambda instances make
    // the in-memory fallback unsafe (it can't share counters across instances).
    const upstashRedisRestUrl = new sst.Secret('UpstashRedisRestUrl', '')
    const upstashRedisRestToken = new sst.Secret('UpstashRedisRestToken', '')
    // Public site origin + search-indexing gate (Phase 2). Both OPTIONAL with
    // safe defaults: an unset SiteUrl falls back to the production domain for
    // canonical/OG/sitemap URLs (src/lib/seo.ts), and indexing stays OFF unless
    // AllowIndexing is explicitly 'true' — so the staging CloudFront URL is never
    // indexed. Set SiteUrl to the stage's real origin (e.g. the CloudFront URL on
    // staging) for accurate canonicals; set AllowIndexing='true' only on
    // production at launch. NEXT_PUBLIC_* ⇒ inlined at build by SST/OpenNext.
    const siteUrl = new sst.Secret('SiteUrl', '')
    const allowIndexing = new sst.Secret('AllowIndexing', '')

    const media = new sst.aws.Bucket('Media', {
      access: 'cloudfront',
    })

    // Isolated PDF-rendering function (Phase 4 — TECHSPEC §6.5/§13). Kept SEPARATE
    // from the Next/Payload Web function on purpose: bundling headless Chromium
    // into the hot-path app function is exactly the risk §13 calls out. This
    // function carries no Payload and no DB access — the Web function assembles
    // the quote HTML and invokes this to render it (see src/lib/pdf/render.ts).
    //
    // x86_64 (not arm64 like Web): the npm `@sparticuz/chromium` ships x64
    // binaries only; arm64 would need the -min package + a self-hosted remote
    // pack tar (an extra artifact to version + download at cold start). The two
    // functions are isolated, so the architecture mismatch is irrelevant and
    // this stays self-contained (the Chromium binary is bundled, nothing is
    // fetched at runtime). `nodejs.install` keeps @sparticuz/chromium as a real
    // node_module (its binary + relative path resolution break under esbuild).
    const pdf = new sst.aws.Function('Pdf', {
      handler: 'src/functions/pdf/handler.handler',
      runtime: 'nodejs22.x',
      architecture: 'x86_64',
      memory: '1600 MB',
      timeout: '60 seconds',
      nodejs: {
        install: ['@sparticuz/chromium', 'puppeteer-core'],
      },
    })

    const web = new sst.aws.Nextjs('Web', {
      // Graviton (arm64) is cheaper and at least as fast as x86_64 for
      // Node.js Lambda workloads — no reason to pay for x86_64 here.
      server: {
        architecture: 'arm64',
        memory: '1024 MB',
      },
      // Keeps 1 instance warm to reduce the cold-start impact that Payload's
      // admin panel is known to be sensitive to (relationship fields trigger
      // several parallel API calls per page load — see docs/TECHSPEC.md §13
      // spike notes). Costs a small, fixed number of extra invocations every
      // few minutes; free-tier covers it at this traffic level.
      warm: 1,
      // Linking `pdf` grants the Web function permission to invoke it; its name
      // is passed explicitly as PDF_FUNCTION_NAME (read by src/lib/pdf/render.ts).
      link: [media, databaseUrl, payloadSecret, totpEncryptionKey, upstashRedisRestUrl, upstashRedisRestToken, siteUrl, allowIndexing, pdf],
      environment: {
        DATABASE_URL: databaseUrl.value,
        PAYLOAD_SECRET: payloadSecret.value,
        // Isolated PDF renderer (Phase 4). Unset ⇒ src/lib/pdf/render.ts falls
        // back to serving the quote HTML (local dev / CI have no Chromium Lambda).
        PDF_FUNCTION_NAME: pdf.name,
        // Public site origin + indexing gate (see src/lib/seo.ts). Empty ⇒ safe
        // defaults (prod-domain canonicals, indexing off).
        NEXT_PUBLIC_SITE_URL: siteUrl.value,
        NEXT_PUBLIC_ALLOW_INDEXING: allowIndexing.value,
        // 2FA (see src/lib/totp/*). TOTP_ENCRYPTION_KEY is required; the Upstash
        // pair is optional (empty => in-memory rate-limit fallback).
        TOTP_ENCRYPTION_KEY: totpEncryptionKey.value,
        UPSTASH_REDIS_REST_URL: upstashRedisRestUrl.value,
        UPSTASH_REDIS_REST_TOKEN: upstashRedisRestToken.value,
        // Read by the s3Storage plugin in src/payload.config.ts. No explicit
        // AWS credentials are passed to that plugin — the Lambda's own
        // execution role (granted S3 access here via `link: [media, ...]`)
        // is picked up automatically by the AWS SDK's default credential
        // provider chain, same as everywhere else in this app.
        S3_BUCKET: media.name,
        // Known OpenNext/Lambda workaround: without this, some Payload API
        // routes stream an empty body and the response hangs. Confirmed via
        // the Phase 0 spike (docs/TECHSPEC.md §13) — see also
        // https://opennext.js.org/aws/common_issues
        OPEN_NEXT_FORCE_NON_EMPTY_RESPONSE: 'true',
      },
    })

    return {
      url: web.url,
      mediaBucket: media.name,
      pdfFunction: pdf.name,
    }
  },
})
