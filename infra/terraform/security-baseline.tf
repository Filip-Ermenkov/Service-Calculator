# ── Account security baseline (audit trail, guardrails, threat detection) ────
#
# The AWS account had none of these until 2026-10-23: no CloudTrail trail (only
# the 90-day event history every account gets), no account-wide S3 public-access
# block, no IAM Access Analyzer and no GuardDuty. They are the first items of
# every AWS security baseline (the CIS AWS Foundations Benchmark, AWS's own
# Foundational Security Best Practices), and they cost close to nothing here.
#
# Each piece is gated like every other opt-in resource in this stack, so a fresh
# checkout's first apply never surprise-creates them:
#   manage_cloudtrail          the trail + its log bucket
#   manage_account_guardrails  account-wide S3 public-access block + Access Analyzer
#   manage_guardduty           GuardDuty + delivery of its findings to an inbox
#
# All of it is ACCOUNT-level, which is why it lives here and not in
# sst.config.ts: one trail and one detector serve every stage and must outlive
# them (TECHSPEC §10.3, the split-by-lifetime rule).

locals {
  cloudtrail_enabled = var.manage_cloudtrail ? 1 : 0
  guardrails_enabled = var.manage_account_guardrails ? 1 : 0
  guardduty_enabled  = var.manage_guardduty ? 1 : 0

  trail_name = "bulbau-lu-trail"
  # Built as a string, not read from the trail: the bucket policy below has to
  # name the trail, and the trail has to wait for the bucket policy.
  trail_arn = "arn:aws:cloudtrail:${var.aws_region}:${var.aws_account_id}:trail/${local.trail_name}"
}

# ── CloudTrail ───────────────────────────────────────────────────────────────
# Every management API call in every region, kept for var.cloudtrail_retention_days
# in a private bucket. Log-file validation signs each delivery, so a deleted or
# edited log is detectable (`aws cloudtrail validate-logs`). The first copy of
# management events is free; the cost is the S3 storage, cents a month here.
#
# It is also the input IAM Access Analyzer needs to GENERATE a least-privilege
# policy for the GitHub deploy role (PROGRESS → Housekeeping): policy generation
# reads a trail's logs, never the 90-day event history.

resource "aws_s3_bucket" "cloudtrail" {
  count  = local.cloudtrail_enabled
  bucket = "bulbau-lu-cloudtrail-${var.aws_account_id}"
}

