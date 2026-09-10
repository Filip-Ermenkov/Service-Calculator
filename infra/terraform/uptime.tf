# ── Uptime + edge monitoring (us-east-1 only) ───────────────────────────────
# The two failure classes NOTHING in this project could previously detect:
#
#   1. "bulbau.lu is unreachable."  DNS broken, the ACM certificate lapsed, the
#      CloudFront distribution disabled, the origin Lambda failing to start. The
#      Lambda alarms in sst.config.ts cannot see any of these — they only fire
#      when a function that DID get invoked failed.
#
#   2. "Visitors are getting 5xx at the edge."  OpenNext/Next returns a 500
#      RESPONSE without the Lambda handler throwing, so `AWS/Lambda Errors` stays
#      at zero while every visitor sees an error page (verified behaviour, not an
#      assumption — a handler that returns a 500 is a successful invocation).
#      CloudFront's own 5xxErrorRate is the only metric that sees it.
#
# WHY THIS FILE IS IN THE TERRAFORM LAYER, NOT sst.config.ts:
# CloudFront and Route 53 are global services that publish metrics ONLY to
# us-east-1, and a CloudWatch alarm can only invoke an SNS topic in its OWN
# region. The GitHub-Actions deploy role is scoped to eu-central-1 (plus a narrow
# ACM-only us-east-1 carve-out), so an `sst deploy` structurally cannot create
# these. This layer applies with administrator credentials and can.
#
# COST (verified against the Route 53 pricing page, 2026-09):
#   • health check on an AWS endpoint ....... $0.50 / month
#     (up to 50 AWS-endpoint health checks are free tier)
#   • HTTPS as an "optional feature" ........ $1.00 / month
#   • CloudWatch alarms ..................... first 10 free, then $0.10 each
#   ⇒ ~$1.00–1.50 / month on top of the €3–5 baseline in TECHSPEC §9.
#   The `search_string` optional feature (+$1.00) is deliberately NOT used: the
#   /api/health endpoint already encodes health in its STATUS CODE, so paying to
#   match a string would buy nothing.
#
# REQUEST VOLUME (why 3 regions, not the default "all"):
# Route 53 checks from every selected region independently. The default region
# set (~15 checkers) at a 30s interval is ~30 requests/minute ⇒ ~1.3M Lambda
# invocations/month, which alone would exceed Lambda's 1M/month free tier. Three
# regions is the documented MINIMUM and gives ~6 requests/minute ⇒ ~260k/month,
# comfortably free. Health is still quorum-based across those three.
#
# Everything here is gated on var.manage_uptime_monitoring so the first apply of
# this layer (and any apply before production exists) stays clean — the same
# opt-in pattern as manage_ses / manage_neon.

locals {
  uptime_enabled   = var.manage_uptime_monitoring ? 1 : 0
  cloudfront_alarm = var.manage_uptime_monitoring && var.cloudfront_distribution_id != "" ? 1 : 0
}

# A SECOND SNS topic, in us-east-1. Required, not duplication for its own sake:
# a CloudWatch alarm can only publish to a topic in the alarm's own region, and
# these alarms must be in us-east-1 (above). Same email endpoint, so the operator
# sees one inbox — but it needs its OWN confirmation click.
resource "aws_sns_topic" "ops_alerts_us_east_1" {
  count    = local.uptime_enabled
  provider = aws.us_east_1

  name = "bulbau-lu-ops-alerts-us-east-1"
}

resource "aws_sns_topic_subscription" "ops_email_us_east_1" {
  count    = local.uptime_enabled
  provider = aws.us_east_1

  topic_arn = aws_sns_topic.ops_alerts_us_east_1[0].arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# ── The uptime probe ────────────────────────────────────────────────────────
# Targets /api/health (src/app/api/health/route.ts), NOT a content page. Two
# reasons: the endpoint sets `Cache-Control: no-store`, so a passing check proves
# the ORIGIN answered rather than CloudFront replaying a cached copy; and it
# returns 503 (not 200) when the deployment is missing a required runtime secret,
# so a mis-set secret is caught rather than silently half-working.
resource "aws_route53_health_check" "site" {
  count = local.uptime_enabled

  type              = "HTTPS"
  fqdn              = var.domain_name
  port              = 443
  resource_path     = "/api/health"
  request_interval  = 30 # 30 = standard; 10 ("fast") is a paid optional feature
  failure_threshold = 3  # ~90s of consecutive failure before alarming — rides out a cold start

  # Three checker regions: the documented minimum, and what keeps the probe's own
  # Lambda invocations inside the free tier (see the header note).
  regions = ["eu-west-1", "us-east-1", "us-west-1"]

  # Route 53 sends the FQDN as the Host header; without SNI, CloudFront cannot
  # select the right certificate for a custom domain.
  enable_sni = true

  tags = {
    Name = "bulbau-lu-site-health"
  }
}

resource "aws_cloudwatch_metric_alarm" "site_unreachable" {
  count    = local.uptime_enabled
  provider = aws.us_east_1

  alarm_name        = "bulbau-lu-site-unreachable"
  alarm_description = "https://${var.domain_name}/api/health is failing from Route 53's checkers — the public site is down or the origin is not serving. Check CloudFront, the Web Lambda logs, and the ACM certificate."

  namespace   = "AWS/Route53"
  metric_name = "HealthCheckStatus"
  dimensions  = { HealthCheckId = aws_route53_health_check.site[0].id }

  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  # Route 53 publishes this metric continuously, so missing data here is itself
  # suspicious — unlike the Lambda error metrics, treat it as a breach.
  treat_missing_data = "breaching"

  alarm_actions = [aws_sns_topic.ops_alerts_us_east_1[0].arn]
  ok_actions    = [aws_sns_topic.ops_alerts_us_east_1[0].arn]
}

# ── Edge error rate ─────────────────────────────────────────────────────────
# Catches the "site answers, but with 500s" case that both the health check
# (which probes a trivial handler) and AWS/Lambda Errors (which needs a THROWN
# exception) can miss. 1% over two consecutive 5-minute windows is a deliberate
# balance: low enough to catch a real regression on a low-traffic site, high
# enough that one bot probing a bad URL doesn't page anyone.
#
# Needs the distribution id, which only exists after a production `sst deploy` —
# it is printed as the `cdnDistributionId` stack output. Set
# var.cloudfront_distribution_id to switch this one alarm on.
resource "aws_cloudwatch_metric_alarm" "cloudfront_5xx" {
  count    = local.cloudfront_alarm
  provider = aws.us_east_1

  alarm_name        = "bulbau-lu-cloudfront-5xx"
  alarm_description = "CloudFront is returning 5xx to visitors (>1% of requests). The site is reachable but broken — check the Web Lambda logs."

  namespace   = "AWS/CloudFront"
  metric_name = "5xxErrorRate"
  # CloudFront metrics are only dimensioned by DistributionId + Region=Global.
  dimensions = {
    DistributionId = var.cloudfront_distribution_id
    Region         = "Global"
  }

  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 1 # percent
  comparison_operator = "GreaterThanThreshold"
  # No traffic ⇒ no datapoints; an idle site is not a broken one.
  treat_missing_data = "notBreaching"

  alarm_actions = [aws_sns_topic.ops_alerts_us_east_1[0].arn]
  ok_actions    = [aws_sns_topic.ops_alerts_us_east_1[0].arn]
}
