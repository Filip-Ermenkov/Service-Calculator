# Foundational IaC (Terraform)

Long-lived, stateful AWS/Neon resources that must **outlive any app deploy** and
therefore are deliberately **not** owned by the removable SST app stage
(`sst.config.ts`). This directory is what the top-of-file comment in
`sst.config.ts` refers to when it says standalone Terraform for non-SST-native
resources "lives in `infra/`".

> **Status (2026-10-22): applied and live.** The zone + delegation set, budgets and the eu-central-1 SNS topic are created; DNS is delegated at EuroDNS; the Neon project and the deploy role are imported (`manage_neon`, `manage_deploy_role` = `true` in the live, gitignored `terraform.tfvars`). The **SES sending identity** is applied (`manage_ses = true` — `_dmarc`, `mail.bulbau.lu` MX/SPF and the DKIM CNAMEs all resolve; the site sends from `info@bulbau.lu`). The **client mailbox DNS** is applied too (`workspace-mail.tf`, `manage_workspace_mail = true`): `bulbau.lu` now answers `MX 1 smtp.google.com`, with the Google SPF/DKIM and verification records alongside SES on `mail.`. Uptime monitoring is on (`manage_uptime_monitoring = true`, `cloudfront_distribution_id = E1O15XCT0NNBSD`). Deploy-policy edits go live with `terraform apply` (`iam.tf` sources `infra/aws/*.json`).
>
> The **SES reputation alarms** are applied too (`ses-reputation.tf`, `manage_ses_reputation_alarms = true`, 2026-10-23). Both sit in `INSUFFICIENT_DATA` until the account sends mail; steps 3–4 [below](#turning-the-ses-reputation-alarms-on-ses-reputationtf-opt-in) are still open. A full `terraform plan` on 2026-10-23 showed no drift.
>
> **Open here:** read the SES metric's publishing cadence once mail flows (step 4 below), and move DMARC from `p=none` to `p=quarantine` once aggregate reports have been arriving for a while (`dmarc_policy`). The runbook below is for a fresh clone / disaster recovery.

## What it manages

| Resource | File | Risk | Applied |
| --- | --- | --- | --- |
| Route 53 **reusable delegation set** (stable nameservers) | `dns.tf` | new (safe create) | first pass |
| Route 53 **public hosted zone** for `bulbau.lu` | `dns.tf` | new (safe create) | first pass |
| **AWS Budgets** (daily + monthly cost alarms → email) | `budget.tf` | new (safe create) | first pass |
| **SNS ops-alert topic** (`bulbau-lu-ops-alerts`) | `observability.tf` | new (safe create) | ✅ live |
| **SES domain identity** + DKIM/MAIL-FROM/SPF/DMARC records | `ses.tf` | new, opt-in (`manage_ses`) | ✅ applied |
| **Client mailbox DNS** (Google Workspace MX/SPF/DKIM/verification on the root) | `workspace-mail.tf` | new, opt-in (`manage_workspace_mail`) | ✅ applied |
| **Route 53 uptime check + CloudFront 5xx alarm** (us-east-1) | `uptime.tf` | new, opt-in | enabled in the live tfvars (`manage_uptime_monitoring = true`) |
| **SES reputation alarms** (account bounce ≥ 2%, complaint ≥ 0.05%, eu-central-1) | `ses-reputation.tf` | new, opt-in (`manage_ses_reputation_alarms`) | applied 2026-10-23 |
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

To get data *back*, see [Restoring the production database](#restoring-the-production-database-neon-point-in-time-restore).

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

## Restoring the production database (Neon point-in-time restore)

Production is the `production` branch of Neon project `purple-boat-01519758`, the
project's root and default branch; `staging` is its child. Terraform manages the
project, never a branch, so a restore does not touch Terraform state.

**The window is 6 hours.** `history_retention_seconds = 21600` is the Free plan's
maximum (6 h, capped at 1 GB of history; Launch allows up to 7 days). Damage noticed
later than that cannot be undone from Neon.

The commands use the Neon API; the console has the same actions. Bash:

```bash
export NEON_API_KEY='...'   # neon_api_key in the gitignored terraform.tfvars — never echo it
P=purple-boat-01519758
neon() { local path=$1; shift; curl -sS -H "Authorization: Bearer $NEON_API_KEY" \
  -H 'Content-Type: application/json' "https://console.neon.tech/api/v2$path" "$@"; }
PROD=$(neon "/projects/$P/branches" | node -pe \
  'JSON.parse(require("fs").readFileSync(0)).branches.find(b => b.name === "production").id')
```

**1. Pick the restore point** — just before the damage, in UTC (RFC 3339). The
affected table's `updated_at`, the Payload version tables (`_services_v`,
`_legal_info_v`, …) or the web Lambda's logs tell you when. Ask the client to stop
editing: anything written after the restore point leaves the live database.

**2. Restore into a new branch and check it** (rehearsed — see below):

```bash
neon "/projects/$P/branches" -X POST -d '{
  "branch": { "parent_id": "'"$PROD"'", "name": "recovery", "parent_timestamp": "2026-10-23T08:30:00Z" },
  "endpoints": [{ "type": "read_write" }]
}'   # note branch.id and branch.parent_lsn from the response
REC=br-...   # branch.id
neon "/projects/$P/connection_uri?branch_id=$REC&database_name=neondb&role_name=neondb_owner&pooled=false"
```

That returns the recovery branch's direct URL, password included; the same call
with `branch_id=$PROD` gives production's. Fingerprint both, read-only, and diff:

```bash
PGOPTIONS='-c default_transaction_read_only=on' psql "<production direct url>" -X -q -v ON_ERROR_STOP=1 -f scripts/db-fingerprint.sql > production.txt
PGOPTIONS='-c default_transaction_read_only=on' psql "<recovery direct url>"   -X -q -v ON_ERROR_STOP=1 -f scripts/db-fingerprint.sql > recovery.txt
diff production.txt recovery.txt
```

Only tables written after the restore point may differ, and the damage must be
gone. If not, delete the branch and try another point.

**3. Put it live — one of:**

- **A. Restore `production` in place (preferred).** Hostnames stay the same, so no
  secret changes. `source_lsn` is the recovery branch's `parent_lsn`, so production
  lands on exactly the state you checked:

  ```bash
  neon "/projects/$P/branches/$PROD/restore" -X POST -d '{
    "source_branch_id": "'"$PROD"'",
    "source_lsn": "<parent_lsn>",
    "preserve_under_name": "production_before_restore_YYYY-MM-DD"
  }'
  ```

  `preserve_under_name` is mandatory here (restoring to its own history, and
  `staging` is a child). The pre-restore state stays readable under that name, and
  `staging` moves under it, so that branch cannot be deleted while `staging` exists.
  Open connections drop for a few seconds. Then delete the recovery branch:
  `neon "/projects/$P/branches/$REC" -X DELETE`.

- **B. Point the app at the recovery branch.** For when production's current state
  must stay live for inspection, or A is refused. With AWS credentials
  (`aws sso login --profile sc-new`):

  ```bash
  npx sst secret set DatabaseUrl "<recovery POOLED url>" --stage production   # connection_uri with pooled=true
  gh secret set PRODUCTION_DATABASE_URL_UNPOOLED --env production             # prompts: paste the DIRECT url
  ```

  The Lambda gets `DATABASE_URL` from the secret at deploy time (`sst.config.ts`),
  so nothing changes until step 4. Production then lives on a child branch: Neon
  restores in place only on root branches, so the next restore must use B again,
  and the old `production` branch cannot be deleted while it has children.

Neither A nor B has been rehearsed; both need the production branch.

**4. Redeploy production.** It re-renders the static pages from the restored
database (the build reads `PRODUCTION_DATABASE_URL_UNPOOLED`), re-runs the migrate
step (re-applying any migration newer than the restore point) and invalidates
CloudFront `/*` (every build has a new Next build ID). `ci.yml` has no manual
trigger, so re-run the production job of the **latest** successful `main` run, since
an older run would also roll back the code:

```bash
RUN=$(gh run list --workflow ci.yml --branch main --event push --status success --limit 1 --json databaseId --jq '.[0].databaseId')
gh run rerun "$RUN" --job "$(gh run view "$RUN" --json jobs --jq '.jobs[] | select(.name == "Deploy to production") | .databaseId')"
```

Then approve it in the `production` environment. The job takes about 3 minutes
(3 min 08 s on 2026-10-23).

**5. Confirm.** Fingerprint production again; the site shows the restored content;
`terraform plan` here shows no change to `neon_project.main[0]`.

### Rehearsal — 2026-10-23

A branch of `production` at a past timestamp, compared with production, then
deleted. Production itself was only read.

| | |
| --- | --- |
| Restore point asked for | `2026-10-23T08:30:00Z`, about an hour back. Neon resolved it to LSN `0/12959B70` and reported `parent_timestamp` 08:16:15Z; production had no writes in between |
| Branch + compute ready | **3.0 s** after the request (API answered in 0.8 s; `create_branch` 0.6 s, `start_compute` 1.4 s) |
| First query answered | about **4.6 s** after the request |
| Row counts | equal in **34 / 34** tables |
| Content (`db-fingerprint.sql` md5) | identical in **32 / 34** tables |
| `payload_migrations` | identical, 6 rows |
| Latest `updated_at` | identical: `services` 2026-10-10 09:52:59Z, `company_info` 2026-10-20 13:08:17Z, `legal_info` 2026-10-20 11:45:40Z |
| What differed | `users` and `users_sessions` only: an admin login at 09:06:48Z, after the restore point. Its absence is the proof the branch is the past, not a copy of today |
| Cleanup | the branch existed 84 s, was deleted, and `GET` on it returns 404 |

The database is 37 MB logical, so these timings say nothing about a large one. A
real restore's wall-clock time is the redeploy plus the approval.

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

Two kinds of alarm do stay here: the us-east-1 ones (`uptime.tf`, below), which a deploy
cannot create, and the SES reputation alarms (`ses-reputation.tf`), which watch an
**account-level** metric shared by both stages and so must outlive either of them.

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

## Turning the SES reputation alarms on (`ses-reputation.tf`, opt-in)

Two eu-central-1 alarms on the account's SES reputation, notifying the existing
`bulbau-lu-ops-alerts` topic — the same topic and email subscription as the SST alarms, so
there is no new confirmation email:

| Alarm | Metric | Fires at | AWS reviews at | AWS may pause at |
| --- | --- | --- | --- | --- |
| `bulbau-lu-ses-bounce-rate` | `AWS/SES Reputation.BounceRate` | ≥ 2% | 5% | 10% |
| `bulbau-lu-ses-complaint-rate` | `AWS/SES Reputation.ComplaintRate` | ≥ 0.05% | 0.1% | 0.5% |

AWS's alarm guide suggests 5% and 0.1%, which are the review points themselves, so an alarm
there arrives together with AWS's notice rather than before it. The reasoning, and what the
thresholds mean at this site's low volume, is in the header of `ses-reputation.tf`. **Cost:**
≈ $0.20/month (the account is already past CloudWatch's 10 free alarms).

1. In `terraform.tfvars`: `manage_ses_reputation_alarms = true`.

2. `terraform plan` — expect exactly **2 to add, 0 to change, 0 to destroy**
   (`aws_cloudwatch_metric_alarm.ses_bounce_rate[0]` and `.ses_complaint_rate[0]`). Then
   `terraform apply`.

3. Check they are evaluating something:

   ```bash
   aws cloudwatch describe-alarms \
     --alarm-names bulbau-lu-ses-bounce-rate bulbau-lu-ses-complaint-rate \
     --region eu-central-1 \
     --query "MetricAlarms[].{Name:AlarmName,State:StateValue,Threshold:Threshold}" \
     --output table
   ```

   `OK` means the metric exists and is below the threshold. **`INSUFFICIENT_DATA` means the
   alarm is watching nothing** — that is deliberate (`treat_missing_data = "missing"`; the
   alternatives would show green instead). The metrics only exist once SES has sent mail from
   this account in eu-central-1. If they have never appeared, send one message to the SES
   mailbox simulator (`success@simulator.amazonses.com`), which creates them without counting
   towards either rate.

4. **Find out how often SES publishes the metric.** AWS does not document it, and it decides
   whether `INSUFFICIENT_DATA` can be pushed to the inbox:

   ```bash
   aws cloudwatch get-metric-statistics \
     --namespace AWS/SES --metric-name Reputation.BounceRate \
     --start-time "$(date -u -d '-3 days' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
     --period 3600 --statistics SampleCount --region eu-central-1 \
     --query "length(Datapoints)"
   ```

   About **72** (one per hour) means SES publishes continuously, so a gap really means the
   metric stopped: add `insufficient_data_actions = [aws_sns_topic.ops_alerts.arn]` to both
   alarms and update the matching assertion in `tests/ses_reputation_alarms.tftest.hcl`. **Far
   fewer** means it is published only around sends, and the alarms must stay as they are —
   otherwise every quiet hour sends an email.

5. **Prove delivery:**

   ```bash
   aws cloudwatch set-alarm-state --alarm-name bulbau-lu-ses-bounce-rate \
     --state-value ALARM --state-reason "Delivery test" --region eu-central-1
   ```

   The email should reach the ops inbox within a minute. The alarm returns to its real state at
   its next evaluation; no `OK` email follows, because these alarms notify only on
   `ALARM` (see the header of `ses-reputation.tf` for why).

## Not managed here (pointers, so you don't go looking)

- **Everything per-stage and disposable** is in `sst.config.ts`: the Lambda functions, CloudFront, S3, the **DynamoDB rate-limit table** (`RateLimits` — TTL-expired counters, nothing worth keeping, so PITR is off), the **media CDN pieces** (the media bucket's own policy — CloudFront service principal, `GetObject` + `ListBucket`, `aws:SourceArn`-pinned to this account's distributions — the origin access control, the response-headers policy that mirrors the site's security headers to `/media/*`, and that `/media/*` behaviour on the Web distribution), the app's Route 53 *records* (zone looked up by id), the SSM parameter carrying the CloudFront distribution id, the per-stage alarms + `OPS_ALERT` metric filter, and every runtime IAM permission (`translate:TranslateText`, `ssm:GetParameter`, `cloudfront:CreateInvalidation`, `ses:SendEmail`, `dynamodb:GetItem`/`UpdateItem`), granted to the Web function's execution role via `permissions:`/`link:`.
- **SST secrets** (`DatabaseUrl`, `PayloadSecret`, `TotpEncryptionKey`, `SiteUrl`, `EmailSender`, `TurnstileSecretKey`/`TurnstileSiteKey`, `AllowIndexing`) live in SSM under the `sst-*` prefix — set with `npx sst secret set`, see the root README. Rate limiting, translation, CDN invalidation and SES sending need no secret (execution-role auth).
- **Cloudflare Turnstile** is a Cloudflare-side widget; no AWS resource.
- **The Google Workspace mailbox DNS** is the one remaining foundational item that *belongs* here and is not yet authored (see the status note above).
