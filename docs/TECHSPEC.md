# Technical Specification — bulbau.lu

> **Status**: Living document. This is the technical plan for the entire application. Every implementation slice must be checked against this document before work starts, and this document must be amended once a slice is built, tested, and signed off — before the next slice begins. If reality and this document diverge, this document loses, and gets updated.
>
> **Companion document**: `docs/FUNCTIONALITY.md` (non-technical functional spec — the "what"). This document is the "how."
>
> **Progress**: Phase 0 (Section 12) is complete and signed off as of 2026-07-04. The one gap it was signed off with — no automated test for media upload/delete — was itself closed in a follow-up slice, also complete and signed off, as of 2026-07-04. See `docs/PROGRESS.md` for the full build/debug history and current handoff state — this document reflects the *plan as corrected by what Phase 0 (and its follow-up) actually required*; that file explains *how it got there*.

---

## 1. Guiding principles

1. **Best tool for the job, not the biggest brand.** AWS-native is a fine default, not a rule. A component is chosen because it's the best fit for this workload's actual shape (single admin, low-to-moderate public traffic, bursty usage), not because it's from the same vendor as everything else.
2. **Cheap now, portable later.** Every stateful piece of this system (database, media) uses a standard, portable technology (Postgres wire protocol, S3-compatible object storage) so that swapping the compute layer later is an infrastructure change, never a data migration or a rewrite.
3. **Security is not a budget line.** Encryption, secrets hygiene, 2FA, input validation, and dependency hygiene cost effectively nothing regardless of hosting tier and are non-negotiable from day one. What *does* scale with budget is redundancy/uptime (multi-AZ, standby capacity) — that's an explicit, revisitable business decision, not a security gap.
4. **Ship in slices.** Each phase in Section 12 is built, manually and automatically tested, and confirmed working end-to-end before the next phase starts.
5. **No proprietary lock-in on data.** Postgres over SQLite/DynamoDB for the primary store, specifically so a future migration between hosting providers is a `pg_dump`/`pg_restore`, not a data model port.

---

## 2. Architecture overview

The application is a single Next.js (App Router, TypeScript) codebase with **Payload CMS 3.x embedded directly in it** (Payload 3 runs inside a Next.js app rather than beside it — same repo, same deploy artifact, same server). Payload provides: the admin panel framework, authentication, localization (EN/FR/DE), media uploads, draft/publish workflow, and auto-generated REST/GraphQL/Local APIs. Everything Payload doesn't provide out of the box (formula builder, TOTP 2FA, PDF generation, translation pipeline) is built as custom code inside this same app.

### 2.1 Two deployment topologies, one codebase

This project deliberately runs through **two infrastructure phases** without ever changing the application code:

```
Phase A — Serverless (now → until sustained traffic justifies otherwise)
──────────────────────────────────────────────────────────────────────
 Visitor / Admin
      │
      ▼
 CloudFront  ──── S3 (static assets, uploaded media)
      │
      ▼
 Lambda (Next.js + Payload, via OpenNext)  ──── Lambda (PDF generation, isolated)
      │
      ▼
 Neon (serverless Postgres, scale-to-zero)

Phase B — Containers (triggered by sustained load, not "growth" per se)
──────────────────────────────────────────────────────────────────────
 Visitor / Admin
      │
      ▼
 CloudFront  ──── S3 (unchanged)
      │
      ▼
 ALB → ECS Fargate (same Docker image, same app code)
      │
      ▼
 RDS / Aurora Postgres (data restored from Neon via pg_dump/pg_restore)
```

The only things that change between Phase A and Phase B: the compute target (Lambda function → Fargate service/container) and the Postgres host (Neon → RDS/Aurora). The domain, CloudFront distribution, S3 bucket, application code, database schema, and all content are untouched. See Section 11 for the exact migration procedure and trigger criteria.

---

## 3. Technology stack

