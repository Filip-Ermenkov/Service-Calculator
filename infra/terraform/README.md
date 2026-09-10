# Foundational IaC (Terraform)

Long-lived, stateful AWS/Neon resources that must **outlive any app deploy** and
therefore are deliberately **not** owned by the removable SST app stage
(`sst.config.ts`). This directory is what the top-of-file comment in
`sst.config.ts` refers to when it says standalone Terraform for non-SST-native
resources "lives in `infra/`".

> **Status: APPLIED and live (2026-07-31).** The zone + delegation set, budgets, and
> SNS are created; DNS is delegated at EuroDNS (`dig NS bulbau.lu` resolves); the
> Neon project and deploy role are imported (`manage_neon` + `manage_deploy_role` are
> both `true` in the live, gitignored `terraform.tfvars`); and — since the `production`
> stage went live — the CloudWatch Lambda alarms were switched on here too. **⚠️ Those
> alarms MOVED OUT of this layer on 2026-09-10** (see "Where alarms live" below); the
> `web_function_name` / `pdf_function_name` variables are gone, and applying this layer
> after an SST deploy will **destroy the three superseded hand-named alarms**. Everything
> else this layer manages is active. The deploy role's inline policy also
> gained ACM (us-east-1) + Route 53 statements during the production stand-up (pushed
> via `terraform apply`, since `iam.tf` sources `infra/aws/*.json` via `file()`). The
> runbook below remains the reference for a fresh clone / disaster recovery.

## What it manages

| Resource | File | Risk | Applied |
| --- | --- | --- | --- |
| Route 53 **reusable delegation set** (stable nameservers) | `dns.tf` | new (safe create) | first pass |
| Route 53 **public hosted zone** for `bulbau.lu` | `dns.tf` | new (safe create) | first pass |
| **AWS Budgets** (daily + monthly cost alarms → email) | `budget.tf` | new (safe create) | first pass |
| **SNS** ops topic + email subscription | `observability.tf` | new (safe create) | first pass |
| **SNS ops-alert topic** (`bulbau-lu-ops-alerts`) | `observability.tf` | new (safe create) | ✅ live |
| **Route 53 uptime check + CloudFront 5xx alarm** (us-east-1) | `uptime.tf` | new, opt-in | ⏳ not yet enabled (`manage_uptime_monitoring = false`) |
| ~~CloudWatch Lambda alarms~~ | ~~`observability.tf`~~ | — | ➡️ **moved to `sst.config.ts` 2026-09-10** |
| **Neon project** (existing DB) | `neon.tf` | import-only, `prevent_destroy` | after import |
| **GitHub-Actions deploy role + policy** (existing) | `iam.tf` | import-only, `prevent_destroy` | after import |

Everything is tagged `ManagedBy=terraform, Project=bulbau-lu, Layer=foundational`
and the provider is pinned to `allowed_account_ids = [<the dedicated account>]`
so it can never run against the wrong account.

## Why a reusable delegation set

A hosted zone that is destroyed/recreated gets **new** nameservers, forcing a
registrar (EuroDNS) change + up to 48h propagation + a resolve-to-nothing window.
A reusable delegation set is a fixed, free set of four nameservers; creating the
zone against it means the zone can be deleted (to reach literal **$0** in the
"site off" mode) and later recreated with **identical** nameservers — EuroDNS
never changes. See `dns.tf` for the full rationale.

## State backend

