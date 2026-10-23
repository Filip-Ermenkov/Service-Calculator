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
  description = "Postgres major version of the existing Neon project (reconcile after import). The live project is 18 (terraform.tfvars); docker-compose.yml and the CI service container track the same major (postgres:18-alpine) so local/CI never run migrations against an older engine than production."
  type        = number
  default     = 18
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

variable "manage_ses_reputation_alarms" {
  description = "Whether Terraform creates the two account-level SES reputation alarms (Reputation.BounceRate >= 2%, Reputation.ComplaintRate >= 0.05%) that notify the eu-central-1 ops topic before AWS reviews or pauses the account (ses-reputation.tf). Kept FALSE by default like every other opt-in resource. Independent of manage_ses: reputation belongs to the account, not to one identity."
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

# ── DMARC (domain-wide; the record itself lives in ses.tf) ──────────────────
variable "dmarc_policy" {
  description = "DMARC policy for the domain: none (monitor only), quarantine or reject. Start at none; ratchet only after aggregate reports show every legitimate sender (SES and Google Workspace) passing aligned SPF/DKIM."
  type        = string
  default     = "none"

  validation {
    condition     = contains(["none", "quarantine", "reject"], var.dmarc_policy)
    error_message = "dmarc_policy must be one of: none, quarantine, reject."
  }
}

variable "dmarc_report_address" {
  description = "Mailbox that receives DMARC aggregate (rua) reports. Empty = dmarc@<domain_name>. MUST be an address under domain_name: an external address (a gmail.com inbox, say) is silently IGNORED by conformant receivers unless the external domain publishes <domain_name>._report._dmarc.<external> — gmail.com does not, which is why the previous rua never received a single report. Create the mailbox as a Workspace alias or group."
  type        = string
  default     = ""

  validation {
    condition     = var.dmarc_report_address == "" || endswith(lower(var.dmarc_report_address), "@${lower(var.domain_name)}")
    error_message = "dmarc_report_address must be an address under domain_name (e.g. dmarc@bulbau.lu) — an external mailbox cannot receive reports without an authorisation record the external domain would have to publish."
  }
}

# ── Google Workspace mailbox DNS (opt-in) ────────────────────────────────────
variable "manage_workspace_mail" {
  description = "Whether Terraform publishes the DNS the client's Google Workspace mailbox (office@<domain_name>) needs: the root MX to smtp.google.com, the root SPF (Google + SES), and — when their values are supplied — Google's domain-verification TXT and the Workspace DKIM TXT (workspace-mail.tf). Kept FALSE by default like every other opt-in resource."
  type        = bool
  default     = false
}

variable "google_site_verification" {
  description = "Google Workspace domain-verification value, copied from Admin console → Account → Domains → Manage domains → Verify domain (TXT record → Value). Either the full 'google-site-verification=…' string or just the part after '='. Empty = the TXT record is not published (Gmail cannot be activated until it is). Keep it after verification — harmless, and it saves a re-verification dance."
  type        = string
  default     = ""
}

variable "google_dkim_selector" {
  description = "Selector prefix of the Workspace DKIM key (Admin console → Apps → Google Workspace → Gmail → Authenticate email → Generate new record). Google's default is 'google'."
  type        = string
  default     = "google"
}

variable "google_dkim_txt_value" {
  description = "The full TXT value Google shows for the DKIM record ('v=DKIM1; k=rsa; p=MIIB…'). A 2048-bit key is ~410 characters, longer than a single 255-character TXT string, so workspace-mail.tf splits it into the quoted chunks Route 53 requires. Empty = not published yet (Google only offers the key 24–72 h after Gmail is activated)."
  type        = string
  default     = ""
}

# ── Account security baseline (security-baseline.tf, opt-in) ─────────────────
variable "manage_cloudtrail" {
  description = "Whether Terraform creates the account's CloudTrail trail (multi-region, management events, log-file validation) and its private log bucket (security-baseline.tf). Kept FALSE by default like every other opt-in resource."
  type        = bool
  default     = false
}

variable "cloudtrail_retention_days" {
  description = "How long CloudTrail log files are kept in the log bucket before the lifecycle rule deletes them."
  type        = number
  default     = 365

  validation {
    condition     = var.cloudtrail_retention_days >= 90
    error_message = "Keep CloudTrail logs at least 90 days; shorter defeats the point of having more than the console's event history."
  }
}

variable "manage_account_guardrails" {
  description = "Whether Terraform turns on the account-wide S3 Block Public Access and an IAM Access Analyzer for external access (security-baseline.tf). Both free."
  type        = bool
  default     = false
}

variable "manage_guardduty" {
  description = "Whether Terraform enables GuardDuty in the primary region and emails its medium-and-above findings through a dedicated SNS topic (security-baseline.tf). Needs its own subscription-confirmation click."
  type        = bool
  default     = false
}

# ── DNS hardening (dns-hardening.tf, opt-in) ─────────────────────────────────
variable "manage_caa" {
  description = "Whether Terraform publishes CAA records allowing only Amazon (ACM) to issue certificates for the domain, and no wildcards (dns-hardening.tf)."
  type        = bool
  default     = false
}

variable "manage_tls_rpt" {
  description = "Whether Terraform publishes the TLS-RPT record (_smtp._tls) so mail servers report TLS delivery failures to the DMARC report mailbox (dns-hardening.tf)."
  type        = bool
  default     = false
}

variable "manage_dnssec" {
  description = "Whether Terraform signs the zone with DNSSEC (KMS key in us-east-1, key-signing key, signing status, two us-east-1 alarms). Signing only protects once the DS record from `terraform output dnssec_ds_record` is added at the registrar, AFTER waiting 2 days; see dns-hardening.tf for the order, which matters."
  type        = bool
  default     = false
}

# ── Nightly database backups (db-backups.tf, opt-in) ─────────────────────────
variable "manage_db_backups" {
  description = "Whether Terraform creates the private bucket for the nightly pg_dump backups and the write-only role the backup workflow assumes (db-backups.tf). The database-side read-only role and the GitHub `backup` environment are set up by hand; see the README runbook."
  type        = bool
  default     = false
}

variable "db_backup_retention_days" {
  description = "How many days nightly database dumps are kept before the lifecycle rule deletes them."
  type        = number
  default     = 35

  validation {
    condition     = var.db_backup_retention_days >= 7
    error_message = "Keep at least a week of backups; damage is often noticed days later."
  }
}

variable "github_repository" {
  description = "owner/name of this repository on GitHub. The backup role trusts only jobs from its `backup` environment."
  type        = string
  default     = "Filip-Ermenkov/Service-Calculator"
}

variable "sso_saml_provider_name" {
  description = "Name of the SAML provider IAM Identity Center created in this account (IAM → Identity providers). Access Analyzer archives roles that trust it, which every SSO sign-in uses."
  type        = string
  default     = "AWSSSO_001577eee7fa1140_DO_NOT_DELETE"
}

variable "organization_management_account_id" {
  description = "The AWS Organizations management account, trusted by OrganizationAccountAccessRole. Access Analyzer archives that one expected finding."
  type        = string
  default     = "744747681339"
}
