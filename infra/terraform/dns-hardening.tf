# ── DNS hardening: CAA, TLS-RPT, DNSSEC ──────────────────────────────────────
#
# Three independent records/settings on the bulbau.lu zone, each gated:
#   manage_caa      which certificate authorities may issue for the domain
#   manage_tls_rpt  where mail servers report TLS failures delivering to us
#   manage_dnssec   cryptographically signed answers for the whole zone

locals {
  caa_enabled     = var.manage_caa ? 1 : 0
  tls_rpt_enabled = var.manage_tls_rpt ? 1 : 0
  dnssec_enabled  = var.manage_dnssec ? 1 : 0
}

# ── CAA ──────────────────────────────────────────────────────────────────────
# Only Amazon may issue certificates for bulbau.lu and its subdomains, and no one
# may issue a wildcard. Every certificate this project uses comes from ACM (the
# CloudFront certificate SST creates), which accepts any of amazon.com,
# amazontrust.com, awstrust.com or amazonaws.com; "amazon.com" is the one AWS
# documents. A CA that is asked for a certificate it may not issue reports it to
# the iodef address.
#
# If another CA is ever needed (a different CDN, a mail service with its own
# certificate on a subdomain), add an `issue` line here FIRST, or that CA will
# refuse.
resource "aws_route53_record" "caa" {
  count   = local.caa_enabled
  zone_id = aws_route53_zone.main.zone_id
  name    = var.domain_name
  type    = "CAA"
  ttl     = 3600
  records = [
    "0 issue \"amazon.com\"",
    "0 issuewild \";\"",
    "0 iodef \"mailto:${local.dmarc_report_address}\"",
  ]
}

# ── TLS-RPT (RFC 8460) ───────────────────────────────────────────────────────
# Mail servers that fail to set up TLS when delivering to bulbau.lu (Google
# Workspace) send a daily report here. Same mailbox as the DMARC reports
# (ses.tf), which already exists and is already under the domain.
resource "aws_route53_record" "tls_rpt" {
  count   = local.tls_rpt_enabled
  zone_id = aws_route53_zone.main.zone_id
  name    = "_smtp._tls.${var.domain_name}"
  type    = "TXT"
  ttl     = 3600
  records = ["v=TLSRPTv1; rua=mailto:${local.dmarc_report_address}"]
}

# ── DNSSEC ───────────────────────────────────────────────────────────────────
# Route 53 signs the zone with a key-signing key held in KMS. Route 53 requires
# that key to be an asymmetric ECC_NIST_P256 key in us-east-1, whatever the
# zone's region. The KMS key costs about $1/month.
#
# Signing alone protects nothing: resolvers only validate once the parent zone
# (.lu, via the registrar EuroDNS) publishes our DS record. The ORDER matters,
# and getting it wrong takes the domain offline:
#   1. apply this (signing starts)
#   2. wait at least the zone's longest TTL (2 days is safe: the .lu NS TTL)
#   3. add `terraform output dnssec_ds_record` at EuroDNS
# To turn DNSSEC OFF: remove the DS at EuroDNS FIRST, wait 2 days, then
# disable signing. Never delete the KMS key while a DS record points at it.
# That is why the key carries prevent_destroy.

resource "aws_kms_key" "dnssec" {
  count    = local.dnssec_enabled
  provider = aws.us_east_1

  description              = "Route 53 DNSSEC key-signing key for ${var.domain_name}"
  customer_master_key_spec = "ECC_NIST_P256"
  key_usage                = "SIGN_VERIFY"
  deletion_window_in_days  = 30

  # AWS's documented key policy for Route 53 DNSSEC, scoped to this account.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowRoute53DnssecService"
        Effect    = "Allow"
        Principal = { Service = "dnssec-route53.amazonaws.com" }
        Action    = ["kms:DescribeKey", "kms:GetPublicKey", "kms:Sign"]
        Resource  = "*"
        Condition = {
          StringEquals = { "aws:SourceAccount" = var.aws_account_id }
          ArnLike      = { "aws:SourceArn" = "arn:aws:route53:::hostedzone/*" }
        }
      },
      {
        Sid       = "AllowRoute53DnssecToCreateGrant"
        Effect    = "Allow"
        Principal = { Service = "dnssec-route53.amazonaws.com" }
        Action    = "kms:CreateGrant"
        Resource  = "*"
        Condition = { Bool = { "kms:GrantIsForAWSResource" = "true" } }
      },
      {
        Sid       = "EnableIamPermissions"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${var.aws_account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
    ]
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "dnssec" {
  count         = local.dnssec_enabled
  provider      = aws.us_east_1
  name          = "alias/bulbau-lu-dnssec"
  target_key_id = aws_kms_key.dnssec[0].key_id
}

resource "aws_route53_key_signing_key" "main" {
  count                      = local.dnssec_enabled
  hosted_zone_id             = aws_route53_zone.main.id
  key_management_service_arn = aws_kms_key.dnssec[0].arn
  name                       = "bulbau_lu_ksk"
  status                     = "ACTIVE"
}

resource "aws_route53_hosted_zone_dnssec" "main" {
  count          = local.dnssec_enabled
  hosted_zone_id = aws_route53_key_signing_key.main[0].hosted_zone_id
  signing_status = "SIGNING"
}

# The two failure signals AWS recommends watching once a zone is signed: an
# internal signing failure, and a key-signing key that needs action (for
# example, KMS access lost). Either one, left alone, ends in validating
# resolvers refusing the domain. Route 53 publishes these in us-east-1 only, so
# they notify the us-east-1 ops topic, which exists when uptime monitoring is on.
resource "aws_cloudwatch_metric_alarm" "dnssec_internal_failure" {
  count    = local.dnssec_enabled
  provider = aws.us_east_1

  alarm_name          = "bulbau-lu-dnssec-internal-failure"
  alarm_description   = "Route 53 could not sign the bulbau.lu zone. Check the DNSSEC page of the hosted zone NOW: validating resolvers will start refusing the domain."
  namespace           = "AWS/Route53"
  metric_name         = "DNSSECInternalFailure"
  dimensions          = { HostedZoneId = aws_route53_zone.main.zone_id }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  # "missing", never "notBreaching": with no data the alarm shows
  # INSUFFICIENT_DATA ("watching nothing") instead of a reassuring green.
  treat_missing_data = "missing"
  alarm_actions      = aws_sns_topic.ops_alerts_us_east_1[*].arn
}

resource "aws_cloudwatch_metric_alarm" "dnssec_ksk_action_needed" {
  count    = local.dnssec_enabled
  provider = aws.us_east_1

  alarm_name          = "bulbau-lu-dnssec-ksk-action-needed"
  alarm_description   = "A DNSSEC key-signing key of bulbau.lu needs action (usually lost access to its KMS key in us-east-1). Fix it before the zone's signatures expire."
  namespace           = "AWS/Route53"
  metric_name         = "DNSSECKeySigningKeysNeedingAction"
  dimensions          = { HostedZoneId = aws_route53_zone.main.zone_id }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = aws_sns_topic.ops_alerts_us_east_1[*].arn
}
