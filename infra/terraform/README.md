# Foundational IaC (Terraform)

Long-lived, stateful AWS/Neon resources that must **outlive any app deploy** and
therefore are deliberately **not** owned by the removable SST app stage
(`sst.config.ts`). This directory is what the top-of-file comment in
`sst.config.ts` refers to when it says standalone Terraform for non-SST-native
resources "lives in `infra/`".

> **Status (2026-09-18): applied and live.** The zone + delegation set, budgets and the eu-central-1 SNS topic are created; DNS is delegated at EuroDNS; the Neon project and the deploy role are imported (`manage_neon`, `manage_deploy_role` = `true` in the live, gitignored `terraform.tfvars`); the **SES sending identity is applied** (`manage_ses = true` — `_dmarc.bulbau.lu`, `mail.bulbau.lu` MX/SPF and the DKIM CNAMEs resolve publicly, and the site sends from `info@bulbau.lu`); the live tfvars also has `manage_uptime_monitoring = true` with `cloudfront_distribution_id = E1O15XCT0NNBSD` (production). Deploy-policy edits go live with `terraform apply` (`iam.tf` sources `infra/aws/*.json`). **Still to do here:** the root-domain DNS for the client's Google Workspace mailbox `office@bulbau.lu` (MX `1 smtp.google.com.`, root SPF `v=spf1 include:_spf.google.com include:amazonses.com -all`, Google's DKIM TXT and the site-verification TXT — a new gated file `workspace-mail.tf`, same pattern as `ses.tf`; the last two values come only from the Workspace admin console), and re-running `terraform plan` from a credentialed session to confirm no drift (the `neon_pg_version` variable default was corrected to 18 on 2026-09-18 to match the live tfvars, so the plan should stay clean). The runbook below is for a fresh clone / disaster recovery.

## What it manages

| Resource | File | Risk | Applied |
| --- | --- | --- | --- |
| Route 53 **reusable delegation set** (stable nameservers) | `dns.tf` | new (safe create) | first pass |
| Route 53 **public hosted zone** for `bulbau.lu` | `dns.tf` | new (safe create) | first pass |
| **AWS Budgets** (daily + monthly cost alarms → email) | `budget.tf` | new (safe create) | first pass |
| **SNS ops-alert topic** (`bulbau-lu-ops-alerts`) | `observability.tf` | new (safe create) | ✅ live |
| **SES domain identity** + DKIM/MAIL-FROM/SPF/DMARC records | `ses.tf` | new, opt-in (`manage_ses`) | ✅ applied |
| **Route 53 uptime check + CloudFront 5xx alarm** (us-east-1) | `uptime.tf` | new, opt-in | enabled in the live tfvars (`manage_uptime_monitoring = true`) |
| ~~CloudWatch Lambda alarms~~ | ~~`observability.tf`~~ | — | ➡️ **in `sst.config.ts`** (wired by reference) |
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

## Where alarms live

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

**⚠️ APPLY ORDER** for any future alarm change: deploy the SST stage **first**, then
`terraform apply`. If a plan ever wants to destroy the hosted zone, the Neon project or the
deploy role — **stop**.

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

- **Everything per-stage and disposable** is in `sst.config.ts`: the Lambda functions, CloudFront, S3, the **DynamoDB rate-limit table** (`RateLimits` — TTL-expired counters, nothing worth keeping, so PITR is off), the **media CDN pieces** (the media bucket's own policy — CloudFront service principal, `GetObject` + `ListBucket`, `aws:SourceArn`-pinned to this account's distributions — the origin access control, the response-headers policy that mirrors the site's security headers to `/media/*`, and that `/media/*` behaviour on the Web distribution), the app's Route 53 *records* (zone looked up by id), the SSM parameter carrying the CloudFront distribution id, the per-stage alarms + `OPS_ALERT` metric filter, and every runtime IAM permission (`translate:TranslateText`, `ssm:GetParameter`, `cloudfront:CreateInvalidation`, `ses:SendEmail`, `dynamodb:GetItem`/`UpdateItem`), granted to the Web function's execution role via `permissions:`/`link:`.
- **SST secrets** (`DatabaseUrl`, `PayloadSecret`, `TotpEncryptionKey`, `SiteUrl`, `EmailSender`, `TurnstileSecretKey`/`TurnstileSiteKey`, `AllowIndexing`) live in SSM under the `sst-*` prefix — set with `npx sst secret set`, see the root README. Rate limiting, translation, CDN invalidation and SES sending need no secret (execution-role auth).
- **Cloudflare Turnstile** is a Cloudflare-side widget; no AWS resource.
- **The Google Workspace mailbox DNS** is the one remaining foundational item that *belongs* here and is not yet authored (see the status note above).
