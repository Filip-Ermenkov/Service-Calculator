# Technical Specification — bulbau.lu

> **Status**: Living document. This is the technical plan for the entire application. Every implementation slice must be checked against this document before work starts, and this document must be amended once a slice is built, tested, and signed off — before the next slice begins. If reality and this document diverge, this document loses, and gets updated.
>
> **Companion document**: `docs/FUNCTIONALITY.md` (non-technical functional spec — the "what"). This document is the "how."
>
> **Progress**: Phase 0 (Section 12) signed off 2026-07-04. **Phase 1 is complete, committed, and live on staging** — mandatory TOTP 2FA plus the full content model (all collections + globals, EN/FR/DE localization, draft/publish, access control, the LegalInfo publish gate). The one blocker it surfaced — no DB-migration step on deploy — was closed by the **migrations workflow (§10.5), adopted 2026-07-07 and verified live on staging 2026-07-08**: an initial full-schema migration is committed (`src/migrations/`), CI runs `payload migrate` (Neon direct/unpooled URL) before `sst deploy`, the staging Neon branch is baselined and tracking migrations, and the previously-missing 2FA runtime secrets are wired into `sst.config.ts`. **Phase 2 part 1 (public site foundation) is complete and live on staging (verified 2026-07-17)** — next-intl URL-based i18n (`/en|/fr|/de`), a CMS-driven shell, and Home/Service/Projects/About/Careers/Legal/Privacy pages rendering real content via ISR + on-demand revalidation, with SEO and an accessibility baseline. **Phase 2 part 2 (interactive + schema evolution) is also complete and live on staging (verified 2026-07-17)** — clean service **slugs** (`/services/[slug]`), the §7 **service-label snapshot** on Projects (retained after the service is deleted — the migrations workflow's first real use "in anger"), the **Projects client-side search + category filter**, and the sitewide default disclaimer confirmed. **The Lighthouse CI + axe-core audit gates (§6.11/§7B) are now built and green in CI (2026-07-18)** — an axe WCAG 2.2 AA hard gate in the e2e suite (which caught and fixed real contrast + missing-title debt) plus calibrated Lighthouse hard gates. **Phase 2 part 2 is now complete**: web analytics was evaluated and **deliberately left out of scope (2026-07-18, §6.10)** — it is an owner-facing measurement nicety, not a technical or SEO requirement, and its absence keeps the cookieless/no-banner posture with zero added subscription or service. **Phase 3 is complete.** Part 1 (the public live price calculator + shared evaluator) shipped to `main` via PR #23 (`ab8155e`) — the static Phase 2 calculator preview is replaced by a real-time estimator computing prices from the stored formula via a pure, framework-free evaluator (`src/lib/pricing/`) reused verbatim server-side and in the Phase 4 PDF. The evaluator uses **standard JSONLogic as the stored format but a zero-dependency in-house arithmetic-subset interpreter** (not `json-logic-js`, which is unmaintained — see §6.3/§6.4). **Part 2 (the admin visual Formula Builder) is built and verified 2026-07-20** — a custom Payload field component (`src/components/admin/FormulaBuilder.tsx` + pure `src/lib/pricing/formulaBuilder.ts`) that authors the `formula` as structured field-terms / fixed costs / groupings / percentage adjustments, compiling to (and parsing back from) that same JSONLogic, with a raw-JSON fallback and a live preview calling the same `computePrice()` (§6.4). **Phase 4 part 1 (PDF quote generation + Download) is built and verified 2026-07-20** through the automated suite + a local HTML-preview pass — a public "Download PDF quote" action posts inputs to a new `/api/quote` route that re-prices authoritatively (reusing `src/lib/pricing/` verbatim), assembles a branded trilingual quote as HTML, and hands it to a **separate isolated x86_64 PDF Lambda** (`puppeteer-core` + full `@sparticuz/chromium`, **not** the originally-named Playwright + `-min` — see §3/§6.5) that renders it to PDF and streams it back, never persisted (§6.5). The real Chromium-on-Lambda render is **now live on staging** — the deploy-role IAM fix it needed (`ManageAppIamRoles`, see `infra/aws/README.md`) was applied 2026-07-21. **The CI audit gates now also cover the service-detail template** (`/services/[slug]`) via a seeded sample service (`npm run seed:ci`, guarded by `ALLOW_CONTENT_SEED`), closing the last carried axe/Lighthouse coverage gap (§6.11/§7B). **A CI schema-drift guard (2026-07-21, §10.5) now fails the `verify` job if a Payload schema change isn't captured by a committed migration** — closing the migration-safety hole where the `push`-on `verify` job would pass on an un-migrated change that the migrations-only staging deploy then never applies. **A CI generated-artifact drift guard (2026-07-21, §10.5) is its sibling** — the `verify` job regenerates `src/payload-types.ts` + `admin/importMap.js` and fails on any diff, so stale types or a stale import map (a runtime-only admin breakage with no build error) can't reach a deploy. **HTTP security response headers (2026-07-21, §7) now ship on every route** — an OWASP-aligned set (HSTS/`nosniff`/`Referrer-Policy`/`X-Frame-Options`/`Permissions-Policy` + a nonce-free enforce-safe CSP) served via `next.config.ts`'s `headers()` from a single-source-of-truth module, closing a real Security-pillar gap the app previously had (it served none); the full nonce-based `script-src`/`style-src` CSP is a report-only-first Phase 7 follow-up. **Send-to-Email is Phase 4 part 2**, gated on a verified SES identity ⇒ the `bulbau.lu` domain. See `docs/PROGRESS.md` for the full build/debug history and current handoff state — this document reflects the *plan as corrected by what each phase actually required*; that file explains *how it got there*.

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
| PDF generation | **`puppeteer-core` + the full `@sparticuz/chromium`**, in its own isolated **x86_64** Lambda function (built Phase 4 part 1, 2026-07-20) | On-demand, rarely invoked, pay-per-call — a textbook serverless workload, isolated from the main app function to keep the Chromium binary out of the hot-path bundle. **Divergence from the original "Playwright + `@sparticuz/chromium-min`", corrected here:** the npm `@sparticuz/chromium` ships **x64 binaries only** (arm64 needs `-min` + a self-hosted remote pack tar downloaded at cold start — more moving parts), so the function is **x86_64 with the binary bundled** (self-contained; nothing fetched at runtime) while the main `Web` function stays arm64 (they're isolated, so the mismatch is irrelevant). `puppeteer-core` is the pairing `@sparticuz/chromium`'s own docs target. The function is a **dumb HTML→PDF renderer with no Payload and no DB** — the app assembles the quote HTML and passes it in. See §6.5. |
| Formula/pricing engine | **Standard JSONLogic as the stored format, evaluated by a zero-dependency in-house arithmetic-subset interpreter** (`src/lib/pricing/`) — Phase 3 part 1, built 2026-07-19 | Never `eval()`/`new Function()` on admin-authored input. Same evaluator runs both server-side (validation, PDF) and client-side (real-time recalculation), so they can't drift apart. **Decision (2026-07-19):** the originally-named `json-logic-js` is now effectively unmaintained (no release in 12+ months); rather than adopt it or its maintained successor `json-logic-engine` (a general rules engine — more supply-chain surface than a closed money-math domain needs), the format stays standard JSONLogic while evaluation is a ~50-line dependency-free interpreter (`var`, `+ − × ÷`, `min`/`max`). Zero `npm audit` surface, full control over the div-by-zero / non-finite / §7 non-positive edge cases, and a drop-in swap to `json-logic-engine` later with no data migration. See §6.3/§6.4 and `docs/PROGRESS.md`. |
| Translation | DeepL API (Free tier initially) | Measurably better quality than Google/AWS Translate specifically for FR/DE, the two languages this entire site depends on. Free tier (500k characters/month) comfortably covers this site's content volume. |
| Transactional email | AWS SES | Contact form relay, quote-by-email delivery, password reset emails. Requires SPF/DKIM/DMARC setup on the bulbau.lu domain. |
| Background/async jobs | Payload's built-in Jobs Queue, triggered by an SST scheduled (cron) Lambda | Covers translation regeneration and email retries without standing up a separate queue service. |
| Rate limiting / lockout counters | Upstash Redis (serverless, pay-per-request, REST-friendly) | Needed for login lockout, the public `/api/quote` PDF endpoint (10 / min / IP — see §6.5/§7), and contact-form throttling; a persistent ElastiCache node would be an always-on cost that contradicts the serverless-first phase. The shared limiter lives in `src/lib/rateLimit.ts` (Upstash-or-in-memory sliding window; the TOTP limiter is a thin policy wrapper over it). |
| Spam protection | Cloudflare Turnstile + honeypot field | Turnstile is usable standalone (no need to move DNS/CDN to Cloudflare) and is free. |
| Secrets | SSM Parameter Store (free) for static config; Secrets Manager only for the DB credential that benefits from rotation | Keeps recurring cost near zero without giving up rotation where it matters. |
| CDN / edge | CloudFront | Fronts both the Lambda app and S3 media/static assets; carries AWS Shield Standard (free) DDoS protection by default. |
| DNS | Route 53 (hosted zone; domain registration for `.lu` stays with a Luxembourg-accredited registrar, delegated via NS records) | Route 53 Domains does not sell `.lu` TLDs. |
| AWS region | `eu-central-1` (Frankfurt), not `us-east-1` | This is a Luxembourg business serving EU visitors; EU data residency is the expected default for GDPR purposes even though it isn't always a strict legal mandate. Frankfurt over Dublin (`eu-west-1`) specifically for lower latency from Luxembourg. Cost figures in Section 9 re-verified against `eu-central-1` pricing at Phase 0 sign-off (2026-07-04) — see Section 9's note. |
| Analytics | **None — deliberately out of scope** (§6.10, decided 2026-07-18) | Web analytics is an owner-facing measurement nicety, not a technical/SEO/legal requirement; omitting it avoids a recurring subscription or an always-on service and keeps the cookieless/no-banner posture. If ever wanted, add a cookieless tool (self-hosted Umami, or a client-owned Plausible account) as a small slice — never Google Analytics, which sets tracking cookies and would force a consent banner. |
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
│   │   ├── [locale]/            # Public site (Phase 2) — localized root layout
│   │   │                        # (<html lang>), pages, globals.css. Top-level
│   │   │                        # segment (not nested in a group) so it's a valid
│   │   │                        # root layout per Next's multiple-root rule.
│   │   ├── (frontend)/          # Repurposed: now ONLY the `/ → /<locale>` redirect
│   │   │                        # (the Phase 0 placeholder, un-deletable on the
│   │   │                        # mount, turned into a minimal redirect shell)
│   │   ├── sitemap.ts, robots.ts # Localized sitemap + robots (Phase 2, §6.11)
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

> **Status (2026-07-06) — built and sandbox-tested (Phase 1, part 2).** `Services`, `Projects`, `CareerListings`, `CompanyInfo`, and `LegalInfo` are implemented with EN/FR/DE localization, draft/publish (`versions.drafts`), public-read-only-published access control, and the LegalInfo publish gate (Section 6.9). Deliberate deviations, all recorded in `docs/PROGRESS.md`:
> - **`Translations` is deferred to Phase 5.** With native localization, translated values live inside each field's per-locale data; the `Translations` "shadow" collection is a *management surface* over those values and is inseparable from the DeepL pipeline and the custom Translation Management admin view — both Phase 5. Building the empty shadow now would be dead scaffolding.
> - **`CareerListings` uses an explicit `status` (active/archived) select, not drafts** — `FUNCTIONALITY.md` §5.5 models it as a visibility toggle (Archive/Restore), not a draft→publish authoring workflow, and it needs no version history.
> - **Drag ordering uses Payload's built-in `orderable: true`** (fractional indexing) on `Services`/`CareerListings`, the current best-practice replacement for a hand-rolled integer `order` field.
> - `Services.calculatorFields`/`formula` are defined as **data only**; the visual Formula/Field Builder over them is Phase 3 (Section 6.4). ~~`Projects.service` is a plain relationship; the §7 "retain the label after the service is deleted" behaviour is a Phase 2 concern (a denormalized snapshot).~~ **Done in Phase 2 part 2 (2026-07-17):** `Projects.serviceName` is a denormalized, non-localized snapshot of the linked service's default-locale title, kept in sync by a `beforeChange` hook and retained verbatim after the service is deleted (the projects→services FK is `ON DELETE set null`). `Services.slug` (unique, auto-from-title, non-localized) was also added this slice for clean `/services/[slug]` URLs. Both landed via the initial "migration in anger" (`20260717_164130_phase2b_slug_service_snapshot`).

---

## 6. Feature implementation plan

### 6.1 Global behaviour (language, responsive, header/footer)
`next-intl` middleware resolves `/en`, `/fr`, `/de` prefixes; initial visit is redirected based on `Accept-Language`, then the choice is persisted in the URL (not just a cookie) for indexability. Header/footer are shared layout components pulling contact details from the `CompanyInfo` singleton, so a single edit propagates everywhere per the requirement in `FUNCTIONALITY.md` §5.6.

> **✅ Built in Phase 2 part 1 (2026-07-17).** next-intl v4 with `localePrefix: 'always'`; the middleware lives in `src/proxy.ts`, **composed** with the pre-existing TOTP admin gate by path (`/admin/*` → gate, else → i18n). The localized site is a top-level `src/app/[locale]/` root layout. **Divergence from the plan, corrected here:** responsive layout is **not** Tailwind — the approved prototype was authored in hand-written CSS, so its design system was ported verbatim into `src/app/[locale]/globals.css` (lower-risk than re-expressing it as Tailwind utilities, and pixel-faithful to the sign-off). Fonts self-hosted via `next/font`. UI chrome is fully trilingual now (`src/i18n/messages/`); CMS content falls back to EN until Phase 5.

### 6.2 Public pages (Home, Projects, About, Careers)
Rendered with Next.js static generation + on-demand revalidation (ISR), invalidated via a Payload `afterChange` hook that calls Next.js's on-demand revalidation API whenever content is published. This means most public traffic is served from CloudFront's cache and never invokes the Lambda function at all — which is both fast and keeps Lambda invocation counts (and cost) low. Projects page search/filter runs client-side against a small pre-fetched dataset (this site's project count doesn't justify a search backend).

> **✅ Built in Phase 2 part 1 (2026-07-17)**, with two notes. (1) Revalidation is `revalidatePath('/', 'layout')` + per-locale from `afterChange`/`afterDelete` hooks (`src/lib/revalidate.ts`), **double-guarded** (`context.disableRevalidate` + try/catch) so it can never break an admin save/test/migration; time-based `revalidate = 300` is the safety net. Confirmed working on Lambda on staging. Data reads use Payload's Local API with `overrideAccess: false` (`src/lib/content.ts`), reusing the tested published-only access policy. (2) ~~Service detail URLs are **ID-based** (`/services/[id]`) this slice — clean slugs are Phase 2 part 2. The **Projects client-side search/filter is Phase 2 part 2** (the grid renders server-side now).~~ **Both done in Phase 2 part 2 (2026-07-17):** service URLs are now clean **slugs** (`/services/[slug]`, `src/lib/slug.ts` + `getServiceBySlug`), and the **Projects search + category filter** is a client component (`src/components/site/ProjectsBrowser.tsx`) over the server-pre-fetched list, with the pure matching logic in `src/lib/projects.ts`. The server still renders the grid (progressive enhancement / crawlability), the client filters it instantly. The filter categories are derived from the projects themselves — so a deleted service's category only stays a filter option while projects still carry its snapshotted label (§7).

### 6.3 Service page & real-time calculator
Each service's `calculatorFields` + `formula` are fetched once per page load. The formula is evaluated client-side with the same evaluator used server-side, so the live price updates on every change with no round trip, matching `FUNCTIONALITY.md` §3.3. The zero/negative-result edge case (§7) is handled inside the evaluator wrapper: any non-positive result renders "Contact us for a price" instead of a number, on both the web page and the PDF.

> **✅ Built in Phase 3 part 1 (2026-07-19).** The shared evaluator is `src/lib/pricing/` — a pure, framework-free module (`computePrice`, `evaluateJsonLogic`, `formatCurrency`, input coercion, line-item contributions) with **zero dependencies**, so it runs identically on the client (`ServiceCalculator.tsx`), on the server, and (Phase 4) in the PDF Lambda — the on-screen price can't drift from the quote. The stored `formula` is **standard JSONLogic**; the interpreter supports the arithmetic subset a pricing engine needs (`var`, `+ − × ÷`, `min`/`max`, nesting for order-of-operations) and treats any unsupported/malformed rule as "can't price it → Contact us". `json-logic-js` was **not** adopted (unmaintained); the format is library-agnostic so a maintained engine (`json-logic-engine`) can drop in later with no data migration. **Default path** (no formula) = Σ signed `unitPrice × value`; a custom formula, when present, is authoritative over raw field values (fixed costs / %-adjustments / groupings). The public total is **gated on required fields** (an explicit 0 counts as filled), with hard/blocking validation deferred to PDF generation (Phase 4). EUR is `Intl.NumberFormat`-formatted per locale. Full detail + the engine-decision rationale in `docs/PROGRESS.md` (Phase 3 part 1).

### 6.4 Calculator Field Builder & Formula Builder (admin) — Phase 3 **part 2** (built 2026-07-20)
Built as a custom Payload field component (React, mounted in the `Services` collection edit view):
- Field list editor: label, type (number/dropdown/toggle), options, multiplier, sign (+/−), required flag, drag-to-reorder.
- Formula builder: a structured (not free-text) UI for grouping fields, fixed costs, and percentage adjustments, serialized to a JSONLogic AST — never a string of executable code.
- Live preview panel evaluates the in-progress formula against sample values using the exact same evaluator the public page uses, so what the admin sees in preview is guaranteed to match production behaviour.

> **✅ Built in Phase 3 part 2 (2026-07-20).** The **Calculator Field Builder** requirement is met by the native Payload `calculatorFields` array (label / type / options / unit price / sign / required / drag-reorder — all first-class field types, no custom code needed). The genuinely novel piece — the **Formula Builder** — is a custom client field component on the `Services.formula` field (`src/components/admin/FormulaBuilder.tsx`) with a pure, unit-tested compiler/parser core (`src/lib/pricing/formulaBuilder.ts`). It offers a structured, non-code UI (field terms `field × multiplier ±`, fixed costs, one-level groupings `(A + B) × C`, and percentage adjustments like +10 % VAT) that **compiles to the exact JSONLogic** `src/lib/pricing/` already evaluates, and **parses that JSONLogic back** so an existing formula re-opens in the builder losslessly. Anything hand-authored outside the builder's canonical shape (e.g. `min`/`max`) is detected and shown in a **raw-JSON fallback editor** — nothing is locked out. The **live preview** calls the very same `computePrice()` the public page uses and now mirrors the public **required-field gating** exactly (preview == production, by construction). The stored value stays plain JSONLogic, so the public calculator, evaluator and Phase 4 PDF are untouched and the slice is **migration-free**. Full build/verify/issue history in `docs/PROGRESS.md` (Phase 3 part 2). **Phase 3 is complete; Phase 4 part 1 (PDF Download) is built — see §6.5.**

### 6.5 PDF quote generation & delivery
A dedicated Lambda function renders an HTML/CSS quote template — reusing the same design system as the site — to PDF, on demand, never persisted to storage. Invoked either for direct download (returned inline) or piped into an SES `SendRawEmail` call for the "send to email" path. Failure to send (invalid address, SES bounce) surfaces a clear error with a fallback offer to download instead, per `FUNCTIONALITY.md` §7.

> **✅ Part 1 (generation + Download) built in Phase 4 part 1 (2026-07-20); Send-to-Email is part 2.** The isolated renderer is `src/functions/pdf/handler.ts` — a stateless, DB-less **`puppeteer-core` + full `@sparticuz/chromium`** function on **x86_64** (see §3 for the architecture/`-min` divergence). The main app does everything else: `POST /api/quote` (`src/app/api/quote/route.ts`, outside the `[locale]` segment so next-intl/admin middleware skip it) re-loads the **authoritative** published service via the access-gated data layer (client price data never trusted), builds a presentation-ready model with **`src/lib/pdf/quote.ts`** (calling the same `computePrice()` the page uses — the PDF total can't drift from the estimate, and the §7 non-positive / required-blank case renders "Contact us for a price"), renders self-contained branded HTML with **`src/lib/pdf/template.ts`** (all CSS inlined, only Chromium's bundled Open Sans, every value HTML-escaped — no network dependency at render), and invokes the Lambda via **`src/lib/pdf/render.ts`** (`@aws-sdk/client-lambda`; the invoke permission comes from `link`-ing the `Pdf` function to `Web` in `sst.config.ts`, its name passed as `PDF_FUNCTION_NAME`). With no PDF backend (local dev / CI) the route serves the HTML for preview instead. The public **"Download PDF quote"** button lives in `ServiceCalculator.tsx` (available regardless of field completeness, §3.3), trilingual (new `Quote` message namespace). Because each call re-loads the service from Neon **and** invokes the 1600 MB Chromium Lambda, the route is **rate-limited (10 / min / IP) and payload-capped** (a `Content-Length`/field-count guard) — an unauthenticated, expensive resource had no throttle before (added 2026-07-22, §7; the limiter reuses the shared Upstash-backed `src/lib/rateLimit.ts`, keyed by a CloudFront-aware, spoof-resistant client IP). A rate-limited caller gets `429` + `Retry-After` **before** any DB/Lambda work; the button surfaces a distinct localized "too many quotes" message. **Verified** via the automated suite (incl. 7 new pure PDF tests) + a local HTML-preview manual pass; the **real Chromium-on-Lambda render is confirmed on the staging deploy**, which is gated on a deploy-role IAM fix (SST's new `Pdf` function needs `iam:CreateRole` — `ManageAppIamRoles` in `infra/aws/`). **Part 2 (Send-to-Email)** adds the SES `SendRawEmail` path (PDF as attachment + localized body, §7 send-failure → download fallback), reusing `src/lib/pdf/` verbatim — **gated on a verified SES identity ⇒ the `bulbau.lu` domain**. Full detail in `docs/PROGRESS.md` (Phase 4 part 1).

### 6.6 Admin panel & authentication
Payload's admin UI is used as-is for Projects, Careers, and CompanyInfo (no custom UI needed there — this is exactly what "off-the-shelf CMS admin" is good at). Translation Management gets a custom admin view instead (Section 6.7), since it needs cross-collection search and override/review state that default CRUD screens don't provide. Login flow: Payload's native email/password check, then a second TOTP step (`otplib`, secret provisioned via a QR code shown once at setup, matching `FUNCTIONALITY.md` §5.1/§5.8). Failed attempts are counted in Upstash Redis with a temporary lockout; password reset uses Payload's built-in signed-token flow, emailed via SES, expiring after one hour.

### 6.7 Translation management & lifecycle
On save of any localized field, a Payload hook computes a hash of the English source and enqueues a Jobs Queue task (processed by a scheduled Lambda) that calls the DeepL API for FR and DE if no manual override exists, or flags `needsReview: true` if an override exists and the source hash changed. The Translation Management screen (custom Payload admin view) lists every translatable string, its auto-translation, any override, and review status, matching `FUNCTIONALITY.md` §5.7 exactly.

### 6.8 Contact form & spam protection
Standard form submission → SES relay to the address configured in `CompanyInfo`, protected by Cloudflare Turnstile plus a honeypot field as a no-JS fallback. Same Upstash Redis-backed throttling as login, keyed by IP, to prevent abuse without needing a paid WAF from day one.

### 6.9 Legal Notice & Privacy Policy pages
Rendered the same way as the About Us page — localized rich text from a Payload global (`LegalInfo`), linked from the footer on every page (`FUNCTIONALITY.md` §2.5). A Payload validation hook prevents `LegalInfo.status` from being set to `published` unless `legalName`, `legalForm`, `rcsNumber`, `vatNumber`, and `registeredAddress` are all populated — this is a deliberate technical safeguard against the page ever going live with placeholder or invented legal details. Until the client provides the real registration details, the page either doesn't render publicly or renders clearly marked as a draft, and this blocks production sign-off for Phase 6 (contact form) regardless of whether the rest of that phase is otherwise complete.

> **✅ Built in Phase 2 part 1 (2026-07-17).** `/legal` and `/privacy` render from the `LegalInfo` global, gated on `_status === 'published'` **and** `findMissingLegalFields(...)` being empty (the same checker the publish hook enforces with — reused, not reimplemented). When unpublished/incomplete they show a "not yet available" state; `findGlobal` returns published-only data to the public, so a draft's contents never leak. Footer links to both on every page.

### 6.10 Analytics — deliberately out of scope
**Decision (2026-07-18): the site ships with no web analytics.** Analytics serves the *site owner* (traffic volume, referral sources, which pages get attention) — it is not a technical requirement, does nothing for SEO (a private measurement layer Google never sees; if anything one fewer third-party script is marginally faster), and its absence removes a recurring subscription (Plausible Cloud) or an always-on self-hosted service for no launch-critical benefit. An earlier plan to add Plausible was evaluated and reversed after weighing it against the project's actual priorities (SEO/web visibility) and its "periodic maintenance only" goal.

The privacy posture is *unchanged and lean*: with no analytics, the only cookie anywhere is the strictly-functional language preference, so there is still **no cookie-consent banner** (correct, not a compromise — nothing non-functional to consent to).

**If a site owner later wants visitor stats**, add a cookieless tool as a small dedicated slice: self-hosted **Umami** colocated in the SST stack (no subscription; tears down with `sst remove`), or a **client-owned Plausible account** (the billing risk sits with the client, not the operator). The integration point is a single script tag behind one env flag — trivial to add on demand.

### 6.11 SEO implementation
The architecture is SEO-friendly by design (SSR/ISR instead of client-only rendering, URL-based locales with hreflang — Section 3), but that's the foundation, not the whole job. Built explicitly, per page:
- Per-page `<title>`/meta description generated from each collection's existing title/description fields (no new content-authoring burden on the admin).
- Open Graph and Twitter Card tags, using each service/project's existing hero image.
- Structured data (schema.org `LocalBusiness` on Home/About, `Service` on each service page), generated from data already in `CompanyInfo`/`Services` — no separate content to maintain.
- A generated, localized XML sitemap and `robots.txt` (Next.js's built-in `sitemap.ts`/`robots.ts` conventions).
- Canonical URLs per locale, with `hreflang` alternates pointing at the `/en`, `/fr`, `/de` versions of each page.
- Required alt text on every `Media` upload (Section 5) — both an accessibility requirement (Section 7B) and an SEO one.
- A Core Web Vitals budget enforced in CI (Lighthouse CI against the staging deploy) rather than left to chance.

> **✅ Mostly built in Phase 2 part 1 (2026-07-17).** Per-page `generateMetadata` (title/description/canonical/`hreflang` incl. `x-default`/Open Graph), `LocalBusiness` (Home) + `Service` (service pages) JSON-LD, and localized `sitemap.ts`/`robots.ts` are all in (`src/lib/seo.ts`, `src/app/{sitemap,robots}.ts`). **Indexing is an explicit opt-in** (`NEXT_PUBLIC_ALLOW_INDEXING === 'true'`, prod-only) — safer than a hostname check given the dynamic CloudFront staging URL. **Lighthouse CI budget now built (2026-07-18):** `lighthouserc.cjs` + a `Lighthouse CI` step in `ci.yml`'s `verify` job audit a production build across 4 URLs × 3 runs. Accessibility, best-practices, and performance are **hard gates** (calibrated to the first CI baseline: ≥0.9 / ≥0.9 / ≥0.8, all proven 12/12); Core Web Vitals are tracked WARNs. **SEO is a WARN — but the real audits under it are now fixed and gated (pre-launch SEO + mobile-legibility polish, 2026-07-21).** Every page now emits a non-empty **localized** `meta-description` (CMS excerpt where available, else a localized static fallback — this closed the `/legal`/`/privacy`/empty-`/about`/`/services/[slug]` gaps), and no public text renders below **12px** (all sub-12px labels raised to `0.75rem`). Both are now **hard `error` gates** in `lighthouserc.cjs` (`meta-description`, `font-size`) and passed **12/12** in CI. The `tap-targets` audit was **removed by Lighthouse 12**, so it is no longer asserted; target size is instead handled by a **44px touch target** on the compact language switcher / mobile menu button (clears WCAG 2.2 SC 2.5.8's 24px AA minimum) and covered by the **axe-core WCAG gate**. So the composite `categories:seo` WARN (~0.58) is now attributable **only** to the intentional `noindex` (`is-crawlable` turned off) — enabling indexing at launch is expected to lift it to ≥0.9, at which point it becomes a **hard gate** (a Phase 7 launch step). **Coverage extended (2026-07-21):** the Lighthouse URL set now includes `/services/ci-sample-service` (the service-detail template), audited against a CI-seeded sample service (`npm run seed:ci`) — the `meta-description` and `font-size` hard gates now hold on that template too. **Still a perf item:** switching CMS `<img>` to `next/image` (the `next.config.ts` `localPatterns` groundwork is already in place); tighten the performance floor once that lands.

---

## 7. Security baseline (applies regardless of hosting tier)

- Passwords hashed with a modern algorithm (Payload default, verified to be argon2id-equivalent strength); TOTP secrets encrypted at rest.
- All traffic TLS-only (CloudFront enforces HTTPS; HTTP redirects).
- **HTTP security response headers (built 2026-07-21).** An OWASP-aligned header set is served on **every** route (`next.config.ts`'s `headers()` over `/:path*`, from the single-source-of-truth module `src/lib/security/headers.ts`): `Strict-Transport-Security` (2-year `max-age`, `includeSubDomains`; `preload` deliberately withheld until the real `bulbau.lu` custom domain, since a shared `*.cloudfront.net` host cannot be preloaded), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: SAMEORIGIN`, `X-XSS-Protection: 0` (OWASP: disable the legacy auditor, rely on CSP), `X-Permitted-Cross-Domain-Policies: none`, `Cross-Origin-Opener-Policy: same-origin`, a restrictive `Permissions-Policy` (camera/microphone/geolocation/payment/USB/etc. disabled), and a **Content-Security-Policy limited to the nonce-free, enforce-safe directives** — `base-uri 'self'`, `object-src 'none'`, `frame-ancestors 'self'`, `form-action 'self'` (no `default-src`/`script-src`/`style-src`, so inline scripts/styles in the Payload admin and the Next app are not broken). A full XSS-grade `script-src`/`style-src` CSP needs per-request nonces threaded through the response (Next's `proxy.ts` nonce pattern) and can silently break the admin at runtime with no build error, so it is a deliberately separate, **report-only-first, staging-verifiable** follow-up (Phase 7). Covered by `tests/int/securityHeaders.int.spec.ts` (the exact set/values) and `tests/e2e/securityHeaders.e2e.spec.ts` (the running server actually emits them on a public page, `/admin/login`, and `/api/quote`).
- **Public `/api/quote` rate limit + payload cap (built 2026-07-22).** The one public unauthenticated endpoint that triggers *expensive* work — a Neon read **and** a 1600 MB Chromium Lambda invocation per call — is throttled to **10 requests / minute / IP** (Security + Cost-Optimization + Reliability pillars: a scripted loop could otherwise run up AWS cost or exhaust capacity). Enforced **before** any DB/Lambda work via the shared `src/lib/rateLimit.ts` (the same Upstash-or-in-memory limiter as login, a distinct `bulbau-quote` policy) keyed by a **CloudFront-aware, spoof-resistant client IP** (`getClientIp` prefers CloudFront's own `CloudFront-Viewer-Address` header over the client-spoofable leftmost `X-Forwarded-For`). Also payload-capped — a 16 KB `Content-Length` guard + a 200-field cap — since App Router route handlers can't declaratively bound body size. A blocked caller gets `429` + `Retry-After`; the Download button shows a distinct localized message. Covered by `tests/int/rateLimit.int.spec.ts` (limiter budget/isolation + IP extraction) and a `tests/e2e/frontend.e2e.spec.ts` case (the running route returns `429` after the per-IP budget). *Follow-up:* for full spoof-resistance in production the CloudFront distribution should be configured to forward `CloudFront-Viewer-Address` to the origin (the code degrades gracefully to `X-Forwarded-For` when it isn't).
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
- **Cookie/consent — resolved**: the site runs no web analytics (§6.10), so the only cookie anywhere is the strictly-functional language preference. That requires no consent under GDPR/ePrivacy, so the site ships with **no cookie-consent banner**. (If analytics is ever added, it must be a cookieless tool so this stays true.)
- **DPO — resolved**: this business's data processing (contact-form inquiries only, no large-scale or special-category data) doesn't meet GDPR Article 37's threshold for a mandatory Data Protection Officer. The admin/business owner is listed as the data controller in the Privacy Policy instead.
- **Retention — resolved**: no fixed retention period is specified; the Privacy Policy states messages are kept only as long as needed to respond, then deleted per normal business practice.
- **Legal Notice / Privacy Policy — specified, not yet publishable**: both pages are now fully specified in `FUNCTIONALITY.md` §2.5 and implemented per Section 6.9. They cannot go live with placeholder legal details — the company's registered legal form, RCS Luxembourg number, VAT number, and registered address are still pending from the client and are a hard gate on Phase 6 sign-off, enforced technically (Section 6.9), not just procedurally.

---

## 7B. Accessibility (WCAG 2.1 AA)

Not previously specified anywhere in this document — added on review, not because a client or legal mandate demanded it, but because it's current best practice for any public-facing site and is far cheaper to build in than to retrofit:

- Target WCAG 2.1 AA: semantic HTML landmarks, full keyboard navigation (including the calculator and the admin panel's custom formula-builder component — the easiest place for a custom UI to silently fail this), visible focus states, sufficient color contrast carried over from the already-approved prototype's design, and required alt text on all media (Section 5).
- The EU's Accessibility Act (in force since June 2025) most clearly covers e-commerce; whether a quote-generation (not transactional) site like this falls squarely within its scope is genuinely ambiguous and not worth over-claiming either way — but WCAG 2.1 AA is the right bar regardless of whether it's strictly mandated here.
- Verified with automated tooling (axe-core in CI, similar to the Lighthouse CI check in Section 6.11) plus a manual keyboard-only and screen-reader pass before each phase's sign-off (Section 12), not assumed from automated checks alone — automated tools catch a minority of real accessibility issues.

> **Baseline built in Phase 2 part 1 (2026-07-17).** Public pages: semantic landmarks (`<header>`/`<nav aria-label>`/`<main id="main">`/`<footer>`), a skip-to-content link, visible `:focus-visible` rings, a keyboard-operable mobile menu (`aria-expanded`/`aria-controls`) and language switcher (real anchors, `aria-current`), `lang` set per locale on `<html>`, and required alt text on media. A manual keyboard/contrast pass was done at sign-off. **The automated axe-core CI gate is now built (2026-07-18):** `tests/e2e/accessibility.e2e.spec.ts` runs `@axe-core/playwright` (WCAG 2.2 AA tags) across all six EN pages + the FR/DE homes inside the e2e suite, failing the build on any **serious or critical** violation. Landing it surfaced and fixed real pre-existing debt from the ported prototype design system — a set of `color-contrast` failures (the brand orange `#E05A00`→`#BF4C00`, with `--orange-light` for orange accents on dark sections; muted greys lightened on the dark header/footer/price-box; muted text darkened on pale panels) and a missing `<title>` on the home pages (`pageMetadata` was emitting `title: undefined`, overriding the layout default — fixed to omit the key). **Now exhaustive for the public templates (2026-07-21):** `/services/[slug]` — the live calculator + Download-PDF surface, previously omitted because it 404s on CI's empty DB — is now audited too. The `verify` job seeds one published sample service (`npm run seed:ci`, guarded by `ALLOW_CONTENT_SEED`) before building, so both the axe gate (`tests/e2e/accessibility.e2e.spec.ts`) and Lighthouse cover it, and the calculator/quote e2e tests run against it instead of skipping. Landing it surfaced and fixed two never-audited defects on that page: an inline sub-12px label (`0.7rem`→`0.75rem`) and the required-`*` asterisk's contrast (a higher-specificity `.calc-label span` rule was dropping it to ~2.5:1 grey; scoped back to the intended ~4.9:1 brand orange).

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
1. Lint + typecheck + unit/integration tests on every PR, then a **schema-drift guard** (see §10.5 — `migrate:create --skip-empty`, failing the job if the committed migrations don't capture the current Payload schema) and a **generated-artifact drift guard** (see §10.5 — regenerates `payload-types.ts` + `admin/importMap.js` and fails on any diff, so stale types or a stale import map can't reach a deploy), then (before the production build) a content-seed step (`npm run seed:ci`, `ALLOW_CONTENT_SEED`-guarded) that publishes one sample service into the job's ephemeral Postgres so the `/services/[slug]` audits — axe (§7B) and Lighthouse (§6.11) — and the calculator/quote e2e tests run against a real service instead of skipping on an empty DB. The row persists across the build → Lighthouse → e2e steps in that one job.
2. On merge to `main`: apply DB migrations to staging (`payload migrate`, direct/unpooled Neon URL — Section 10.5) → deploy to staging via `sst deploy --stage staging` → run E2E suite, Lighthouse CI (Section 6.11), and axe-core accessibility checks (Section 7B) against staging → manual approval gate → migrate production → `sst deploy --stage production`.

### 10.3 IaC ownership
- SST (`infra/sst.config.ts`): Lambda functions, CloudFront, S3, Route 53 records, SES identity, Payload's environment wiring — and the Neon project/branches, via SST's ability to consume Terraform/Pulumi providers directly.
- Standalone Terraform: only for anything SST can't model directly, decided case-by-case as the project progresses (kept in `infra/` alongside the SST config, same repo).

### 10.4 Why not CDK
CDK/CloudFormation is AWS-only and cannot declare the Neon database as code, which this project needs from day one. CloudFormation/CDK's automatic rollback-on-failure is a genuine advantage over Terraform's fail-forward model, but it doesn't offset the multi-provider gap, and it isn't foolproof either (a failed rollback can itself get stuck). SST's own engine made the same call — it moved off CDK onto Pulumi/Terraform providers for exactly this reason.

### 10.5 Database schema migrations (adopted 2026-07-07; live on staging 2026-07-08)

Payload's Drizzle Postgres adapter has two schema-management modes; this project uses each where it's correct:

- **`push` (dev + CI tests, `NODE_ENV !== 'production'`)**: schema is auto-synced to the config on boot. The local dev DB and the ephemeral CI Postgres are disposable sandboxes, so no migration run is needed there — this keeps local iteration fast and is Payload's own recommended dev workflow. Set explicitly in `src/payload.config.ts` (`push: process.env.NODE_ENV !== 'production'`) so the boundary is documented, not implicit.
- **Tracked migrations (deployed stages, `NODE_ENV === 'production'`)**: `push` is OFF; schema changes **only** via the SQL migrations in `src/migrations/` (committed, TypeScript, with `up`/`down`). Generated with `npm run migrate:create`, applied with `npm run migrate`.

**Where migrations run: CI, before deploy — not at runtime.** The `deploy-staging` job runs `payload migrate` before `sst deploy`, so the schema is applied once per deploy and is never older than the code that will read it. Payload's `prodMigrations` (run-at-init) option is deliberately **not** used: on Lambda it would run on every cold start and let concurrent cold starts race on DDL — that option is for long-running containers, which is a Phase B consideration, not Phase A. If a migration fails, the job stops and no code is deployed.

**Neon pooled vs. direct.** The app's runtime `DATABASE_URL` is Neon's **pooled** (`-pooler`) URL — correct for many short Lambda connections through PgBouncer. Migrations (DDL) must use the **direct/unpooled** URL instead, because PgBouncer's transaction pooling breaks schema changes; the CI migrate step uses the `STAGING_DATABASE_URL_UNPOOLED` GitHub Environment secret for this.

**Baselining staging (one-time).** Staging's schema was originally created by an initial dev-`push` and has no migration history, so a plain `migrate` would try to recreate existing tables. Because staging holds no real data pre-launch, the clean path is `payload migrate:fresh` against the staging Neon branch **once** (drops + recreates from the migration files); after that, staging tracks migrations normally and every deploy applies only what's pending. Production, when it exists, is migrations-only from day one — never `push`, never `fresh` after launch. **This staging baseline ran on 2026-07-08**; staging now tracks migrations and serves Phase 1.

**CI schema-drift guard (added 2026-07-21).** The `push`-in-dev/CI split above has one sharp edge: because the `verify` job runs with `push` ON, it will happily go green on a schema change whose migration was never generated — and then `deploy-staging`'s migrations-only `payload migrate` applies nothing, shipping code against a schema that was never created on staging. To close that, the `verify` job now runs a drift guard (the CI equivalent of Django's `makemigrations --check`): `payload migrate:create --skip-empty` (which, per the installed Payload 3.86 source, runs with `disableDBConnect: true` — no DB needed, no push — and simply diffs the config schema against the latest committed migration snapshot), failing the build via `git status --porcelain src/migrations` if a migration *would* have been written. A developer who changes a collection/field/global and forgets `npm run migrate:create` is now caught on the PR, not on the deploy. (Note: Payload 3.86 has **no** `--check` flag despite some third-party claims — this was verified against the installed source; the guard uses `--skip-empty` + a git-status check, with `</dev/null` + a `timeout` to neutralize the one interactive edge case, an ambiguous enum/column rename. Full detail in `docs/PROGRESS.md` → "CI schema-drift guard".)

**CI generated-artifact drift guard (added 2026-07-21).** The migration guard's sibling, for Payload's other two generated-but-committed files: `src/payload-types.ts` (`generate:types`) and `src/app/(payload)/admin/importMap.js` (`generate:importmap`). The `verify` job now regenerates both and fails via `git status --porcelain` on those exact paths if either is stale versus the current config. This closes a silent gap already called out in §12: a stale import map has **no build-time error** — the admin panel simply breaks at *runtime* (a custom component such as `FormulaBuilder` or the TOTP views resolves to nothing), and stale types let code compile against a schema that no longer matches. Verified against the installed `payload@3.86` source: both commands run directly on the config **without `getPayload()`**, so neither needs a DB (no push, no Postgres — same as the schema guard), and both are **idempotent when in sync** (they skip writing when the output is byte-identical), so an in-sync tree stays clean with no false positives. Full detail in `docs/PROGRESS.md` → "CI generated-artifact drift guard".

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
| 1 | ✅ **Done and live on staging** (built 2026-07-06; deployed 2026-07-08) — Content model + admin auth | Met: TOTP 2FA + `Services`/`Projects`/`CareerListings` collections + `CompanyInfo`/`LegalInfo` globals with EN/FR/DE localization, draft/publish, access control, and the LegalInfo publish gate; default Payload admin usable for CRUD; int **and** e2e suites green in CI. `Translations` intentionally deferred to Phase 5 (see Section 5 status note). The DB-migrations workflow this phase required (Section 10.5) is adopted, and the staging cutover (baseline + secrets + first migrated deploy) completed 2026-07-08 — staging serves real Phase 1, verified end-to-end (admin + 2FA + CRUD + a migration round-trip). |
| 2a | Public site foundation | ✅ **Done 2026-07-17, live on staging.** next-intl URL-based i18n (`/en|/fr|/de`, EN authoritative, FR/DE fall back to EN until Phase 5; UI chrome fully trilingual); CMS-driven Header/Footer; Home/Service/Projects/About/Careers/Legal/Privacy pages render real CMS data via ISR + on-demand revalidation, replacing the Phase 0 placeholder; SEO basics (§6.11 — metadata/canonical/hreflang/sitemap/robots/JSON-LD, indexing opt-in) and a manual keyboard/contrast pass (§7B) done. Service detail URLs are ID-based this slice. Legal/Privacy render "not yet available" until `LegalInfo` is published (§6.9 gate). Calculator fields render as a static preview (live math = Phase 3) |
| 2b | Public site — interactive + audit | **Partly done 2026-07-17, live on staging** (`8fd1df9`): ✅ Projects client-side search/filter; ✅ the §7 service-label snapshot on delete (first migration "in anger", `20260717_164130`); ✅ clean service slugs (`/services/[slug]`); ✅ sitewide default estimate disclaimer (message-catalog fallback, incl. empty-rich-text fix). ✅ **Lighthouse CI + axe-core accessibility gates (2026-07-18)** — axe WCAG 2.2 AA hard gate in the e2e suite (fixed real contrast + missing-title debt it caught) and Lighthouse CI with calibrated a11y/best-practices/performance hard gates (SEO a by-design WARN until launch). ✅ **Analytics decided out of scope (2026-07-18, §6.10)** — no web analytics; cookieless/no-banner posture retained. **Phase 2b complete.** Carried perf item: CMS `<img>`→`next/image` |
| 3a | Live price calculator + shared evaluator | ✅ **Done — shipped to `main` via PR #23 (`ab8155e`); CI gates + staging deploy ran.** Public calculator computes in **real time** from the stored `formula`, replacing the Phase 2 static preview; pure zero-dependency evaluator `src/lib/pricing/` (standard JSONLogic format, in-house arithmetic interpreter — not the unmaintained `json-logic-js`) shared client/server/PDF; §7 non-positive → "Contact us for a price"; required-field gating; per-locale EUR. `lint`/`typecheck`/`test:int`/`build`/`test:e2e` green + full manual pass. Migration-free. |
| 3b | Calculator field/formula **builder** (admin) | ✅ **Done 2026-07-20.** Fields authored via the native `calculatorFields` array; the **Formula Builder** is a custom client field on `Services.formula` (`src/components/admin/FormulaBuilder.tsx` + pure `src/lib/pricing/formulaBuilder.ts`) — structured field-terms / fixed costs / groupings / % adjustments that compile to (and parse back from) the same JSONLogic `src/lib/pricing/` evaluates, with a raw-JSON fallback and a **live preview** calling the same `computePrice()` (required-field gating mirrored). Migration-free; `lint`/`typecheck`/`test:int`/`build`/`test:e2e` green + full manual pass. |
| 4a | PDF generation + **Download** | ✅ **Built + verified 2026-07-20 (automated suite + local HTML-preview pass).** Isolated x86_64 Chromium PDF Lambda (`src/functions/pdf/handler.ts`, `puppeteer-core` + full `@sparticuz/chromium`) + `POST /api/quote` route reusing `src/lib/pricing/` verbatim (branded, trilingual, §7 contact state, never persisted); a public "Download PDF quote" button. `lint`/`typecheck`/`test:int` (7 new PDF tests)/`build`/`test:e2e` green. Migration-free. **The real Chromium-on-Lambda render is live on staging** — the deploy-role IAM fix it needed (`ManageAppIamRoles`, `infra/aws/`) has been applied (2026-07-21), so the `Pdf` function deploys and runs; staging is the authority for this one piece the sandbox/CI can't prove. |
| 4b | PDF **Send-to-Email** | **Next feature slice, gated on a domain + SES identity.** SES `SendRawEmail` with the PDF attached + a localized body; on send failure, a clear error + download fallback (§7). Reuses `src/lib/pdf/` verbatim. **Hard prerequisite:** a verified SES sending identity, which needs the `bulbau.lu` domain (SPF/DKIM/DMARC) — SES sandbox only sends to verified addresses. May be deferred behind Phase 5 if the domain isn't ready. |
| 5 | Translation pipeline | DeepL auto-translation on save, manual override UI, stale-flagging on source edits; FR/DE live sitewide |
| 6 | Contact form + spam protection | Form submits via SES, Turnstile + honeypot verified, rate limiting confirmed; **hard gate**: `LegalInfo` populated with real registration details and published before this phase can go to production |
| 7 | Hardening & Well-Architected pass | WAF/GuardDuty evaluated against real traffic, backups verified, monitoring/alarms in place, full-site WCAG 2.1 AA and Lighthouse/SEO audit completed (Sections 6.11/7B), indexing enabled (flips the SEO gate hard), **HSTS `preload` added on the real domain and the nonce-based `script-src`/`style-src` CSP promoted from report-only to enforcing** (the enforce-safe header baseline already shipped 2026-07-21, §7), this document updated to reflect final state |

---

## 13. Open risks & assumptions to validate early

- ~~Payload 3's "runs inside Next.js" model is proven on Vercel; running it via OpenNext on Lambda is architecturally equivalent but should be spiked in Phase 0 before other work depends on it.~~ **Resolved in Phase 0.** It works, but not out of the box — five real, non-obvious issues had to be fixed before it did, all now handled and documented in `docs/PROGRESS.md`: (1) OpenNext's build tracing copies externalized packages (`pg`, `pino`) into the Lambda bundle via symlinks, which Windows can't reliably produce as real Linux symlinks — builds must happen on Linux (CI), never locally on Windows. (2) `sharp` is excluded from the main server bundle by OpenNext by default and also ships architecture-specific binaries that don't cross-compile between an x64 CI runner and an arm64 Lambda — omitted entirely for now since nothing in the current Media collection uses it. (3) Payload's `admin/importMap.js` is generated, not static, and must be regenerated (`npm run generate:importmap`) whenever a collection, field, or plugin that contributes admin UI changes — silently stale otherwise, with no build-time error. (4) Media uploads need an explicit storage adapter (`@payloadcms/storage-s3`); SST linking a bucket only wires IAM permissions, it doesn't make Payload use it. (5) IAM's `aws:RequestedRegion` condition key doesn't meaningfully scope global services (CloudFront, IAM, Route 53) — a region-conditioned Allow silently doesn't cover them.
- ~~Payload's package size + Chromium in the same Lambda function is why PDF generation is split into its own function — this isolation should be confirmed working in Phase 4, not assumed.~~ **Built in Phase 4 part 1 (2026-07-20).** PDF rendering is a **separate x86_64 `Pdf` Lambda** (`puppeteer-core` + full `@sparticuz/chromium`) with no Payload and no DB — the main app assembles the quote HTML and invokes it. The isolation is real in code, and the **runtime** render is now **live on staging**: the deploy-role IAM fix below has been applied, so the `Pdf` function deploys and runs (the sandbox/CI still have no Chromium Lambda, so staging remains the authority for this one piece).
- Exact SST component for ECS Fargate services (Phase B) should be confirmed against current SST documentation when Phase B planning starts, rather than assumed now — also evaluate ECS Express Mode (Section 3) at that time.
- **New, discovered in Phase 0**: the GitHub Actions staging-deploy IAM role currently uses a broad, region-scoped Allow (plus an explicit Deny on the highest-risk IAM/org/billing actions) rather than a hand-enumerated least-privilege policy — a deliberate, documented trade-off (see `infra/aws/README.md`), not an oversight. Follow-up before this pattern is reused for a `production` role: run IAM Access Analyzer against staging's CloudTrail activity and replace the broad statement with the generated policy. **Update (Phase 4 part 1, 2026-07-20):** the global-service gap in that region-scoped Allow bit again — IAM calls carry no region, so `iam:CreateRole` for the new `Pdf` function's execution role was denied on the first Phase 4 deploy (the same reason `ManageCloudFront` needed its own unconditioned statement). Fixed with a scoped `ManageAppIamRoles` statement (`role/bulbau-lu-staging-*`, high-risk IAM verbs still denied), **now applied to the live `gh-actions-bulbau-staging-deploy` role** (2026-07-21) — staging deploys the `Pdf` function successfully. When a `production` deploy role is added it needs the same statement scoped to `bulbau-lu-production-*`. See `infra/aws/README.md` and `docs/PROGRESS.md`.
- ~~New, discovered in Phase 0: no automated test exercises the media upload/delete flow (only manually verified). Adding coverage needs either real AWS credentials in the CI `verify` job or a MinIO/LocalStack service container (matching the existing ephemeral-Postgres pattern).~~ **Resolved** (2026-07-04). Neither MinIO nor LocalStack turned out to be viable by the time this was picked up: MinIO discontinued free Community Edition Docker images in Oct 2025 and archived the repo entirely by Apr 2026; LocalStack ended its Community Edition in Mar 2026 and gates S3 behind an account whose free "Hobby" tier's terms prohibit commercial use (this is a commercial site). Used **Adobe's S3Mock** instead — Apache-2.0, actively released (5.1.0 as of last month), purpose-built for exactly this test scenario with no commercial pressure to erode it. Full details, including the three real bugs this surfaced (not just the intended test-coverage addition), are in `docs/PROGRESS.md`.
- ~~**New, discovered in Phase 1 (content model) — DB migrations must be adopted before the next staging deploy.** Payload's Drizzle adapter only auto-`push`es schema in development; on Lambda (`NODE_ENV=production`) it doesn't, and CI's `deploy-staging` job runs `sst deploy` with no migrate step.~~ **Resolved in code (2026-07-07)** — see §10.5 and `docs/PROGRESS.md`. `migrationDir` + explicit `push` are set on the adapter, an initial full-schema migration is committed, and the CI deploy job runs `payload migrate` (direct/unpooled Neon URL, `NODE_ENV=production`) before `sst deploy`. The generate → apply → idempotency → empty-diff loop was validated end-to-end against a real Postgres in the build sandbox, and the whole workflow is now **verified live on staging (2026-07-08)**: the staging Neon branch was baselined (`migrate:fresh`), the new SST/GitHub secrets set, and CI ran the first migrated deploy — staging serves Phase 1 and tracks migrations. (One bug surfaced and was fixed: a missing `STAGING_DATABASE_URL_UNPOOLED` secret made the CI migrate step fail with a localhost `ECONNREFUSED`; the step now fails fast with a clear message if that URL is empty.)
- **New, found while resolving the above — the 2FA runtime secrets were not wired into `sst.config.ts`.** `TOTP_ENCRYPTION_KEY` (required by `src/lib/totp/keys.ts`, which throws without it) and the optional Upstash pair were documented as staging/prod-required in `.env.example`/CI but were never added to the deployed Lambda's environment — so the first deploy of the 2FA-enabled app would have broken the admin panel on load. Now fixed: all three are `sst.Secret`s injected into the `Web` function's env (`TotpEncryptionKey` required; Upstash defaults to `''` ⇒ in-memory fallback). Addressed here rather than deferred because it blocked the same "next staging deploy".
- **Outstanding client input, tracked as a launch blocker, not a spec gap**: the company's real registered legal form, RCS Luxembourg number, VAT number, and registered office address are still needed to populate `LegalInfo` (Section 5) before Phase 6 can ship to production (Section 6.9). The publish gate enforcing this is now built and tested, so the page is technically prevented from going live with placeholders.
- **New, noted 2026-07-17 — repository governance is not yet configured.** All commits have gone **directly to `main`** with no branch-protection ruleset, and `main` auto-runs `payload migrate` + `sst deploy` on every push. That means an accidental bad direct commit deploys, and a force-push/history rewrite could desync the committed migration chain. Low-cost fix, tracked in `docs/PROGRESS.md` "Immediate next steps": a `main` Ruleset (require PR + the `verify` status check, block force-push, restrict deletions, linear history), plus Dependabot alerts / secret-scanning push protection and `staging` Environment branch restrictions. Not an architecture change — a settings/process addition — but worth doing before the codebase attracts more history worth protecting.