| Layer | Choice | Why |
|---|---|---|
| Application framework | Next.js 16.2 (App Router, TypeScript) | Industry-standard React meta-framework; SSR/ISR fits a content site that also needs SEO; native support in every tool below. Bumped from the original "15+" during Phase 0 — 15 reaches EOL Oct 2026, so 16.2 was the correct pin, not just the newest. |
| CMS / backend | Payload CMS 3.85.x, embedded in the Next.js app | Native localization model matches the EN-source + FR/DE-override requirement exactly; built-in draft/publish, media handling, auth, and an extensible admin UI framework we need anyway for the custom formula builder. Avoids building a bespoke CMS and a bespoke admin panel as two separate systems. Uses `@payloadcms/db-postgres` (Drizzle-based) as the DB adapter, not the Mongo default or a Vercel-specific adapter. |
| Database | Postgres, via Payload's official Postgres (Drizzle) adapter | Standard SQL, not a proprietary format — this is what makes the Phase A → Phase B migration a dump/restore instead of a rewrite. Rejected SQLite/Turso for the same reason (different dialect, harder to port to RDS later) and DynamoDB (no official Payload adapter — would mean abandoning Payload's data layer). |
| Database host (Phase A) | **Neon** (serverless Postgres) | True scale-to-zero (not just a low floor), standard Postgres wire protocol, free tier covers this workload entirely. Non-AWS, which is an accepted trade-off given the cost and portability benefits. |
| Database host (Phase B) | RDS or Aurora Postgres | Managed, VPC-native, integrates with the rest of an AWS container deployment. |
| Compute (Phase A) | AWS Lambda via **OpenNext** (`@opennextjs/aws`) + **SST v4** | OpenNext is the current standard adapter for running Next.js on Lambda (backed by a multi-vendor working group including Vercel, Cloudflare, Netlify, AWS). SST provisions and deploys it. Confirmed working end-to-end in the Phase 0 spike (Section 13). |
| Compute (Phase B) | ECS Fargate | Managed container hosting, no host patching, standard target for "graduated" web apps; App Runner confirmed ruled out — it entered maintenance mode Mar 2026 and closed to new customers Apr 2026. Worth evaluating ECS **Express Mode** (launched Nov 2025) when Phase B planning starts: shares one ALB across services and supports scale-to-zero in non-prod, which may make the Phase B baseline in Section 9 cheaper/simpler than the manual Fargate+ALB setup currently scoped — not yet incorporated into this document's Phase B numbers, flagged for evaluation at that time. |
| IaC / deployment tool | **SST v4** ("Ion" engine) as primary; **Terraform** for anything outside SST's native components | SST's own engine moved off CDK/CloudFormation onto Pulumi + Terraform providers specifically for multi-provider support and to avoid CloudFormation's per-stack resource limits — the same reason we need it here, since Neon isn't an AWS resource and CDK/CloudFormation cannot model it. SST can consume the community Neon Terraform provider directly, keeping one IaC surface for AWS + Neon. CDK was deliberately not chosen (see Section 10.4 for the full reasoning). `sst.config.ts` lives at the repo root, not `infra/` — see Section 4. |
| PDF generation | Playwright + `@sparticuz/chromium-min`, in its own isolated Lambda function | On-demand, rarely invoked, pay-per-call — a textbook serverless workload. Isolated from the main app function to keep the Chromium binary out of the hot-path bundle. |
| Formula/pricing engine | JSON-based rule structure evaluated with `json-logic-js` (or equivalent safe evaluator) | Never `eval()`/`new Function()` on admin-authored input. Same evaluator runs both server-side (validation, PDF) and client-side (real-time recalculation), so they can't drift apart. |
| Translation | DeepL API (Free tier initially) | Measurably better quality than Google/AWS Translate specifically for FR/DE, the two languages this entire site depends on. Free tier (500k characters/month) comfortably covers this site's content volume. |
| Transactional email | AWS SES | Contact form relay, quote-by-email delivery, password reset emails. Requires SPF/DKIM/DMARC setup on the bulbau.lu domain. |
| Background/async jobs | Payload's built-in Jobs Queue, triggered by an SST scheduled (cron) Lambda | Covers translation regeneration and email retries without standing up a separate queue service. |
| Rate limiting / lockout counters | Upstash Redis (serverless, pay-per-request, REST-friendly) | Needed for login lockout and contact-form throttling; a persistent ElastiCache node would be an always-on cost that contradicts the serverless-first phase. |
| Spam protection | Cloudflare Turnstile + honeypot field | Turnstile is usable standalone (no need to move DNS/CDN to Cloudflare) and is free. |
| Secrets | SSM Parameter Store (free) for static config; Secrets Manager only for the DB credential that benefits from rotation | Keeps recurring cost near zero without giving up rotation where it matters. |
| CDN / edge | CloudFront | Fronts both the Lambda app and S3 media/static assets; carries AWS Shield Standard (free) DDoS protection by default. |
| DNS | Route 53 (hosted zone; domain registration for `.lu` stays with a Luxembourg-accredited registrar, delegated via NS records) | Route 53 Domains does not sell `.lu` TLDs. |
| AWS region | `eu-central-1` (Frankfurt), not `us-east-1` | This is a Luxembourg business serving EU visitors; EU data residency is the expected default for GDPR purposes even though it isn't always a strict legal mandate. Frankfurt over Dublin (`eu-west-1`) specifically for lower latency from Luxembourg. Cost figures in Section 9 re-verified against `eu-central-1` pricing at Phase 0 sign-off (2026-07-04) — see Section 9's note. |
| Analytics | Plausible (or a self-hosted cookieless equivalent, e.g. Umami) | Cookie-free by design, decided deliberately so the site needs no cookie-consent banner at all — the only cookie in use anywhere is the strictly-functional language preference. Rejected Google Analytics for the same reason: it sets tracking cookies and would force a consent-banner requirement this site doesn't otherwise need. |
| i18n routing | `next-intl`, URL-prefixed locales (`/en`, `/fr`, `/de`) | Deviation from the literal wording of `FUNCTIONALITY.md` §2.1 ("session... for the duration of the visit"), made deliberately: session-only language switching is invisible to search engines, meaning FR/DE content would likely never get indexed. URL-based locales with auto-detection on first visit satisfy the same UX requirement (switch anytime, stay on the same page) while remaining crawlable and hreflang-taggable. |
| Auth | Payload's built-in auth (login, logout, forgot/reset password) + custom TOTP step | Payload does not ship 2FA natively; the Google Authenticator step is added as a second verification stage via a custom hook/endpoint using `otplib`, with failed-attempt counters in Upstash Redis. |
| CI/CD | GitHub Actions | Lint, typecheck, test, build → deploy via SST/Terraform, staging then production. |

