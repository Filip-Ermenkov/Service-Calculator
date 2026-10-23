# ── Nightly logical backups of the production database ──────────────────────
#
# Neon's point-in-time restore reaches back only 6 hours on the Free plan
# (docs/PROGRESS.md step 5): damage noticed the next morning could not be
# undone. These backups cover that. Every night .github/workflows/db-backup.yml
# runs pg_dump against production and stores the dump here, OUTSIDE Neon (the
# "3-2-1" rule: a copy that does not share the primary's provider), for
# var.db_backup_retention_days.
#
# What lives here (gated by manage_db_backups):
#   • a private, TLS-only bucket whose lifecycle rule deletes dumps after the
#     retention period
#   • a role GitHub Actions can assume ONLY from this repository's `backup`
#     environment, allowed to WRITE new dumps and list them, never to read,
#     overwrite-delete or remove one. A leaked workflow token can add a file;
#     it cannot exfiltrate or destroy the backups.
#
# The database side is a read-only role (pg_read_all_data) whose URL is the
# `backup` environment's BACKUP_DATABASE_URL secret; see the README runbook.

locals {
  db_backups_enabled = var.manage_db_backups ? 1 : 0
  db_backup_bucket   = "bulbau-lu-db-backups-${var.aws_account_id}"
  # The OIDC provider already exists (the deploy role uses it); this only
  # names it.
  github_oidc_provider_arn = "arn:aws:iam::${var.aws_account_id}:oidc-provider/token.actions.githubusercontent.com"
}

resource "aws_s3_bucket" "db_backups" {
  count  = local.db_backups_enabled
  bucket = local.db_backup_bucket

  # Backups are the last line of defence; deleting the bucket must be a
  # deliberate act, not a side effect of a plan.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "db_backups" {
  count                   = local.db_backups_enabled
  bucket                  = aws_s3_bucket.db_backups[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "db_backups" {
  count  = local.db_backups_enabled
  bucket = aws_s3_bucket.db_backups[0].id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "db_backups" {
  count  = local.db_backups_enabled
  bucket = aws_s3_bucket.db_backups[0].id
  rule {
    id     = "expire-old-dumps"
    status = "Enabled"
    filter {}
    expiration {
      days = var.db_backup_retention_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_policy" "db_backups" {
  count  = local.db_backups_enabled
  bucket = aws_s3_bucket.db_backups[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.db_backups[0].arn, "${aws_s3_bucket.db_backups[0].arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.db_backups]
}

resource "aws_iam_role" "db_backup" {
  count       = local.db_backups_enabled
  name        = "bulbau-lu-db-backup"
  description = "Assumed by .github/workflows/db-backup.yml (environment: backup) to upload nightly database dumps"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "GitHubActionsBackupEnvironmentOnly"
      Effect    = "Allow"
      Principal = { Federated = local.github_oidc_provider_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          # Only a job running in the `backup` environment of this repository.
          # That environment is restricted to the main branch on GitHub's side.
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repository}:environment:backup"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "db_backup" {
  count = local.db_backups_enabled
  name  = "write-new-dumps-only"
  role  = aws_iam_role.db_backup[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "UploadDumps"
        Effect   = "Allow"
        Action   = "s3:PutObject"
        Resource = "${aws_s3_bucket.db_backups[0].arn}/production/*"
      },
      {
        # Lets the workflow prove its post-condition (the object exists, with
        # the size it uploaded) without being able to read any dump's content.
        Sid       = "ListDumps"
        Effect    = "Allow"
        Action    = "s3:ListBucket"
        Resource  = aws_s3_bucket.db_backups[0].arn
        Condition = { StringLike = { "s3:prefix" = ["production/*"] } }
      },
    ]
  })
}
