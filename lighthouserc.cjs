// Lighthouse CI configuration (TECHSPEC §6.11 / §7B).
//
// Runs Google Lighthouse against a PRODUCTION build of the public site in CI and
// fails the build on accessibility / SEO / best-practices regressions, with a
// performance budget that currently WARNS (see the rationale on `performance`
// below). This is the perf/SEO counterpart to the axe-core WCAG gate in
// tests/e2e/accessibility.e2e.spec.ts — together they replace the old "eyeball
// it at sign-off" TODO in .github/workflows/ci.yml.
//
// CommonJS (.cjs) on purpose: package.json has "type": "module", so a bare
// `lighthouserc.js` would be parsed as ESM and `module.exports` would throw.
// LHCI auto-discovers this file by name (`npx lhci autorun`).
//
// Chrome: GitHub's `ubuntu-latest` runner ships google-chrome-stable, which
// lighthouse's chrome-launcher finds automatically — no extra install step.
// Locally, LHCI uses your system Chrome.

module.exports = {
  ci: {
    collect: {
      // Audit the PRODUCTION server (`next start`), not `next dev` — dev is
      // unoptimized and its perf/JS numbers are meaningless. CI's `verify` job
      // has already run `npm run build`, so `npm run start` serves that build.
      // Booting Next boots Payload against the same CI Postgres the rest of the
      // job uses, so pages render exactly as e2e sees them (empty-content-safe).
      startServerCommand: 'npm run start',
      // `next start` prints "✓ Ready in <n>ms" once it's listening.
      startServerReadyPattern: 'Ready in',
      // Next + Payload cold boot can take a while; the 10s default is too tight.
      startServerReadyTimeout: 60000,
      // Stable, always-present pages (render even against an empty database).
      // Service detail (/services/[slug]) is omitted: no seeded services in CI
      // means those URLs 404. English home/projects/about cover the three main
      // page templates; /fr home guards locale-specific regressions.
      url: [
        'http://localhost:3000/en',
        'http://localhost:3000/en/projects',
        'http://localhost:3000/en/about',
        'http://localhost:3000/fr',
      ],
      // Median of 3 runs — Google's own guidance: 3 runs cut single-run variance
      // ~37%, which is the sweet spot for CI time vs. stability.
      numberOfRuns: 3,
      settings: {
        // Use APPLIED (devtools/CDP) throttling instead of Lighthouse's default
        // SIMULATED throttling. Simulated throttling drives the "Lantern" trace
        // model, which in Lighthouse 12.6.1 intermittently throws
        // (`LanternError: cycle detected`, `… not implemented in lantern`) —
        // noisy and a stability risk in CI. Applied throttling is deterministic
        // and sidesteps that path entirely. Numbers differ slightly from a
        // simulated run; performance is a WARN, so that's fine.
        throttlingMethod: 'devtools',
        // --no-sandbox: required for headless Chrome under the CI runner's
        // sandboxing. Harmless locally. (The Windows-only EPERM temp-cleanup
        // flake at Chrome teardown is a chrome-launcher issue, not fixable here —
        // it does not occur on the Linux CI runner, which is authoritative.)
        chromeFlags: '--no-sandbox',
      },
    },
    assert: {
      // FIRST-LANDING POSTURE: all four categories are tracked WARNs, not hard
      // gates. Rationale — the accessibility HARD gate already lives in axe
      // (tests/e2e/accessibility.e2e.spec.ts, serious/critical = build failure);
      // Lighthouse's job here is to establish a perf/SEO/best-practices BASELINE.
      // Setting error thresholds we haven't measured in CI would be a flaky gate
      // (and would false-fail for by-design reasons — see SEO below). The plan is
      // a two-step ratchet: (1) this run reports the real CI category scores;
      // (2) a follow-up flips the stable categories to `error` at a calibrated
      // minScore, and turns the intentional-noindex SEO audit off (below).
      assertions: {
        // WARN for now; ratchet to `error` once the CI baseline is known.
        // a11y is redundant here with the axe gate, so it stays a soft signal.
        'categories:accessibility': ['warn', { minScore: 0.9 }],
        'categories:best-practices': ['warn', { minScore: 0.9 }],

        // SEO must NOT be a hard gate while the build is noindex. Outside the
        // production stage the site is intentionally `noindex`
        // (NEXT_PUBLIC_ALLOW_INDEXING opt-in — src/lib/seo.ts), which Lighthouse
        // correctly penalises via `is-crawlable`. So `is-crawlable` is turned OFF
        // here (its "failure" is by design), and the SEO category is a WARN until
        // the ratchet, when it can gate the structural audits (title, meta
        // description, hreflang, canonical) that don't depend on indexing.
        'categories:seo': ['warn', { minScore: 0.9 }],
        'is-crawlable': 'off',

        // Performance WARN — sensitive to hydration JS + the still-open
        // `<img>`→`next/image` perf item (docs/PROGRESS.md). Ratchet after baseline.
        'categories:performance': ['warn', { minScore: 0.8 }],

        // Core Web Vitals as tracked WARNs — visible trend without blocking.
        'largest-contentful-paint': ['warn', { maxNumericValue: 4000 }],
        'cumulative-layout-shift': ['warn', { maxNumericValue: 0.1 }],
        'total-blocking-time': ['warn', { maxNumericValue: 600 }],
      },
    },
    upload: {
      // Keep reports on the CI filesystem so the workflow can attach them as a
      // build artifact. NOT temporary-public-storage — that uploads the report
      // to a public Google-hosted URL, which we don't want for a client site.
      target: 'filesystem',
      outputDir: './.lighthouseci',
      reportFilenamePattern: '%%HOSTNAME%%-%%PATHNAME%%-%%DATETIME%%.report.%%EXTENSION%%',
    },
  },
}
