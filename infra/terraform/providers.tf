# Provider configuration.

# Primary provider — the app's home region.
provider "aws" {
  region = var.aws_region

  # HARD SAFETY RAIL: refuse to run against any account other than the intended
  # dedicated one. `sst remove`/`terraform apply` targeting the wrong account is
  # the single most dangerous mistake in this project (see docs/PROGRESS.md
  # "AWS account migration"), so we fail fast if the active credentials resolve
  # to a different account.
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      Project   = "bulbau-lu"
      ManagedBy = "terraform"
      Layer     = "foundational"
    }
  }
}

# AWS Budgets and the billing metrics they read live in us-east-1 only. A second
# provider aliased to us-east-1 is the conventional way to place budget resources
# there while the rest of the stack stays in eu-central-1.
provider "aws" {
  alias               = "us_east_1"
  region              = "us-east-1"
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      Project   = "bulbau-lu"
      ManagedBy = "terraform"
      Layer     = "foundational"
    }
  }
}

# Neon (Postgres) provider. The API key is supplied via TF_VAR_neon_api_key (or a
# gitignored terraform.tfvars) — never committed. Only needed when
# var.manage_neon = true.
#
# IMPORTANT: Terraform configures this provider even when NO neon resources are in
# the plan, because the neon_project block exists in config with count = 0 (a
# count-0 resource still binds its provider). The kislerdm/neon provider errors on
# an empty api_key at configure time, which would otherwise break the safe first
# apply (manage_neon = false, no Neon key yet). So fall back to a harmless sentinel
# when the key is absent: it is NEVER used, because no neon_* resource exists until
# manage_neon = true — at which point you must supply the real key.
provider "neon" {
  api_key = var.neon_api_key != "" ? var.neon_api_key : "unused-until-manage-neon-enabled"
}