---

## 4. Repository structure (as built, Phase 0)

Corrected against reality during Phase 0 — three deliberate deviations from the original proposal above, each explained inline below.

```
Service-Calculator/
├── docs/
│   ├── FUNCTIONALITY.md
│   ├── TECHSPEC.md
│   └── PROGRESS.md             # Rolling build/debug history + handoff state
├── prototype/                  # Static, client-approved HTML/CSS/JS visual reference.
│                                # Zero backend logic, not architecture — layout/design
│                                # reference only. Renamed from frontend/prototype/ during
│                                # Phase 0 to remove the naming collision with the route
│                                # group below (was ambiguous which "frontend" was which).
├── src/
│   ├── app/
│   │   ├── (frontend)/          # Public site (page.tsx, layout.tsx, styles.css)
│   │   ├── (payload)/           # Payload's admin UI mount + REST/GraphQL routes —
│   │   │                        # generated by Payload's installer, follows Payload's own
│   │   │                        # official route-group convention. Do not hand-edit
│   │   │                        # admin/importMap.js; regenerate it (`npm run
│   │   │                        # generate:importmap`) whenever a collection, field, or
│   │   │                        # plugin that contributes admin UI changes — Phase 0 hit
│   │   │                        # this exact staleness bug twice.
│   │   └── (payload)/admin/importMap.js  # generated, see above
│   ├── collections/             # Users, Media so far — Services/Projects/CareerListings/
│   │                             # CompanyInfo/LegalInfo/Translations land in Phase 1+
│   ├── payload.config.ts
│   └── payload-types.ts         # generated (`npm run generate:types`)
├── infra/
│   └── aws/                     # Standalone, one-time AWS bootstrap — NOT managed by
│       ├── github-actions-trust-policy.json    # sst.config.ts or Terraform, since it has
│       ├── github-actions-deploy-policy.json   # to exist before SST/CI can run at all.
│       └── README.md                           # Applied once by hand via AWS CLI; see
│                                                # its own README for the reasoning and
│                                                # the Access Analyzer follow-up.
├── tests/
│   ├── int/                    # Vitest, against a real Postgres (local or CI service container)
│   ├── e2e/                    # Playwright
│   └── helpers/
├── sst.config.ts                # AWS infra (SST v4/Ion). Deliberately at repo root, not
│                                # infra/ — the SST CLI resolves this path relative to
│                                # wherever `sst` is invoked from and cannot be relocated
│                                # without changing every `sst <command>` invocation. When
│                                # this file's `run()` body grows unwieldy (Phase 4's PDF
│                                # Lambda, Phase 5's cron Lambda), split its contents into
│                                # imported files under infra/ (SST's own documented
│                                # pattern for this) — the file itself stays at root.
├── docker-compose.yml           # Local Postgres only; the app runs on the host, not in Docker
└── .github/workflows/
    ├── ci.yml
    └── dependabot.yml
