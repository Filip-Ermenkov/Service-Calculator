# Native Terraform tests for db-backups.tf. Mocked providers: nothing live is
# touched. They pin what makes the backups trustworthy: the bucket is private
# and TLS-only, dumps expire on schedule, and the role GitHub Actions assumes
# can be reached only from the `backup` environment and can add dumps but never
# read, delete or overwrite-delete one.
#
# Run from infra/terraform:  terraform test

mock_provider "aws" {}
mock_provider "aws" {
  alias = "us_east_1"
}
mock_provider "neon" {}

override_resource {
  target          = aws_s3_bucket.db_backups
  override_during = plan
  values = {
    arn = "arn:aws:s3:::bulbau-lu-db-backups-123456789012"
    id  = "bulbau-lu-db-backups-123456789012"
  }
}

variables {
  aws_account_id           = "123456789012"
  alert_email              = "ops@example.test"
  domain_name              = "example.test"
  manage_uptime_monitoring = false
  manage_db_backups        = false
}

run "gate_off_creates_nothing" {
  command = plan

  assert {
    condition     = length(aws_s3_bucket.db_backups) == 0 && length(aws_iam_role.db_backup) == 0
    error_message = "With manage_db_backups = false, no backup bucket or role may be planned."
  }
}

run "bucket_is_private_tls_only_and_expires_dumps" {
  command = plan

  variables {
    manage_db_backups = true
  }

  assert {
    condition = (
      aws_s3_bucket_public_access_block.db_backups[0].block_public_acls &&
      aws_s3_bucket_public_access_block.db_backups[0].block_public_policy &&
      aws_s3_bucket_public_access_block.db_backups[0].ignore_public_acls &&
      aws_s3_bucket_public_access_block.db_backups[0].restrict_public_buckets
    )
    error_message = "The backup bucket must block every form of public access."
  }

  assert {
    condition     = strcontains(aws_s3_bucket_policy.db_backups[0].policy, "aws:SecureTransport")
    error_message = "The backup bucket must refuse requests not made over TLS."
  }

  assert {
    condition     = aws_s3_bucket_lifecycle_configuration.db_backups[0].rule[0].expiration[0].days == 35
    error_message = "Dumps must expire after db_backup_retention_days (35 by default)."
  }
}

run "role_is_reachable_only_from_the_backup_environment" {
  command = plan

  variables {
    manage_db_backups = true
  }

  assert {
    condition = (
      jsondecode(aws_iam_role.db_backup[0].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] ==
      "repo:Filip-Ermenkov/Service-Calculator:environment:backup"
    )
    error_message = "Only jobs in this repository's `backup` environment may assume the backup role."
  }

  assert {
    condition     = jsondecode(aws_iam_role.db_backup[0].assume_role_policy).Statement[0].Principal.Federated == "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    error_message = "The backup role must trust GitHub's OIDC provider in this account, nothing else."
  }
}

run "role_can_add_dumps_but_never_read_or_delete_them" {
  command = plan

  variables {
    manage_db_backups = true
  }

  assert {
    condition = toset(flatten([
      for s in jsondecode(aws_iam_role_policy.db_backup[0].policy).Statement : s.Action
    ])) == toset(["s3:PutObject", "s3:ListBucket"])
    error_message = "The backup role may only PutObject and ListBucket: no GetObject, no DeleteObject, no wildcard."
  }

  assert {
    condition = contains(
      [for s in jsondecode(aws_iam_role_policy.db_backup[0].policy).Statement : s.Resource if s.Action == "s3:PutObject"],
      "arn:aws:s3:::bulbau-lu-db-backups-123456789012/production/*"
    )
    error_message = "Uploads must be confined to the production/ prefix of the backup bucket."
  }
}

run "retention_under_a_week_is_refused" {
  command = plan

  variables {
    manage_db_backups        = true
    db_backup_retention_days = 3
  }

  expect_failures = [var.db_backup_retention_days]
}
