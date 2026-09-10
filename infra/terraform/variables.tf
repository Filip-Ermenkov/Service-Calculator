# Input variables. Non-secret values can go in terraform.tfvars (gitignored);
# secrets (neon_api_key) are better supplied via TF_VAR_* environment variables.

variable "aws_account_id" {
  description = "The dedicated AWS account ID (service-calculator-production). Guards against running against the wrong account."
  type        = string
}

variable "aws_region" {
  description = "Primary AWS region (matches sst.config.ts)."
  type        = string
  default     = "eu-central-1"
}

variable "domain_name" {
  description = "The registered domain the public hosted zone is authoritative for."
  type        = string
  default     = "bulbau.lu"
}

variable "alert_email" {
  description = "Email address that receives budget + CloudWatch alarm notifications. Each SNS/budget subscription must be confirmed via the email AWS sends."
  type        = string
}

# ── Cost guardrails ─────────────────────────────────────────────────────────
variable "daily_budget_limit" {
  description = "Daily cost budget in USD. An idle, scale-to-zero stack should sit near $0, so a low daily ceiling catches runaway spend fast."
  type        = string
  default     = "1"
}

variable "monthly_budget_limit" {
  description = "Monthly cost budget in USD (actual + forecasted alerts)."
  type        = string
  default     = "10"
}

# ── Uptime + edge monitoring (opt-in, us-east-1) ────────────────────────────
# NOTE: the per-stage Lambda alarms that used to be configured here (via
# web_function_name / pdf_function_name) moved to sst.config.ts, where they wire
# to the real functions BY REFERENCE instead of by a hand-copied name that goes
# silently stale when a function is replaced. Those two variables were removed
# with them — see observability.tf's header for the full rationale.
variable "manage_uptime_monitoring" {
  description = "Whether Terraform provisions the Route 53 health check on https://<domain>/api/health plus its us-east-1 SNS topic and alarms (uptime.tf). Kept FALSE by default: it costs ~$1.00-1.50/month and needs a second SNS email confirmation. Turn it on before the public launch."
  type        = bool
  default     = false
}

variable "cloudfront_distribution_id" {
  description = "Production CloudFront distribution id, printed by `sst deploy --stage production` as the `cdnDistributionId` output. Enables the CloudFront 5xxErrorRate alarm (us-east-1 only, which is why it cannot live in sst.config.ts). Empty = that one alarm is skipped."
  type        = string
  default     = ""
}

# ── Neon (import-only, opt-in) ──────────────────────────────────────────────
variable "manage_neon" {
  description = "Whether Terraform manages the (already-existing) Neon project. Keep FALSE until the project has been `terraform import`ed — otherwise apply would CREATE a second, duplicate project. See neon.tf + README."
  type        = bool
  default     = false
}

variable "neon_api_key" {
  description = "Neon API key (personal/organization). Supply via TF_VAR_neon_api_key or a gitignored tfvars — never commit. Only used when manage_neon = true."
  type        = string
  default     = ""
  sensitive   = true
}

variable "neon_project_name" {
  description = "Display name of the existing Neon project (reconcile against `terraform plan` after import)."
  type        = string
  default     = "bulbau-lu"
}

variable "neon_region_id" {
  description = "Neon region id of the existing project, e.g. aws-eu-central-1 (reconcile after import)."
  type        = string
  default     = "aws-eu-central-1"
}

variable "neon_pg_version" {
  description = "Postgres major version of the existing Neon project (reconcile after import)."
  type        = number
  default     = 17
}

variable "neon_history_retention_seconds" {
  description = "Point-in-time-restore history window, in seconds. Defaulted to 21600 (6h) to match the existing project so the import plan is clean. Raising it (e.g. 86400 = 24h) lengthens the PITR window — a deliberate change to apply on its own, and subject to your Neon plan's limits."
  type        = number
  default     = 21600
}

# ── SES sending identity (opt-in) ────────────────────────────────────────────
variable "manage_ses" {
  description = "Whether Terraform provisions the SES domain identity for bulbau.lu + its DKIM/SPF/DMARC/MAIL-FROM DNS records (Phase 4 part 2 — quote-by-email). Kept FALSE by default so a first apply doesn't provision before you're ready; flip to true and `terraform apply` to create it (the DNS is in-zone, so verification is automatic within minutes). See ses.tf + the manual guide."
  type        = bool
  default     = false
}

# ── GitHub Actions deploy IAM role (import-only, opt-in) ─────────────────────
variable "manage_deploy_role" {
  description = "Whether Terraform manages the (already-existing) GitHub-Actions deploy role + inline policy, making the committed JSON the single source of truth (file = live). Keep FALSE until the role has been `terraform import`ed — otherwise apply would try to CREATE a role that already exists. See iam.tf + README."
  type        = bool
  default     = false
}

variable "deploy_role_name" {
  description = "Name of the existing GitHub-Actions deploy IAM role to bring under management."
  type        = string
  default     = "gh-actions-bulbau-staging-deploy"
}