```

No `apps/`/`packages/` monorepo split: this is one deployable unit (Next.js + embedded Payload), and that pattern solves a different problem (multiple independently-deployable apps sharing code) that doesn't describe this project. SST's own default template recommends a workspace layout for "frontend + backend + functions"-shaped projects, but SST also explicitly supports keeping `sst.config.ts` at repo root while splitting only its contents — which is the path taken here, deferred until there's actually enough to split.

---

## 5. Content model (Payload collections)

| Collection | Key fields | Notes |
|---|---|---|
| `Services` | title, description (rich text), heroImage, cardImage, cardTitle, cardDescription, status (draft/published), order, calculatorFields[], formula (JSONLogic), disclaimer text | `calculatorFields` and `formula` are edited via the custom Formula Builder admin component (Section 6.4). |
| `Projects` | title, description, photo, completionDate, service (relationship → Services, retained even if the service is later deleted per `FUNCTIONALITY.md` §7), status | |
| `CareerListings` | title, description, photo, status (active/archived), order | |
| `CompanyInfo` | global singleton: email, phone, Facebook URL, Instagram URL, aboutUsContent (rich text) | Referenced everywhere contact details appear. |
| `LegalInfo` | global singleton: legalName, legalForm, registeredAddress, rcsNumber, vatNumber, legalContactEmail, privacyPolicyContent (rich text), status (draft/published) | Backs the Legal Notice and Privacy Policy pages (Section 6.9). `legalName`/`legalForm`/`rcsNumber`/`vatNumber`/`registeredAddress` are required fields that block moving `status` to `published` — this collection stays in draft until the client's real registration details are entered; it must never ship with placeholder values. |
| `Translations` | auto-managed shadow of every localized field: englishSource, frText, deText, overrideFr, overrideDe, sourceHash, needsReview | Populated/updated by hooks, surfaced in the admin Translation Management screen. |
| `Users` | email, password (hashed by Payload), totpSecret, totpEnabled, failedAttempts, lockedUntil | Single administrator; no role system needed per `FUNCTIONALITY.md`. |
| `Media` | Payload's built-in upload collection, backed by S3; `altText` (required) | Alt text is enforced at the schema level, not left as an optional afterthought — it's both an accessibility requirement (Section 7B) and an SEO one (Section 6.11). |

All content-bearing collections use Payload's native localization (`en` required, `fr`/`de` auto-populated) rather than a hand-rolled translation table, so drafts/versions and localization compose correctly out of the box.

---

## 6. Feature implementation plan

### 6.1 Global behaviour (language, responsive, header/footer)
`next-intl` middleware resolves `/en`, `/fr`, `/de` prefixes; initial visit is redirected based on `Accept-Language`, then the choice is persisted in the URL (not just a cookie) for indexability. Header/footer are shared layout components pulling contact details from the `CompanyInfo` singleton, so a single edit propagates everywhere per the requirement in `FUNCTIONALITY.md` §5.6. Responsive layout via Tailwind, matching the breakpoints already established in the approved prototype's CSS.

### 6.2 Public pages (Home, Projects, About, Careers)
Rendered with Next.js static generation + on-demand revalidation (ISR), invalidated via a Payload `afterChange` hook that calls Next.js's on-demand revalidation API whenever content is published. This means most public traffic is served from CloudFront's cache and never invokes the Lambda function at all — which is both fast and keeps Lambda invocation counts (and cost) low. Projects page search/filter runs client-side against a small pre-fetched dataset (this site's project count doesn't justify a search backend).

### 6.3 Service page & real-time calculator
Each service's `calculatorFields` + `formula` are fetched once per page load. The formula is evaluated client-side with the same `json-logic-js` evaluator used server-side, so the live price updates on every keystroke with no round trip, matching `FUNCTIONALITY.md` §3.3. The zero/negative-result edge case (§7) is handled inside the evaluator wrapper: any non-positive result renders "Contact us for a price" instead of a number, on both the web page and the PDF.

### 6.4 Calculator Field Builder & Formula Builder (admin)
Built as a custom Payload field component (React, mounted in the `Services` collection edit view):
- Field list editor: label, type (number/dropdown/toggle), options, multiplier, sign (+/−), required flag, drag-to-reorder.
- Formula builder: a structured (not free-text) UI for grouping fields, fixed costs, and percentage adjustments, serialized to a JSONLogic AST — never a string of executable code.
- Live preview panel evaluates the in-progress formula against sample values using the exact same evaluator the public page uses, so what the admin sees in preview is guaranteed to match production behaviour.

### 6.5 PDF quote generation & delivery
A dedicated Lambda function (Playwright + `@sparticuz/chromium-min`) renders an HTML/CSS quote template — reusing the same design system as the site — to PDF, on demand, never persisted to storage. Invoked either for direct download (returned inline) or piped into an SES `SendRawEmail` call for the "send to email" path. Failure to send (invalid address, SES bounce) surfaces a clear error with a fallback offer to download instead, per `FUNCTIONALITY.md` §7.

### 6.6 Admin panel & authentication
Payload's admin UI is used as-is for Projects, Careers, and CompanyInfo (no custom UI needed there — this is exactly what "off-the-shelf CMS admin" is good at). Translation Management gets a custom admin view instead (Section 6.7), since it needs cross-collection search and override/review state that default CRUD screens don't provide. Login flow: Payload's native email/password check, then a second TOTP step (`otplib`, secret provisioned via a QR code shown once at setup, matching `FUNCTIONALITY.md` §5.1/§5.8). Failed attempts are counted in Upstash Redis with a temporary lockout; password reset uses Payload's built-in signed-token flow, emailed via SES, expiring after one hour.

### 6.7 Translation management & lifecycle
On save of any localized field, a Payload hook computes a hash of the English source and enqueues a Jobs Queue task (processed by a scheduled Lambda) that calls the DeepL API for FR and DE if no manual override exists, or flags `needsReview: true` if an override exists and the source hash changed. The Translation Management screen (custom Payload admin view) lists every translatable string, its auto-translation, any override, and review status, matching `FUNCTIONALITY.md` §5.7 exactly.

### 6.8 Contact form & spam protection
Standard form submission → SES relay to the address configured in `CompanyInfo`, protected by Cloudflare Turnstile plus a honeypot field as a no-JS fallback. Same Upstash Redis-backed throttling as login, keyed by IP, to prevent abuse without needing a paid WAF from day one.

### 6.9 Legal Notice & Privacy Policy pages
Rendered the same way as the About Us page — localized rich text from a Payload global (`LegalInfo`), linked from the footer on every page (`FUNCTIONALITY.md` §2.5). A Payload validation hook prevents `LegalInfo.status` from being set to `published` unless `legalName`, `legalForm`, `rcsNumber`, `vatNumber`, and `registeredAddress` are all populated — this is a deliberate technical safeguard against the page ever going live with placeholder or invented legal details. Until the client provides the real registration details, the page either doesn't render publicly or renders clearly marked as a draft, and this blocks production sign-off for Phase 6 (contact form) regardless of whether the rest of that phase is otherwise complete.

### 6.10 Analytics
Plausible's tracking script (or the self-hosted equivalent) is added sitewide, outside of any consent-gating logic since it sets no cookies and processes no personal data — consistent with the Privacy Policy's disclosure in §2.5.

### 6.11 SEO implementation
The architecture is SEO-friendly by design (SSR/ISR instead of client-only rendering, URL-based locales with hreflang — Section 3), but that's the foundation, not the whole job. Built explicitly, per page:
- Per-page `<title>`/meta description generated from each collection's existing title/description fields (no new content-authoring burden on the admin).
- Open Graph and Twitter Card tags, using each service/project's existing hero image.
- Structured data (schema.org `LocalBusiness` on Home/About, `Service` on each service page), generated from data already in `CompanyInfo`/`Services` — no separate content to maintain.
- A generated, localized XML sitemap and `robots.txt` (Next.js's built-in `sitemap.ts`/`robots.ts` conventions).
- Canonical URLs per locale, with `hreflang` alternates pointing at the `/en`, `/fr`, `/de` versions of each page.
- Required alt text on every `Media` upload (Section 5) — both an accessibility requirement (Section 7B) and an SEO one.
- A Core Web Vitals budget enforced in CI (Lighthouse CI against the staging deploy) rather than left to chance.

---

## 7. Security baseline (applies regardless of hosting tier)

- Passwords hashed with a modern algorithm (Payload default, verified to be argon2id-equivalent strength); TOTP secrets encrypted at rest.
- All traffic TLS-only (CloudFront enforces HTTPS; HTTP redirects).
- Secrets never in source or environment files committed to git — SSM Parameter Store / Secrets Manager only, referenced by ARN in SST config.
- Dependency scanning (`npm audit` / GitHub Dependabot) in CI; fails the build on high/critical findings.
- Input validation on every Payload collection and every route handler (Zod schemas on top of Payload's own field validation).
- Rate limiting on login, contact form, and quote-email endpoints (Section 6.8/6.6).
- Least-privilege IAM: each Lambda function gets only the permissions it needs (e.g., the PDF function has SES `SendRawEmail` but no database access).
- CloudFront + Shield Standard (free) from day one; AWS WAF and GuardDuty are deferred cost-wise (Section 9) but are a config addition, not an architecture change, whenever traffic/risk profile justifies them.

---

## 7A. Compliance & data residency (GDPR)

This is a Luxembourg business serving EU visitors, so GDPR applies regardless of hosting location, and data residency choices should reflect that:

- **Region**: EU AWS region — `eu-central-1` (Section 3), not US.
- **Minimal data footprint by design**: the contact form is relayed straight to the company's inbox and never persisted in the database; PDF quotes are generated on demand and never stored (both already specified in `FUNCTIONALITY.md` §3.3/§4). This meaningfully shrinks the GDPR surface compared to a site that stores visitor submissions.
- **Sub-processors**: AWS, Neon, DeepL, and Cloudflare (Turnstile) all process data on the company's behalf and each need a Data Processing Agreement in place — all four publish standard DPAs, but this needs to actually be reviewed and accepted during Phase 0 setup, not assumed.
- **Cookie/consent — resolved**: analytics is Plausible (or an equivalent cookie-free tool), and the only other cookie anywhere on the site is the strictly-functional language preference. Neither requires a consent banner under GDPR/ePrivacy, so the site ships with **no cookie-consent banner**, and this is disclosed (not hidden) in the Privacy Policy.
- **DPO — resolved**: this business's data processing (contact-form inquiries only, no large-scale or special-category data) doesn't meet GDPR Article 37's threshold for a mandatory Data Protection Officer. The admin/business owner is listed as the data controller in the Privacy Policy instead.
- **Retention — resolved**: no fixed retention period is specified; the Privacy Policy states messages are kept only as long as needed to respond, then deleted per normal business practice.
- **Legal Notice / Privacy Policy — specified, not yet publishable**: both pages are now fully specified in `FUNCTIONALITY.md` §2.5 and implemented per Section 6.9. They cannot go live with placeholder legal details — the company's registered legal form, RCS Luxembourg number, VAT number, and registered address are still pending from the client and are a hard gate on Phase 6 sign-off, enforced technically (Section 6.9), not just procedurally.

---

## 7B. Accessibility (WCAG 2.1 AA)

Not previously specified anywhere in this document — added on review, not because a client or legal mandate demanded it, but because it's current best practice for any public-facing site and is far cheaper to build in than to retrofit:

- Target WCAG 2.1 AA: semantic HTML landmarks, full keyboard navigation (including the calculator and the admin panel's custom formula-builder component — the easiest place for a custom UI to silently fail this), visible focus states, sufficient color contrast carried over from the already-approved prototype's design, and required alt text on all media (Section 5).
- The EU's Accessibility Act (in force since June 2025) most clearly covers e-commerce; whether a quote-generation (not transactional) site like this falls squarely within its scope is genuinely ambiguous and not worth over-claiming either way — but WCAG 2.1 AA is the right bar regardless of whether it's strictly mandated here.
- Verified with automated tooling (axe-core in CI, similar to the Lighthouse CI check in Section 6.11) plus a manual keyboard-only and screen-reader pass before each phase's sign-off (Section 12), not assumed from automated checks alone — automated tools catch a minority of real accessibility issues.

---

## 8. Non-functional expectations (current phase)

Given this is a single-administrator marketing/lead-generation site with no payment processing and modest traffic:

- No formal uptime SLA. Occasional brief unavailability from a cold Lambda/Neon resume after an idle period is an accepted trade-off for near-zero cost (Section 9).
- No multi-AZ/HA requirement yet. Revisit if/when the business depends on continuous availability or compliance requires it.
- Backups: Neon's point-in-time recovery in Phase A; RDS automated backups + snapshots in Phase B.
- Observability: CloudWatch logs/alarms on Lambda errors and elevated latency; expand to structured tracing if/when traffic grows.

---

## 9. Cost model

> Re-verified against `eu-central-1` pricing at Phase 0 sign-off (2026-07-04). Lambda's perpetual free tier (1M requests + 400,000 GB-seconds/month) is confirmed still current and unchanged. The general ~10–20% EU-vs-`us-east-1` premium the original estimate flagged holds directionally across S3/CloudFront/Route 53/SES, but at this traffic level (dominated by free-tier coverage) it doesn't move the total out of the range below — realistically €3–8/month rather than a single fixed number, which is the honest level of precision worth claiming for a pre-launch workload.

### Phase A — serverless (current target)

| Item | Estimated monthly cost |
|---|---|
| Lambda (app + PDF function) | €0 (within the perpetual free tier at this traffic level) |
| Neon Postgres | €0 (free tier: scale-to-zero, 0.5GB storage, 100 CU-hours/month) |
| S3 (media, static assets) | ~€1 |
| CloudFront | ~€0–1 |
| Route 53 hosted zone | ~€1 |
| SES | <€1 |
| DeepL API | €0 (free tier, 500k characters/month) |
| Upstash Redis | €0 (free tier) |
| SSM Parameter Store / Secrets Manager | <€1 |
| **Total** | **≈ €3–5/month** |

Deliberately deferred at this phase: AWS WAF (~€8/month) and GuardDuty (~€4–5/month). Both are additive later without touching the architecture.

### Phase B — containers (future, triggered per Section 11.1)

Baseline ECS Fargate + ALB + RDS single-AZ setup, as scoped earlier in this project: **≈ €65–70/month**, or a leaner self-managed EC2 variant at **≈ €20–25/month** if warranted. Full multi-AZ Well-Architected posture: **≈ €150–220/month**, only justified once uptime has real financial consequences.

---

## 10. Infrastructure & deployment details

### 10.1 Environments
`local` (Docker Compose Postgres or a Neon branch per developer), `staging` (separate Neon project + separate Lambda/S3/CloudFront stack via SST), `production`.

### 10.2 CI/CD (GitHub Actions)
1. Lint + typecheck + unit/integration tests on every PR.
2. On merge to `main`: build → deploy to staging via `sst deploy --stage staging` → run E2E suite, Lighthouse CI (Section 6.11), and axe-core accessibility checks (Section 7B) against staging → manual approval gate → `sst deploy --stage production`.

### 10.3 IaC ownership
- SST (`infra/sst.config.ts`): Lambda functions, CloudFront, S3, Route 53 records, SES identity, Payload's environment wiring — and the Neon project/branches, via SST's ability to consume Terraform/Pulumi providers directly.
- Standalone Terraform: only for anything SST can't model directly, decided case-by-case as the project progresses (kept in `infra/` alongside the SST config, same repo).

### 10.4 Why not CDK
CDK/CloudFormation is AWS-only and cannot declare the Neon database as code, which this project needs from day one. CloudFormation/CDK's automatic rollback-on-failure is a genuine advantage over Terraform's fail-forward model, but it doesn't offset the multi-provider gap, and it isn't foolproof either (a failed rollback can itself get stuck). SST's own engine made the same call — it moved off CDK onto Pulumi/Terraform providers for exactly this reason.

---

## 11. Migration path: serverless → containers

### 11.1 Trigger criteria (any one is sufficient to start planning the move)
- Sustained (not bursty) request volume where Lambda's per-invocation cost consistently exceeds what a fixed-capacity container would cost.
- Cold starts (app or database) becoming frequent enough to visibly affect user experience.
- Neon's free/low tier consistently exceeded.
- A business requirement for formal uptime guarantees or compliance posture that Phase A doesn't offer.

### 11.2 Procedure
1. Provision RDS/Aurora Postgres; `pg_dump` the Neon database and `pg_restore` into it. No schema changes — same Payload Postgres adapter either way.
2. Build the existing codebase as a Docker image (validated continuously from early in Phase A, not created for the first time at cutover) and deploy to ECS Fargate behind an ALB, pointed at the restored database.
3. Smoke-test the container deployment against a copy of production data before cutover.
4. Swap CloudFront's origin from the Lambda function URL to the ALB. Domain, S3 media bucket, and DNS records are unchanged — no URL changes, no re-indexing, no visitor-facing disruption beyond the cutover window itself.
5. Decommission the Lambda app function and the Neon project once the container deployment is confirmed stable.

No content, media, translations, or configuration is ever tied to the compute choice — only S3 (media) and Postgres (everything else) hold state, and both are portable by design.

### 11.3 Scaling beyond the Phase B baseline

Worth being explicit about, since neither "Phase A" nor "Phase B" as scoped is an unlimited-scale claim: the Phase B baseline in Section 9 (single Fargate task, single-AZ database) is a starting point sized for this project's actual traffic, not a ceiling disguised as one. If real usage ever justified going further, the levers — in the order they'd actually get pulled — are: (1) Fargate target-tracking auto-scaling on CPU/memory or ALB request count, since the containers are already stateless and this requires no redesign; (2) Postgres read replicas, since this workload (a CMS-backed content site with a single admin) is overwhelmingly read-heavy; (3) a caching layer (e.g. ElastiCache) in front of the database only if read replicas stop being enough; (4) multi-region, only if the business ever had a genuine reason to need it. None of this is built now because none of it is justified by current traffic — but it's a deliberate next-steps list, not an unaddressed dead end.

---

## 12. Roadmap (implementation slices)

Each phase below is implemented, then manually and automatically tested end-to-end, then signed off, before the next phase starts — per the project's working agreement.

| Phase | Deliverable | Exit criteria |
|---|---|---|
| 0 | ✅ **Done** (2026-07-04) — Repo scaffolding: Next.js + Payload skeleton, local Postgres, SST project skeleton, CI pipeline skeleton, Neon project provisioned | App boots locally **and** on a deployed Lambda staging stack, with working admin auth (create/delete users) and working media upload/delete through S3 — a materially stronger bar than the original "placeholder page" wording, met along the way while resolving the spike (Section 13). ~~One known gap carried into Phase 1: no automated test covers the upload/delete flow yet.~~ **Closed** (2026-07-04, same-day follow-up slice): `tests/int/media.int.spec.ts` now exercises real upload + delete against an S3Mock service container (CI) / local Docker container (dev), verified by direct S3 `HeadObjectCommand` calls, not just Payload's own DB state. See `docs/PROGRESS.md` for the full account, including three real bugs this slice surfaced and fixed (a test-parallelism race against the shared ephemeral Postgres, a config-drift bug producing an opaque S3 SDK error, and an S3Mock CORS limitation that broke browser-based admin uploads specifically). |
| 1 | Content model + admin auth | All Payload collections defined; login + TOTP 2FA working; default Payload admin UI usable for CRUD |
| 2 | Public site wired to real content | Home/Projects/About/Careers/Service pages render real CMS data via ISR, replacing all static prototype content; URL-based i18n live (EN complete, FR/DE stubbed); Legal Notice & Privacy Policy pages built (may stay in Draft pending real legal details); cookie-free analytics live; SEO basics (Section 6.11) and a keyboard/screen-reader pass (Section 7B) done on every public page shipped |
| 3 | Calculator field builder + formula engine | Admin can define fields/formula visually; public calculator computes in real time from the stored formula, replacing the prototype's hardcoded JS math |
| 4 | PDF generation + email delivery | Download and send-to-email both produce a correct branded PDF; failure path tested |
| 5 | Translation pipeline | DeepL auto-translation on save, manual override UI, stale-flagging on source edits; FR/DE live sitewide |
| 6 | Contact form + spam protection | Form submits via SES, Turnstile + honeypot verified, rate limiting confirmed; **hard gate**: `LegalInfo` populated with real registration details and published before this phase can go to production |
| 7 | Hardening & Well-Architected pass | WAF/GuardDuty evaluated against real traffic, backups verified, monitoring/alarms in place, full-site WCAG 2.1 AA and Lighthouse/SEO audit completed (Sections 6.11/7B), this document updated to reflect final state |

---

## 13. Open risks & assumptions to validate early

- ~~Payload 3's "runs inside Next.js" model is proven on Vercel; running it via OpenNext on Lambda is architecturally equivalent but should be spiked in Phase 0 before other work depends on it.~~ **Resolved in Phase 0.** It works, but not out of the box — five real, non-obvious issues had to be fixed before it did, all now handled and documented in `docs/PROGRESS.md`: (1) OpenNext's build tracing copies externalized packages (`pg`, `pino`) into the Lambda bundle via symlinks, which Windows can't reliably produce as real Linux symlinks — builds must happen on Linux (CI), never locally on Windows. (2) `sharp` is excluded from the main server bundle by OpenNext by default and also ships architecture-specific binaries that don't cross-compile between an x64 CI runner and an arm64 Lambda — omitted entirely for now since nothing in the current Media collection uses it. (3) Payload's `admin/importMap.js` is generated, not static, and must be regenerated (`npm run generate:importmap`) whenever a collection, field, or plugin that contributes admin UI changes — silently stale otherwise, with no build-time error. (4) Media uploads need an explicit storage adapter (`@payloadcms/storage-s3`); SST linking a bucket only wires IAM permissions, it doesn't make Payload use it. (5) IAM's `aws:RequestedRegion` condition key doesn't meaningfully scope global services (CloudFront, IAM, Route 53) — a region-conditioned Allow silently doesn't cover them.
- Payload's package size + Chromium in the same Lambda function is why PDF generation is split into its own function — this isolation should be confirmed working in Phase 4, not assumed.
- Exact SST component for ECS Fargate services (Phase B) should be confirmed against current SST documentation when Phase B planning starts, rather than assumed now — also evaluate ECS Express Mode (Section 3) at that time.
- **New, discovered in Phase 0**: the GitHub Actions staging-deploy IAM role currently uses a broad, region-scoped Allow (plus an explicit Deny on the highest-risk IAM/org/billing actions) rather than a hand-enumerated least-privilege policy — a deliberate, documented trade-off (see `infra/aws/README.md`), not an oversight. Follow-up before this pattern is reused for a `production` role: run IAM Access Analyzer against staging's CloudTrail activity and replace the broad statement with the generated policy.
- ~~New, discovered in Phase 0: no automated test exercises the media upload/delete flow (only manually verified). Adding coverage needs either real AWS credentials in the CI `verify` job or a MinIO/LocalStack service container (matching the existing ephemeral-Postgres pattern).~~ **Resolved** (2026-07-04). Neither MinIO nor LocalStack turned out to be viable by the time this was picked up: MinIO discontinued free Community Edition Docker images in Oct 2025 and archived the repo entirely by Apr 2026; LocalStack ended its Community Edition in Mar 2026 and gates S3 behind an account whose free "Hobby" tier's terms prohibit commercial use (this is a commercial site). Used **Adobe's S3Mock** instead — Apache-2.0, actively released (5.1.0 as of last month), purpose-built for exactly this test scenario with no commercial pressure to erode it. Full details, including the three real bugs this surfaced (not just the intended test-coverage addition), are in `docs/PROGRESS.md`.
- **Outstanding client input, tracked as a launch blocker, not a spec gap**: the company's real registered legal form, RCS Luxembourg number, VAT number, and registered office address are still needed to populate `LegalInfo` (Section 5) before Phase 6 can ship to production (Section 6.9).
