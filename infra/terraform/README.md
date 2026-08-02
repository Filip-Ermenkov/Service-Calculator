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
> stage went live — the **CloudWatch Lambda alarms are now ON** too (`web_function_name`
> + `pdf_function_name` are filled with the production function names and applied). So
> everything this layer manages is now active. The deploy role's inline policy also
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
| **CloudWatch alarms** (Web/Pdf Lambda errors + throttles) | `observability.tf` | new, opt-in | ✅ ON (production names filled 2026-07-31) |
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

## Turning CloudWatch alarms on

After a stage is deployed, set `web_function_name` / `pdf_function_name` to the
real Lambda names and `terraform apply`. Empty names keep the alarms disabled.
**Done 2026-07-31** — the production names are `bulbau-lu-production-WebServerEucentral1Function-<suffix>`
and `bulbau-lu-production-PdfFunction-<suffix>`, discovered with:

```bash
aws resourcegroupstaggingapi get-resources --region eu-central-1 \
  --resource-type-filters lambda:function \
  --tag-filters "Key=sst:app,Values=bulbau-lu" "Key=sst:stage,Values=production" \
  --query "ResourceTagMappingList[].ResourceARN" --output table
```

Alarm on the main **WebServer** function and the **Pdf** function (not the
ImageOptimizer/Warmer/Revalidation siblings). If the functions are ever
recreated, their random name suffix changes — re-query and re-`apply`.

## Not managed here (pointers, so you don't go looking)

- **Phase 5 translation (2026-08-02)** added no Terraform. AWS Translate needs no
  new resource; the runtime `translate:TranslateText` permission rides on the SST
  **server-function** role (via `sst.config.ts`'s `permissions:` prop), not the
  Terraform-managed deploy role, and it needs no secret. The 30s Lambda
  `server.timeout` is also an SST/`sst.config.ts` setting.
- **Upcoming CloudFront on-demand invalidation** (the proper fix for edit-freshness
  — see `docs/PROGRESS.md` "Immediate next steps") will most likely be **app/SST-
  side too**: a runtime `cloudfront:CreateInvalidation` permission on the server
  role + the distribution ID passed in (the deploy role already has
  `cloudfront:CreateInvalidation` for deploy-time invalidation via `ManageCloudFront`).
  Expect it *not* to land in this Terraform layer unless the distribution ID ends
  up wired via an SSM parameter that we choose to Terraform-manage.
