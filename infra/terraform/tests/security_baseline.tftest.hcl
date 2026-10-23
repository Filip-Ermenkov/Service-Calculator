# Native Terraform tests for security-baseline.tf and dns-hardening.tf. Mocked
# providers, like the other tests here: no AWS or Neon credentials, nothing live
# touched. They pin what makes each control worth having, so a later edit
# cannot quietly turn one into a control that exists but protects nothing:
# a trail that misses regions or can't prove its logs untouched, a GuardDuty
# whose findings reach nobody, a CAA that allows any CA, DNSSEC with the wrong
# kind of key.
#
# Run from infra/terraform:  terraform test
# (Run `terraform init -backend=false` once first if providers are not installed.)

mock_provider "aws" {}
mock_provider "aws" {
  alias = "us_east_1"
}
mock_provider "neon" {}

# Computed ARNs, given known values at plan time so the policies that embed
# them can be asserted on.
override_resource {
  target          = aws_s3_bucket.cloudtrail
  override_during = plan
  values = {
    arn = "arn:aws:s3:::bulbau-lu-cloudtrail-123456789012"
    id  = "bulbau-lu-cloudtrail-123456789012"
  }
}

override_resource {
  target          = aws_cloudwatch_event_rule.guardduty_findings
  override_during = plan
  values = {
    arn = "arn:aws:events:eu-central-1:123456789012:rule/bulbau-lu-guardduty-findings"
  }
}

override_resource {
  target          = aws_sns_topic.security_findings
  override_during = plan
  values = {
    arn = "arn:aws:sns:eu-central-1:123456789012:bulbau-lu-security-findings"
  }
}

override_resource {
  target          = aws_sns_topic.ops_alerts_us_east_1
  override_during = plan
  values = {
    arn = "arn:aws:sns:us-east-1:123456789012:bulbau-lu-ops-alerts-us-east-1"
  }
}

# Every gate pinned off: `terraform test` also loads the (gitignored) live
# terraform.tfvars, and that must never change what these tests assert.
variables {
  aws_account_id            = "123456789012"
  alert_email               = "ops@example.test"
  domain_name               = "example.test"
  manage_uptime_monitoring  = false
  manage_cloudtrail         = false
  manage_account_guardrails = false
  manage_guardduty          = false
  manage_caa                = false
  manage_tls_rpt            = false
  manage_dnssec             = false
}

run "gates_off_create_nothing" {
  command = plan

  assert {
    condition = (
      length(aws_cloudtrail.main) == 0 &&
      length(aws_s3_account_public_access_block.account) == 0 &&
      length(aws_accessanalyzer_analyzer.account) == 0 &&
      length(aws_guardduty_detector.main) == 0 &&
      length(aws_route53_record.caa) == 0 &&
      length(aws_route53_record.tls_rpt) == 0 &&
      length(aws_kms_key.dnssec) == 0 &&
      length(aws_route53_hosted_zone_dnssec.main) == 0
    )
    error_message = "With every gate off, none of the baseline resources may be planned."
  }
}

run "cloudtrail_covers_every_region_and_can_prove_its_logs" {
  command = plan

  variables {
    manage_cloudtrail = true
  }

  assert {
    condition = (
      aws_cloudtrail.main[0].is_multi_region_trail &&
      aws_cloudtrail.main[0].include_global_service_events &&
      aws_cloudtrail.main[0].enable_log_file_validation
    )
    error_message = "The trail must be multi-region, include global service events (IAM, CloudFront, Route 53) and validate its log files."
  }

  assert {
    condition = (
      aws_s3_bucket_public_access_block.cloudtrail[0].block_public_acls &&
      aws_s3_bucket_public_access_block.cloudtrail[0].block_public_policy &&
      aws_s3_bucket_public_access_block.cloudtrail[0].ignore_public_acls &&
      aws_s3_bucket_public_access_block.cloudtrail[0].restrict_public_buckets
    )
    error_message = "The CloudTrail log bucket must block every form of public access."
  }

  assert {
    condition     = strcontains(aws_s3_bucket_policy.cloudtrail[0].policy, "arn:aws:cloudtrail:eu-central-1:123456789012:trail/bulbau-lu-trail")
    error_message = "The bucket policy must let only THIS trail write (aws:SourceArn)."
  }

  assert {
    condition     = strcontains(aws_s3_bucket_policy.cloudtrail[0].policy, "aws:SecureTransport")
    error_message = "The bucket policy must deny requests that are not made over TLS."
  }
}

run "cloudtrail_retention_below_90_days_is_refused" {
  command = plan

  variables {
    manage_cloudtrail         = true
    cloudtrail_retention_days = 30
  }

  expect_failures = [var.cloudtrail_retention_days]
}

run "guardrails_block_public_s3_and_watch_external_access" {
  command = plan

  variables {
    manage_account_guardrails = true
  }

  assert {
    condition = (
      aws_s3_account_public_access_block.account[0].block_public_acls &&
      aws_s3_account_public_access_block.account[0].block_public_policy &&
      aws_s3_account_public_access_block.account[0].ignore_public_acls &&
      aws_s3_account_public_access_block.account[0].restrict_public_buckets
    )
    error_message = "The account-wide S3 public-access block must have all four settings on."
  }

  assert {
    condition     = aws_accessanalyzer_analyzer.account[0].type == "ACCOUNT"
    error_message = "The Access Analyzer must be the (free) account-level external-access analyzer."
  }

  assert {
    condition = (
      length(aws_accessanalyzer_archive_rule.expected) == 3 &&
      alltrue([for r in aws_accessanalyzer_archive_rule.expected : anytrue([for f in r.filter : f.criteria == "resourceType" && f.eq == tolist(["AWS::IAM::Role"])])])
    )
    error_message = "Exactly the three by-design role trusts may be archived, and only for IAM roles, so a public Lambda URL or bucket is never archived by them."
  }

  assert {
    condition = contains(
      flatten([for r in aws_accessanalyzer_archive_rule.expected : [for f in r.filter : f.eq if f.criteria == "principal.AWS"]]),
      "744747681339"
    )
    error_message = "The organization management account's trust must be archived by its exact account id."
  }
}

