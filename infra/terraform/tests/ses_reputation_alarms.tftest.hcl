# Native Terraform tests (`terraform test`) for the SES reputation alarms in
# ses-reputation.tf. Mocked providers, like mail_dns.tftest.hcl: no AWS or Neon
# credentials, nothing live touched. They pin the properties that make these
# alarms worth having — the opt-in gate, thresholds strictly below AWS's review
# points, a missing-data treatment that cannot sit green while watching nothing,
# and delivery to the eu-central-1 ops topic — so a later edit cannot quietly
# turn them into an alarm that never fires, always fires, or notifies nobody.
#
# Run from infra/terraform:  terraform test
# (Run `terraform init -backend=false` once first if providers are not installed.)

mock_provider "aws" {}
mock_provider "aws" {
  alias = "us_east_1"
}
mock_provider "neon" {}

# The topic's ARN is computed, so a mocked plan would leave it unknown and the
# wiring assertion could not be evaluated. Give it a known value at plan time —
# shaped like the real eu-central-1 topic, so the assertion below also shows
# which topic (not the us-east-1 one in uptime.tf) the alarms notify.
override_resource {
  target          = aws_sns_topic.ops_alerts
  override_during = plan
  values = {
    arn = "arn:aws:sns:eu-central-1:123456789012:bulbau-lu-ops-alerts"
  }
}

# The gate is pinned here on purpose: `terraform test` also loads the module
# directory's (gitignored) terraform.tfvars, and a live tfvars must never change
# what these tests assert. Each run sets the gate it is about.
variables {
  aws_account_id               = "123456789012"
  alert_email                  = "ops@example.test"
  domain_name                  = "example.test"
  manage_ses_reputation_alarms = false
  manage_uptime_monitoring     = false
}

run "gate_off_creates_no_reputation_alarm" {
  command = plan

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.ses_bounce_rate) == 0 && length(aws_cloudwatch_metric_alarm.ses_complaint_rate) == 0
    error_message = "With manage_ses_reputation_alarms = false, no SES reputation alarm may be planned."
  }
}

run "gate_on_creates_both_alarms_on_the_account_level_metrics" {
  command = plan

  variables {
    manage_ses_reputation_alarms = true
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.ses_bounce_rate) == 1 && length(aws_cloudwatch_metric_alarm.ses_complaint_rate) == 1
    error_message = "With manage_ses_reputation_alarms = true, exactly one bounce-rate and one complaint-rate alarm must be planned."
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.ses_bounce_rate[0].namespace == "AWS/SES" &&
      aws_cloudwatch_metric_alarm.ses_bounce_rate[0].metric_name == "Reputation.BounceRate" &&
      aws_cloudwatch_metric_alarm.ses_complaint_rate[0].namespace == "AWS/SES" &&
      aws_cloudwatch_metric_alarm.ses_complaint_rate[0].metric_name == "Reputation.ComplaintRate"
    )
    error_message = "The alarms must watch AWS/SES Reputation.BounceRate and Reputation.ComplaintRate."
  }

  assert {
    condition     = try(length(aws_cloudwatch_metric_alarm.ses_bounce_rate[0].dimensions), 0) == 0 && try(length(aws_cloudwatch_metric_alarm.ses_complaint_rate[0].dimensions), 0) == 0
    error_message = "The account-level reputation metrics carry no dimensions; any dimension selects a metric that does not exist, and the alarm would watch nothing."
  }
}

run "thresholds_sit_strictly_below_the_points_where_aws_reviews_the_account" {
  command = plan

  variables {
    manage_ses_reputation_alarms = true
  }

  # Values are fractions. AWS reviews at 5% bounce / 0.1% complaint; an alarm at
  # or above those arrives with AWS's notice instead of before it. A threshold of
  # 0 with >= would be ALARM on every healthy reading of 0.
  assert {
    condition     = aws_cloudwatch_metric_alarm.ses_bounce_rate[0].threshold > 0 && aws_cloudwatch_metric_alarm.ses_bounce_rate[0].threshold < 0.05
    error_message = "The bounce-rate threshold must be a fraction above 0 and below 0.05 (AWS's 5% review point)."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.ses_complaint_rate[0].threshold > 0 && aws_cloudwatch_metric_alarm.ses_complaint_rate[0].threshold < 0.001
    error_message = "The complaint-rate threshold must be a fraction above 0 and below 0.001 (AWS's 0.1% review point)."
  }

  assert {
    condition = alltrue([
      for alarm in [aws_cloudwatch_metric_alarm.ses_bounce_rate[0], aws_cloudwatch_metric_alarm.ses_complaint_rate[0]] :
      contains(["GreaterThanOrEqualToThreshold", "GreaterThanThreshold"], alarm.comparison_operator)
    ])
    error_message = "A reputation alarm must fire when the rate rises above its threshold, not when it falls below."
  }
}

run "missing_data_is_reported_as_insufficient_data_never_as_ok_or_alarm" {
  command = plan

  variables {
    manage_ses_reputation_alarms = true
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.ses_bounce_rate[0].treat_missing_data == "missing" && aws_cloudwatch_metric_alarm.ses_complaint_rate[0].treat_missing_data == "missing"
    error_message = "treat_missing_data must be \"missing\": notBreaching and ignore can sit green while watching nothing (TECHSPEC §10.3), and breaching fires before SES has sent anything."
  }

  # Under "missing", a quiet spell moves the alarm OK -> INSUFFICIENT_DATA -> OK.
  # Notifying on those transitions would email on every quiet hour if SES
  # publishes the metric only around sends — see ses-reputation.tf.
  assert {
    condition = alltrue([
      for alarm in [aws_cloudwatch_metric_alarm.ses_bounce_rate[0], aws_cloudwatch_metric_alarm.ses_complaint_rate[0]] :
      try(length(alarm.ok_actions), 0) == 0 && try(length(alarm.insufficient_data_actions), 0) == 0
    ])
    error_message = "ok_actions and insufficient_data_actions must stay unset until the metric's publication cadence is confirmed (README → SES reputation alarms)."
  }
}

run "alarms_notify_the_eu_central_1_ops_topic" {
  command = plan

  variables {
    manage_ses_reputation_alarms = true
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.ses_bounce_rate[0].alarm_actions == toset([aws_sns_topic.ops_alerts.arn]) &&
      aws_cloudwatch_metric_alarm.ses_complaint_rate[0].alarm_actions == toset([aws_sns_topic.ops_alerts.arn])
    )
    error_message = "Both alarms must notify exactly the eu-central-1 ops topic (aws_sns_topic.ops_alerts); an alarm can only publish to a topic in its own region, and the us-east-1 topic in uptime.tf is the wrong one."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.ses_bounce_rate[0].alarm_actions == toset(["arn:aws:sns:eu-central-1:123456789012:bulbau-lu-ops-alerts"])
    error_message = "The topic override did not apply at plan time, so the wiring assertion above proved nothing."
  }
}
