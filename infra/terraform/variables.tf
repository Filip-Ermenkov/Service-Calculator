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

# ── CloudWatch Lambda alarms (opt-in) ───────────────────────────────────────
# Empty by default so the FIRST apply doesn't reference Lambda functions that may
# not exist yet (the production stage isn't deployed until a later slice). After
# an `sst deploy`, set these to the real function names (from the deploy output /
# Lambda console) to switch the alarms on. See observability.tf.
variable "web_function_name" {
  description = "Name of the SST 'Web' (Next/Payload) Lambda to alarm on. Empty = alarm disabled."
  type        = string
  default     = ""
}

variable "pdf_function_name" {
  description = "Name of the SST 'Pdf' Lambda to alarm on. Empty = alarm disabled."
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