run "guardduty_findings_reach_an_inbox" {
  command = plan

  variables {
    manage_guardduty = true
  }

  assert {
    condition     = aws_guardduty_detector.main[0].enable
    error_message = "The GuardDuty detector must be enabled."
  }

  assert {
    condition     = aws_cloudwatch_event_target.guardduty_findings_email[0].arn == "arn:aws:sns:eu-central-1:123456789012:bulbau-lu-security-findings"
    error_message = "GuardDuty findings must be routed to the security-findings topic."
  }

  assert {
    condition     = aws_sns_topic_subscription.security_findings_email[0].protocol == "email" && aws_sns_topic_subscription.security_findings_email[0].endpoint == "ops@example.test"
    error_message = "The security-findings topic must email var.alert_email."
  }

  assert {
    condition     = strcontains(aws_sns_topic_policy.security_findings[0].policy, "arn:aws:events:eu-central-1:123456789012:rule/bulbau-lu-guardduty-findings")
    error_message = "Only the GuardDuty rule may publish to the topic (aws:SourceArn)."
  }

  # SNS rejects "sns:*" in a topic policy (the first live apply failed on it),
  # and the mocked plan cannot see that, so pin it here.
  assert {
    condition     = !strcontains(lower(aws_sns_topic_policy.security_findings[0].policy), "\"sns:*\"")
    error_message = "A topic policy may not use \"sns:*\"; SNS rejects it as out of service scope. List the actions."
  }

  assert {
    condition     = jsondecode(aws_cloudwatch_event_rule.guardduty_findings[0].event_pattern).detail.severity[0].numeric[1] == 4
    error_message = "Findings from severity 4 (medium) upwards must be emailed."
  }
}

run "caa_allows_only_amazon_and_no_wildcards" {
  command = plan

  variables {
    manage_caa = true
  }

  assert {
    condition = (
      contains(aws_route53_record.caa[0].records, "0 issue \"amazon.com\"") &&
      contains(aws_route53_record.caa[0].records, "0 issuewild \";\"") &&
      length([for r in aws_route53_record.caa[0].records : r if startswith(r, "0 issue ")]) == 1
    )
    error_message = "CAA must name exactly one issuer (amazon.com, which ACM accepts) and forbid wildcard certificates."
  }

  assert {
    condition     = aws_route53_record.caa[0].name == "example.test"
    error_message = "CAA must sit at the apex, so it covers every subdomain too."
  }
}

run "tls_rpt_reports_to_a_mailbox_on_the_domain" {
  command = plan

  variables {
    manage_tls_rpt = true
  }

  assert {
    condition = (
      aws_route53_record.tls_rpt[0].name == "_smtp._tls.example.test" &&
      aws_route53_record.tls_rpt[0].records == toset(["v=TLSRPTv1; rua=mailto:dmarc@example.test"])
    )
    error_message = "TLS-RPT must be published at _smtp._tls and report to the DMARC mailbox on the domain."
  }
}

run "dnssec_uses_the_key_route53_requires" {
  command = plan

  variables {
    manage_dnssec            = true
    manage_uptime_monitoring = true
  }

  assert {
    condition = (
      aws_kms_key.dnssec[0].customer_master_key_spec == "ECC_NIST_P256" &&
      aws_kms_key.dnssec[0].key_usage == "SIGN_VERIFY"
    )
    error_message = "Route 53 DNSSEC needs an asymmetric ECC_NIST_P256 SIGN_VERIFY key."
  }

  assert {
    condition     = aws_route53_key_signing_key.main[0].status == "ACTIVE" && aws_route53_hosted_zone_dnssec.main[0].signing_status == "SIGNING"
    error_message = "The key-signing key must be ACTIVE and the zone SIGNING."
  }

  assert {
    condition     = strcontains(aws_kms_key.dnssec[0].policy, "dnssec-route53.amazonaws.com")
    error_message = "The key policy must let Route 53's DNSSEC service use the key."
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.dnssec_internal_failure[0].alarm_actions == toset(["arn:aws:sns:us-east-1:123456789012:bulbau-lu-ops-alerts-us-east-1"]) &&
      aws_cloudwatch_metric_alarm.dnssec_ksk_action_needed[0].alarm_actions == toset(["arn:aws:sns:us-east-1:123456789012:bulbau-lu-ops-alerts-us-east-1"])
    )
    error_message = "Both DNSSEC alarms must notify the us-east-1 ops topic, where Route 53 publishes these metrics."
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.dnssec_internal_failure[0].treat_missing_data == "missing" &&
      aws_cloudwatch_metric_alarm.dnssec_ksk_action_needed[0].treat_missing_data == "missing"
    )
    error_message = "DNSSEC alarms must never read missing data as OK."
  }
}
