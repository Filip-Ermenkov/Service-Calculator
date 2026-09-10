# ── Observability: the account-level SNS alert topic ────────────────────────
# Closes the "if the app breaks, nothing tells you" gap. This file owns ONLY the
# account-level piece: one SNS topic (plus its confirmed email subscription) that
# everything else publishes to. It is cheap, has no dependencies, and — crucially
# — must OUTLIVE any app stage, which is what puts it in this foundational layer
# rather than in sst.config.ts (the §10.3 split-by-lifetime rule).
#
# ── WHERE THE ACTUAL ALARMS LIVE (changed 2026-09 — read this before adding one)
# Alarms are split by WHICH REGION THE METRIC EXISTS IN, which turns out to be
# the same split as ownership:
#
#   • eu-central-1 metrics → sst.config.ts.
#     The per-stage Lambda alarms (Web/Pdf Errors + Throttles) and the
#     application-level OPS_ALERT log-metric alarm are defined there, wired to
#     the real functions BY REFERENCE. They used to live here, targeting Lambda
#     names copied by hand into terraform.tfvars — which was silently fragile:
#     any change that forces Lambda replacement gives the function a new name
#     suffix, and the alarms then watch a function that no longer exists while
#     sitting permanently GREEN (treat_missing_data = notBreaching). An alarm
#     that cannot tell you it stopped working is worse than no alarm. Defining
#     them next to the resources they watch makes staleness impossible.
#
#   • us-east-1-only metrics → uptime.tf, in THIS layer.
#     CloudFront and Route 53 publish their metrics exclusively to us-east-1,
#     and an alarm's SNS action must be in the alarm's own region. The SST deploy
#     role is deliberately scoped to eu-central-1 (with a narrow ACM-only
#     us-east-1 carve-out), so those alarms cannot be created by a deploy at all
#     — they belong to this layer, which applies with administrator credentials.
#
# MIGRATION NOTE (one-time): applying this file after the SST deploy DESTROYS the
# three superseded hand-named alarms (bulbau-lu-web-lambda-errors,
# -pdf-lambda-errors, -pdf-lambda-throttles). Deploy the SST stage FIRST so the
# replacements exist, then apply here. See README → "Alarm ownership".

resource "aws_sns_topic" "ops_alerts" {
  name = "bulbau-lu-ops-alerts"
}

resource "aws_sns_topic_subscription" "ops_email" {
  topic_arn = aws_sns_topic.ops_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
  # NOTE: AWS emails a confirmation link; the subscription is 'PendingConfirmation'
  # until clicked. Terraform can't confirm it for you.
}

# NOTE on the topic's access policy: none is declared here on purpose. SNS's
# DEFAULT topic policy already allows same-account principals (including the
# CloudWatch alarm service) to publish, which is exactly what the SST-side alarms
# need — and declaring an `aws_sns_topic_policy` REPLACES that default wholesale,
# so a narrow hand-written policy would be a live risk of locking the topic's own
# owner out of managing it, in exchange for no security gain in a single-app,
# single-account setup.
#
# The cross-tool contract this establishes: sst.config.ts resolves this topic by
# NAME (`aws.sns.getTopicOutput({ name: 'bulbau-lu-ops-alerts' })`). Renaming it
# here therefore breaks the next `sst deploy` loudly (lookup fails) rather than
# silently — which is the desired failure mode. Keep the name in sync.