resource "aws_s3_bucket_public_access_block" "cloudtrail" {
  count                   = local.cloudtrail_enabled
  bucket                  = aws_s3_bucket.cloudtrail[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "cloudtrail" {
  count  = local.cloudtrail_enabled
  bucket = aws_s3_bucket.cloudtrail[0].id
  rule {
    object_ownership = "BucketOwnerEnforced" # ACLs off; the bucket owner owns every log
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "cloudtrail" {
  count  = local.cloudtrail_enabled
  bucket = aws_s3_bucket.cloudtrail[0].id
  rule {
    id     = "expire-trail-logs"
    status = "Enabled"
    filter {}
    expiration {
      days = var.cloudtrail_retention_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# AWS's documented CloudTrail bucket policy, pinned to THIS trail with
# aws:SourceArn, plus a deny on any request not made over TLS.
resource "aws_s3_bucket_policy" "cloudtrail" {
  count  = local.cloudtrail_enabled
  bucket = aws_s3_bucket.cloudtrail[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AWSCloudTrailAclCheck"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:GetBucketAcl"
        Resource  = aws_s3_bucket.cloudtrail[0].arn
        Condition = { StringEquals = { "aws:SourceArn" = local.trail_arn } }
      },
      {
        Sid       = "AWSCloudTrailWrite"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.cloudtrail[0].arn}/AWSLogs/${var.aws_account_id}/*"
        Condition = {
          StringEquals = {
            "s3:x-amz-acl"  = "bucket-owner-full-control"
            "aws:SourceArn" = local.trail_arn
          }
        }
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.cloudtrail[0].arn, "${aws_s3_bucket.cloudtrail[0].arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.cloudtrail]
}

resource "aws_cloudtrail" "main" {
  count                         = local.cloudtrail_enabled
  name                          = local.trail_name
  s3_bucket_name                = aws_s3_bucket.cloudtrail[0].id
  is_multi_region_trail         = true # an attacker would use a region we don't watch
  include_global_service_events = true # IAM, CloudFront, Route 53 log as global events
  enable_log_file_validation    = true
  # No event selectors: the default is every management event, read and write.
  depends_on = [aws_s3_bucket_policy.cloudtrail]
}

# ── Guardrails ───────────────────────────────────────────────────────────────

# No bucket in this account may ever be made public, whatever its own settings
# say. Every bucket here is already private (media and assets are read through
# CloudFront's origin access control), so this changes nothing today; it makes a
# future mistake impossible rather than merely unlikely.
resource "aws_s3_account_public_access_block" "account" {
  count                   = local.guardrails_enabled
  account_id              = var.aws_account_id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Continuously lists anything in the account that is reachable from OUTSIDE it
# (a bucket, role, key or queue shared beyond the account). The account-type
# external-access analyzer is free. Expected finding: the GitHub OIDC deploy
# role, which trusts token.actions.githubusercontent.com by design. Archive it
# in the console with that reason.
resource "aws_accessanalyzer_analyzer" "account" {
  count         = local.guardrails_enabled
  analyzer_name = "bulbau-lu-account"
  type          = "ACCOUNT"
}

# ── GuardDuty ────────────────────────────────────────────────────────────────
# Threat detection over CloudTrail, DNS and network logs (stolen credentials
# used from an unusual place, crypto-mining, known-bad IPs). Priced by volume;
# roughly a few euros a month or less at this account's size.
#
# A finding nobody reads is not detection, so medium-and-above findings (4.0+)
# are emailed. They go to their OWN topic, not bulbau-lu-ops-alerts: EventBridge
# may only publish to a topic whose policy allows it, and observability.tf keeps
# the ops topic on SNS's default policy on purpose. That costs one extra
# subscription-confirmation click; it does not touch the proven alarm path.

resource "aws_guardduty_detector" "main" {
  count                        = local.guardduty_enabled
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
}

resource "aws_sns_topic" "security_findings" {
  count = local.guardduty_enabled
  name  = "bulbau-lu-security-findings"
}

resource "aws_sns_topic_subscription" "security_findings_email" {
  count     = local.guardduty_enabled
  topic_arn = aws_sns_topic.security_findings[0].arn
  protocol  = "email"
  endpoint  = var.alert_email
  # Pending until the confirmation link in AWS's email is clicked.
}

resource "aws_cloudwatch_event_rule" "guardduty_findings" {
  count       = local.guardduty_enabled
  name        = "bulbau-lu-guardduty-findings"
  description = "GuardDuty findings of medium severity or higher"
  event_pattern = jsonencode({
    source        = ["aws.guardduty"]
    "detail-type" = ["GuardDuty Finding"]
    detail        = { severity = [{ numeric = [">=", 4] }] }
  })
}

resource "aws_cloudwatch_event_target" "guardduty_findings_email" {
  count = local.guardduty_enabled
  rule  = aws_cloudwatch_event_rule.guardduty_findings[0].name
  arn   = aws_sns_topic.security_findings[0].arn

  # A readable email instead of raw event JSON.
  input_transformer {
    input_paths = {
      severity    = "$.detail.severity"
      type        = "$.detail.type"
      title       = "$.detail.title"
      description = "$.detail.description"
      region      = "$.region"
      id          = "$.detail.id"
    }
    input_template = "\"GuardDuty finding (severity <severity>) in <region>: <title>. Type: <type>. <description> Finding id: <id>. Open it in the GuardDuty console of that region.\""
  }
}

# The topic's own policy: the account keeps full control of it, and EventBridge
# may publish, from this one rule only.
resource "aws_sns_topic_policy" "security_findings" {
  count = local.guardduty_enabled
  arn   = aws_sns_topic.security_findings[0].arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountOwnsTheTopic"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${var.aws_account_id}:root" }
        Action    = "sns:*"
        Resource  = aws_sns_topic.security_findings[0].arn
      },
      {
        Sid       = "EventBridgePublishesFindings"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = "sns:Publish"
        Resource  = aws_sns_topic.security_findings[0].arn
        Condition = { ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.guardduty_findings[0].arn } }
      },
    ]
  })
}
