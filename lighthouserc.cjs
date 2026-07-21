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
      // English home/projects/about cover the three main page templates; /fr home
      // guards locale-specific regressions. The service-detail template
      // (/services/ci-sample-service) is now audited too: the CI `verify` job
      // seeds one published sample service (npm run seed:ci) before this step, so
      // the page — the live calculator + Download-PDF surface — renders with real
      // content instead of 404-ing on an empty DB. It brings the meta-description
      // and legible-font-size hard gates onto that template as well.
      url: [
        'http://localhost:3000/en',
        'http://localhost:3000/en/projects',
        'http://localhost:3000/en/about',
        'http://localhost:3000/en/services/ci-sample-service',
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
      // Thresholds CALIBRATED against the first CI (Linux) baseline: accessibility,
      // best-practices, and performance each cleared these values on all 4 URLs ×
      // 3 runs (12/12) with margin, so they are now HARD gates — a regression below
      // them fails the build. SEO stays a WARN by design (see below). Metrics stay
      // WARN (noisier than category scores; the performance category already gates
      // overall speed). This complements the axe WCAG hard gate in
      // tests/e2e/accessibility.e2e.spec.ts.
      assertions: {
        // Hard gates — proven to pass 12/12 in CI at these thresholds.
        'categories:accessibility': ['error', { minScore: 0.9 }],
        'categories:best-practices': ['error', { minScore: 0.9 }],
        // Performance floor. Passed 12/12 at 0.8 with no single-run dip, so 0.8 is
        // a safe regression floor. Tighten once the `<img>`→`next/image` perf pass
        // lands (docs/PROGRESS.md) and a higher baseline is confirmed.
        'categories:performance': ['error', { minScore: 0.8 }],

        // SEO — the pre-launch SEO/mobile-legibility polish slice (2026-07-21)
        // fixed the real audits that were failing UNDER the composite score, and
        // now gates them individually as HARD errors so they can't regress:
        //   • meta-description — every static page now emits a non-empty,
        //     localized description (/legal + /privacy had none; /about and
        //     /services/[slug] fall back to a localized string when the CMS is
        //     empty). Deterministic pass/fail, so it's a hard gate.
        //   • font-size (legible-font-size) — no public text renders below 12px
        //     anymore (all sub-12px labels raised to 0.75rem in globals.css).
        // These are deterministic DOM audits (unlike noisy metric/category
        // scores), so gating them on `error` is safe, not a guessed threshold.
        'meta-description': ['error', { minScore: 1 }],
        'font-size': ['error', { minScore: 1 }],
        // NB: Lighthouse 12 REMOVED the `tap-targets` audit from the SEO category
        // (asserting it here just raised a harmless "not a known audit" warning in
        // CI, so it is intentionally not asserted). Target size is still handled —
        // the compact language switcher / mobile menu button were enlarged to a
        // 44px touch target (clears WCAG 2.2 SC 2.5.8's 24px AA minimum), and the
        // axe-core WCAG gate (tests/e2e/accessibility.e2e.spec.ts) is the
        // authoritative a11y gate for target size going forward.

        // The COMPOSITE SEO category stays a WARN for one reason only now: the
        // intentional `noindex` outside production (NEXT_PUBLIC_ALLOW_INDEXING
        // opt-in — src/lib/seo.ts). `is-crawlable` is turned off since its
        // "failure" is deliberate. With the audits above fixed, enabling indexing
        // at launch is expected to lift this to >=0.9 — at which point it becomes
        // a hard gate (a Phase 7 launch step).
        'categories:seo': ['warn', { minScore: 0.9 }],
        'is-crawlable': 'off',

        // Core Web Vitals as tracked WARNs — visible trend without blocking on
        // per-run metric variance (the performance category is the hard gate).
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