Remote state in S3 with **native locking** (`use_lockfile = true`, Terraform ≥
1.11 — no DynamoDB table; that approach is deprecated in 2026). The state bucket
must exist **before** `terraform init` (a backend can't create its own bucket):

```bash
# ONE-TIME, run with admin/appropriate creds for the dedicated account:
aws s3api create-bucket \
  --bucket bulbau-lu-tfstate \
  --region eu-central-1 \
  --create-bucket-configuration LocationConstraint=eu-central-1
aws s3api put-bucket-versioning \
  --bucket bulbau-lu-tfstate \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption \
  --bucket bulbau-lu-tfstate \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"}}]}'
aws s3api put-public-access-block \
  --bucket bulbau-lu-tfstate \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

## First apply (safe: creates only)

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # then edit; keep secrets in env
export TF_VAR_neon_api_key=...                 # only needed once manage_neon=true

terraform init
terraform plan -out tfplan     # review: must be CREATES only (no destroy)
terraform apply tfplan

terraform output name_servers  # → paste these four into EuroDNS, once
```

At this point: the delegation set, the zone, both budgets, and the SNS topic
exist. Confirm the SNS + budget emails AWS sends. Nothing existing was touched.

## Importing existing resources (do AFTER the first apply)

Bringing the live Neon project and deploy role under management is **import-only**
and gated behind feature flags so it can never happen by accident. For each:

### Neon project

```bash
# set manage_neon = true in terraform.tfvars, then:
terraform import 'neon_project.main[0]' <neon-project-id>   # e.g. damp-recipe-88779456
terraform plan   # RECONCILE neon_* vars until this shows NO changes
```

### Deploy IAM role (makes the committed JSON the single source of truth)

```bash
# set manage_deploy_role = true, then:
# NOTE: the import ID for the inline policy is <role-name>:<inline-policy-name>.
# The inline policy is NAMED "bulbau-staging-deploy" in AWS (distinct from the
# JSON filename github-actions-deploy-policy.json that file() sources).
terraform import 'aws_iam_role.deploy[0]'        gh-actions-bulbau-staging-deploy
terraform import 'aws_iam_role_policy.deploy[0]' gh-actions-bulbau-staging-deploy:bulbau-staging-deploy
terraform plan   # a clean plan proves file == live; a 1st-plan inline-policy
                 # diff is a known aws-provider quirk — a second apply settles it
```

**Golden rule:** never `terraform apply` an import branch until `terraform plan`
shows no destroy/replace of the imported resource. `prevent_destroy` is a
backstop, not a substitute for reading the plan.

## Where alarms live (changed 2026-09-10 — read before applying)

**The per-stage Lambda alarms are no longer here.** They are defined in `sst.config.ts` and
wired to the real functions **by reference**, so they cannot go stale.

Why they moved: they used to target Lambda names copied by hand into `terraform.tfvars`
after a deploy. Any change that forces Lambda replacement gives the function a new random
name suffix, after which the alarms watch a function that no longer exists — and because
they are `treat_missing_data = "notBreaching"`, they sit **permanently green** while
monitoring nothing. An alarm that cannot tell you it stopped working is worse than no alarm.
This also matches the layer split TECHSPEC §10.3 actually implies: an alarm on a per-stage
Lambda is a per-stage, disposable resource.

**Consequence for your `terraform.tfvars`:** delete the `web_function_name` and
`pdf_function_name` lines — the variables no longer exist. (Terraform only *warns* about
undeclared variables in a tfvars file, so a stale copy will not fail the apply.)

**⚠️ APPLY ORDER.** Deploy the SST stage **first**, then `terraform apply`. The plan will
show **3 destroys** — `bulbau-lu-web-lambda-errors`, `bulbau-lu-pdf-lambda-errors`,
`bulbau-lu-pdf-lambda-throttles` — which are the superseded hand-named alarms. Applying in
the other order leaves a window with no Lambda alarms at all. If the plan wants to destroy
anything else — especially the hosted zone, the Neon project or the deploy role — **stop**.

Verify the replacements exist after the deploy:

```bash
aws cloudwatch describe-alarms --alarm-name-prefix bulbau-lu-production \
  --region eu-central-1 \
  --query "MetricAlarms[].{Name:AlarmName,State:StateValue,Fn:Dimensions[0].Value}" \
  --output table
```

Expect five: `-web-lambda-errors`, `-web-lambda-throttles` (new — the public-facing function
had none before), `-pdf-lambda-errors`, `-pdf-lambda-throttles`, and `-app-ops-alerts` (fed by
the `OPS_ALERT` log metric filter — see TECHSPEC §8.1). Check the `Fn` column matches the
live function names; that is the whole point of the move.

---

## Turning uptime + edge monitoring on (`uptime.tf`, opt-in)

This is the only monitoring that **must** stay in this layer: CloudFront and Route 53 publish
metrics **only to us-east-1**, a CloudWatch alarm can only notify an SNS topic in its own
region, and the GitHub-Actions deploy role is scoped to eu-central-1 (with a narrow ACM-only
us-east-1 carve-out). An `sst deploy` therefore *cannot* create these.

**Cost: ~$1.00–1.50/month** (Route 53 health check base + the HTTPS optional feature).
Alarms are free below 10. Do this before the public launch.

1. In `terraform.tfvars`:

   ```hcl
   manage_uptime_monitoring   = true
   cloudfront_distribution_id = "E..."   # the `cdnDistributionId` output of `sst deploy --stage production`
   ```

   Leaving `cloudfront_distribution_id` empty simply skips the CloudFront 5xx alarm; the
   uptime check still works.

2. `terraform plan` — expect ~5 creates (us-east-1 SNS topic + subscription, the health
   check, and two alarms). Then `terraform apply`.

3. **Confirm the SNS subscription email.** This is a *second* confirmation, separate from the
   eu-central-1 topic's — subject line `bulbau-lu-ops-alerts-us-east-1`. Until you click it,
   the uptime and CloudFront alarms deliver nowhere.

4. Verify the probe went green (allow ~2 minutes):

   ```bash
   aws route53 get-health-check-status \
     --health-check-id "$(terraform output -raw site_health_check_id)"
   ```

   Expect `Success: HTTP Status Code 200` from all three checkers. The check targets
   `https://<domain>/api/health`, which sets `Cache-Control: no-store` — so a green check
   means the **origin** answered, not CloudFront replaying a cached copy.

**Why 3 checker regions and not the default set:** Route 53 probes independently from every
selected region. The default (~15 checkers) at a 30s interval is ~1.3M Lambda invocations per
month, which would exceed Lambda's 1M free tier on its own. Three is the documented minimum
and lands at ~260k/month.

**Prove delivery rather than assuming it.** Use `aws cloudwatch set-alarm-state` to force an
alarm and confirm the email arrives — remembering that `bulbau-lu-site-unreachable` lives in
**us-east-1**, not eu-central-1. It self-corrects on the next evaluation.

## Not managed here (pointers, so you don't go looking)

- **Phase 6 contact form + Cloudflare Turnstile (2026-08-06)** added no Terraform.
  Turnstile is a Cloudflare service (no AWS resource); its keys are SST secrets
  (`TurnstileSecretKey`/`TurnstileSiteKey`), and the contact-form relay reuses the
  existing SES sending identity (below) — so nothing here changed.
- **Phase 4b email — SES sending identity** IS managed here (`ses.tf`, behind the
  `manage_ses` gate: domain identity + Easy DKIM + custom MAIL FROM `mail.bulbau.lu`
  + SPF + DMARC). It must be applied (`manage_ses=true` → `terraform apply`) and the
  `EmailSender` secret set before the email-quote path (and, for spam-free
  deliverability, the contact form) sends for real. See `docs/PROGRESS.md`.
- **Phase 5 translation (2026-08-02)** added no Terraform. AWS Translate needs no
  new resource; the runtime `translate:TranslateText` permission rides on the SST
  **server-function** role (via `sst.config.ts`'s `permissions:` prop), not the
  Terraform-managed deploy role, and it needs no secret. The 30s Lambda
  `server.timeout` is also an SST/`sst.config.ts` setting.
- **Phase 5 part 2 — Translation Management admin screen (2026-08-06)** added no
  Terraform and no infra of any kind. It is pure app code inside the existing Web
  function (a custom `/admin/translations` Payload Root View + a `POST /api/admin/translations`
  write route) reusing the existing DB access, the Phase 5 part 1 Translate
  permission, and the existing revalidate/CDN path — migration-free, no new secret,
  no new resource. Deployed as commit `e3121af`. See `docs/PROGRESS.md` → "Phase 5 part 2".
- **CloudFront on-demand invalidation — DONE 2026-08-04, and (as predicted) entirely
  app/SST-side, NOT in this Terraform layer.** The runtime `cloudfront:CreateInvalidation`
  + `ssm:GetParameter` permissions ride on the SST **server-function** role (via
  `sst.config.ts`'s `permissions:` prop), and the distribution ID is wired via an
  **SST-managed** SSM parameter (`/bulbau-lu/<stage>/web-cdn-distribution-id`, created
  after the Nextjs component to break the SST #5990 cycle) — chosen deliberately as
  SST-owned, not Terraform-owned, because it is a per-stage, disposable value that
  must be recreated with the stage. So this Terraform layer is **unchanged** by that
  slice; the committed deploy-policy JSON also needed no edit. See `docs/PROGRESS.md`
  → "On-demand CloudFront invalidation".
