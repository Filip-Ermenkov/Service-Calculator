# Terraform + provider version constraints and remote state backend.
#
# WHY THIS STACK EXISTS (read infra/terraform/README.md first):
# This is the *foundational* IaC layer — long-lived, stateful resources that
# must OUTLIVE any app deploy and therefore must NOT be owned by the removable
# SST app stage (sst.config.ts). Per this repo's stated architecture (see the
# comment at the top of sst.config.ts), SST owns app-native AWS components while
# "standalone Terraform (for anything outside SST's native components, e.g. the
# Neon project/branch itself) lives in infra/". This directory finally makes
# that true. It manages: the Route 53 public hosted zone (+ reusable delegation
# set for stable nameservers), the Neon project/branch, the GitHub-Actions deploy
# IAM role, and the account cost/observability guardrails.

terraform {
  # >= 1.11 required for NATIVE S3 state locking (use_lockfile) — no DynamoDB
  # table needed. DynamoDB-based locking is deprecated as of 2026 and slated for
  # removal in a future Terraform minor. See README "State backend".
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.60, < 7.0"
    }
    # Neon-sponsored, community-maintained provider (the one Neon's own docs point
    # at: neon.com/docs/reference/terraform). Not officially supported by Neon, so
    # the Neon resources here are deliberately import-only + prevent_destroy +
    # feature-flagged off by default (var.manage_neon) — see neon.tf.
    neon = {
      source  = "kislerdm/neon"
      version = ">= 0.6.0"
    }
  }

  # Remote state in S3 with NATIVE locking. The bucket must be created ONCE,
  # out-of-band, BEFORE `terraform init` (a backend can't create its own bucket —
  # the classic chicken-and-egg). The exact bootstrap command is in the README.
  #
  # Backend blocks cannot use variables/interpolation, so these are literals.
  backend "s3" {
    bucket       = "bulbau-lu-tfstate"
    key          = "foundational/terraform.tfstate"
    region       = "eu-central-1"
    encrypt      = true
    use_lockfile = true # S3-native lock object (.tflock) beside the state file
  }
}
