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

    const media = new sst.aws.Bucket('Media', {
      access: 'cloudfront',
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
      link: [media, databaseUrl, payloadSecret],
      environment: {
        DATABASE_URL: databaseUrl.value,
        PAYLOAD_SECRET: payloadSecret.value,
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
    }
  },
})
