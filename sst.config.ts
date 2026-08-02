// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- required by SST; top-level imports are not allowed in sst.config.ts (confirmed via `sst install`)
/// <reference path="./.sst/platform/config.d.ts" />

// SST (Ion) app config. Lives at the repo root because the SST CLI resolves
// `sst.config.ts` relative to the directory it's run from — it cannot be
// relocated into infra/ without also changing how every `sst <command>` is
// invoked, so this deviates from docs/TECHSPEC.md §4's original proposal.
// Standalone Terraform (for the long-lived/stateful resources outside SST's
// native components — the Route 53 hosted zone, the Neon project/branch, the
// deploy IAM role, and the account budget/alarm guardrails) lives in
// infra/terraform/ (added 2026-07-30; see its README + docs/TECHSPEC.md §10.3).
// The production `domain` block references that zone via a lookup, so a stage
// teardown never touches DNS.
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
    // Only the `production` stage gets the custom domain (bulbau.lu). Every
    // other stage (staging, ephemeral PR stages, local `sst dev`) keeps the
    // auto-generated *.cloudfront.net URL — so a stage teardown never touches
    // DNS and only production ever mints/validates an ACM certificate.
    const isProduction = $app.stage === 'production'

    // Name of the SSM parameter that will hold the Web CloudFront distribution
    // id. The running server function reads it to invalidate the CDN on content
    // changes (src/lib/cdn/invalidate.ts). Passing the id itself as a plain env
    // var is impossible in one pass — the server function would depend on the
    // distribution while the distribution depends on the function's URL (SST
    // issue #5990) — so we pass only this NAME (a static string, no cycle) and
    // write the VALUE to SSM AFTER `web` is created below.
    const cdnDistributionIdParam = `/bulbau-lu/${$app.stage}/web-cdn-distribution-id`

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
      // Custom domain — PRODUCTION ONLY (see `isProduction` above). All other
      // stages return `undefined` here and keep their *.cloudfront.net URL.
      //
      //   • name: the apex `bulbau.lu` is the canonical host.
      //   • redirects: `www.bulbau.lu` 301-redirects to the apex (SST provisions
      //     a lightweight redirect distribution + the extra DNS/cert SAN).
      //   • dns: sst.aws.dns({ zone }) points SST at the EXISTING Route 53 hosted
      //     zone that lives in Terraform (infra/terraform/dns.tf) — SST creates
      //     the validation + alias RECORDS inside it but never creates/owns the
      //     zone, so `sst remove` can't delete DNS. Zone ID is the Terraform
      //     output `zone_id` (Z0078043CEYQ2NGVQW6G); keep the two in sync.
      //   • cert: omitted ⇒ SST auto-creates + DNS-validates an ACM certificate
      //     in us-east-1 (required by CloudFront). The deploy role's policy was
      //     widened for exactly this (ACM in us-east-1 + Route 53 record writes)
      //     — see infra/aws/github-actions-deploy-policy.json.
      domain: isProduction
        ? {
            name: 'bulbau.lu',
            redirects: ['www.bulbau.lu'],
            dns: sst.aws.dns({ zone: 'Z0078043CEYQ2NGVQW6G' }),
          }
        : undefined,
      // Graviton (arm64) is cheaper and at least as fast as x86_64 for
      // Node.js Lambda workloads — no reason to pay for x86_64 here.
      server: {
        architecture: 'arm64',
        memory: '1024 MB',
        // Headroom over the in-save translation deadline (12s, see
        // src/lib/translation/hook.ts). Payload's afterChange runs inside the
        // save transaction, so the function MUST outlast the translation work —
        // otherwise a Lambda timeout would kill the request mid-transaction and
        // roll the publish back. 30s comfortably covers the bounded translation
        // plus Payload's own overhead; normal page requests finish in well under
        // a second regardless.
        timeout: '30 seconds',
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
      // AWS Translate auto-translation (Phase 5 — src/lib/translation/*). The
      // Next/Payload server function calls translate:TranslateText; it has no
      // resource ARNs, so the resource must be "*". No secret is involved —
      // the execution role carries this permission (that's the whole point of
      // choosing AWS Translate: one credential model, nothing to rotate).
      permissions: [
        { actions: ['translate:TranslateText'], resources: ['*'] },
        // On-demand CloudFront invalidation (src/lib/cdn/invalidate.ts). The
        // server function reads the distribution id from the SSM parameter
        // written below, then calls CreateInvalidation on a content change.
        {
          actions: ['ssm:GetParameter'],
          resources: [`arn:aws:ssm:eu-central-1:*:parameter${cdnDistributionIdParam}`],
        },
        // CreateInvalidation cannot be scoped to the specific distribution ARN
        // without recreating the #5990 dependency cycle, so it is scoped to "any
        // distribution in this (single-app) account" — the role can only ever
        // reach its own account's resources regardless.
        {
          actions: ['cloudfront:CreateInvalidation'],
          resources: ['arn:aws:cloudfront::*:distribution/*'],
        },
      ],
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
        // AWS Translate auto-translation (Phase 5). 'true' switches the on-save
        // EN→FR/DE hook ON for this deployed stage (the role has the permission
        // above). Unset locally/CI ⇒ the hook is a no-op and FR/DE fall back to
        // the EN source (src/lib/translation/provider.ts).
        TRANSLATE_ENABLED: 'true',
        // Name of the SSM parameter holding the CloudFront distribution id, read
        // at runtime by src/lib/cdn/invalidate.ts to purge the edge cache on
        // content changes. Unset locally/CI ⇒ invalidation is a no-op (the ISR
        // window handles freshness). The VALUE is written to SSM just below.
        CDN_DISTRIBUTION_ID_PARAM: cdnDistributionIdParam,
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

    // Publish the Web CloudFront distribution id to SSM so the server function
    // can read it at runtime for on-demand invalidation (src/lib/cdn/invalidate.ts).
    // Created AFTER `web` so the parameter depends on the distribution and NOT the
    // reverse — this is exactly what breaks the #5990 dependency cycle. `web.nodes.cdn`
    // is defined here because this stage owns a standalone CloudFront distribution
    // (it is only undefined when the site is served through a shared `Router`).
    new aws.ssm.Parameter('WebCdnDistributionId', {
      name: cdnDistributionIdParam,
      type: 'String',
      value: web.nodes.cdn!.nodes.distribution.id,
    })

    return {
      url: web.url,
      mediaBucket: media.name,
      pdfFunction: pdf.name,
      cdnDistributionIdParam,
    }
  },
})
