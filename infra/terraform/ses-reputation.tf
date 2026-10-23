# ── SES sender-reputation alarms (account-level, eu-central-1) ──────────────
# Closes the gap between "SES accepted the send" and "AWS has paused sending".
# Nothing else in this project can see a rising bounce or complaint rate: every
# send succeeds from the Lambda's point of view, so no Lambda metric moves, and
# AWS's own "your account is under review" notice goes to the AWS ACCOUNT's
# email address, which is not necessarily the ops inbox. These two alarms put
# the warning in the ops inbox first.
#
# WHY THIS FILE IS IN THE TERRAFORM LAYER, NOT sst.config.ts:
# SES reputation is ACCOUNT-level. Staging and production send through the
# same AWS account, so there is one bounce rate and one complaint rate, not one
# per stage. A per-stage SST alarm would
# be created twice and removed by `sst remove` of either stage — the
# split-by-lifetime rule (TECHSPEC §10.3) puts it here, beside the SNS topic it
# notifies. The metric lives in eu-central-1 (the region SES sends from), so
# this uses the default provider and the eu-central-1 topic in observability.tf.
#
# ── Thresholds (checked against AWS's SES docs, 2026-10-23) ──────────────────
# AWS's enforcement points, from the "Sending review process FAQs":
#
#                  under review at   sending paused at   AWS: "for best results"
#   bounce rate         5%                10%                 below 2%
#   complaint rate      0.1%              0.5%                below 0.1%
#
# AWS's alarm guide ("Creating reputation monitoring alarms using CloudWatch")
# suggests alarming at >= 0.05 and >= 0.001 — but those ARE the review points,
# so an alarm there arrives together with AWS's review notice, not before it.
# The point of these alarms is to arrive before, so both sit below:
#
#   • bounce    >= 0.02   (2%)   — AWS's own "best results" ceiling; 60%
#                                  headroom below the 5% review point.
#   • complaint >= 0.0005 (0.05%) — half the review point. AWS gives no
#                                  separate best-practice line for complaints
#                                  (it is the review point itself), so halve it.
#
# The metric values are FRACTIONS (0.05 = 5%), not percentages.
#
# What that means at THIS site's volume: AWS computes both rates over a
# "representative volume" of recent mail, not a fixed time window, and this
# site sends little (quote emails, contact relays, password resets). One hard
# bounce — a visitor mistyping their own address in the quote form — can be
# several percent on its own, and any single complaint is far above 0.05%. So
# in practice these alarms mean "a bounce pattern has started" and "someone
# marked our mail as spam". Both are real, actionable events at this volume,
# not noise: if the representative volume is around 100 messages, five
# mistyped addresses put the account under review.
#
# ── Missing data: "missing" (the CloudWatch default), chosen deliberately ────
# These metrics only exist once the account has sent mail, and AWS does not
# document how often SES publishes them. The four options:
#
#   • notBreaching — no data reads as OK. Exactly the failure this project
#     already corrected once (TECHSPEC §10.3): an alarm that sits GREEN while
#     watching nothing. Ruled out.
#   • breaching    — no data reads as ALARM, so the alarm would fire on create
#     before the first send, and after every quiet spell if publication is
#     sporadic. An alarm that fires wrongly trains the inbox to ignore it.
#     Ruled out.
#   • ignore       — AWS's suggestion. Holds the LAST state through a gap, so
#     once it has been OK it stays OK indefinitely after the metric stops:
#     silently green again, just later. Ruled out.
#   • missing      — no data in the evaluation range reads as
#     INSUFFICIENT_DATA. The console says "watching nothing" in so many words,
#     and a breaching datapoint still moves it straight to ALARM. Chosen.
#
# What "missing" costs, and why ok_actions / insufficient_data_actions are NOT
# set: if SES publishes only around sends, these alarms will move
# OK → INSUFFICIENT_DATA → OK on a quiet day. With ok_actions that would email
# "OK" after every quiet hour; with insufficient_data_actions, every quiet hour
# itself. Until the publication cadence has been read off the live metric
# (README → "SES reputation alarms" step 4), only ALARM notifies — which is
# also all AWS's guide configures. INSUFFICIENT_DATA is instead caught by the
# monitoring-proof step in docs/PROGRESS.md, which checks every alarm for it.
#
# COST: $0.10 per alarm-month past the account's 10 free alarms, which this
# account is already past (5 SST alarms × 2 stages + 2 in uptime.tf) — so
# ≈ $0.20/month.
#
# Gated on var.manage_ses_reputation_alarms (default false) like every other
# opt-in resource here. It is independent of manage_ses: reputation belongs to
# the account, whichever way its identities were created.

locals {
  ses_reputation_alarms = var.manage_ses_reputation_alarms ? 1 : 0
}

resource "aws_cloudwatch_metric_alarm" "ses_bounce_rate" {
  count = local.ses_reputation_alarms

  alarm_name        = "bulbau-lu-ses-bounce-rate"
  alarm_description = "SES account bounce rate is at or above 2% (AWS reviews the account at 5% and may pause sending at 10%). Usually mistyped visitor addresses in the quote form: check the SES reputation dashboard and the account-level suppression list."

  # Account-level reputation metric: no dimensions. (The per-configuration-set
  # variant carries ses:configuration-set; this project uses none.)
  namespace   = "AWS/SES"
  metric_name = "Reputation.BounceRate"

  statistic           = "Maximum" # the worst reading in the hour, not an average that can hide it
  period              = 3600
  evaluation_periods  = 1
  threshold           = 0.02 # a fraction: 2%
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "missing"

  alarm_actions = [aws_sns_topic.ops_alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "ses_complaint_rate" {
  count = local.ses_reputation_alarms

  alarm_name        = "bulbau-lu-ses-complaint-rate"
  alarm_description = "SES account complaint rate is at or above 0.05% (AWS reviews the account at 0.1% and may pause sending at 0.5%). At this site's volume that means a recipient marked our mail as spam: check which email it was and why it was unwanted."

  namespace   = "AWS/SES"
  metric_name = "Reputation.ComplaintRate"

  statistic           = "Maximum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 0.0005 # a fraction: 0.05%
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "missing"

  alarm_actions = [aws_sns_topic.ops_alerts.arn]
}
