# ── Observability: SNS alert topic + CloudWatch Lambda alarms ───────────────
# Closes the "if the app breaks, nothing tells you" gap for the compute tier.
#
# The SNS topic + email subscription are always created (cheap, no dependency).
# The alarms are OPT-IN via var.web_function_name / var.pdf_function_name: they
# reference SST-managed Lambda functions whose names aren't known until a stage
# is deployed (and the production stage isn't up until a later slice). Leaving the
# name vars empty keeps the alarm count at 0 so the first apply is clean; fill them
# after an `sst deploy` to switch the alarms on. This keeps ALL ops guardrails in
# the foundational layer without a brittle cross-tool build-time dependency.

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

# Web (Next/Payload) Lambda — any error in a 5-minute window pages the email.
resource "aws_cloudwatch_metric_alarm" "web_errors" {
  count = var.web_function_name == "" ? 0 : 1

  alarm_name          = "bulbau-lu-web-lambda-errors"
  alarm_description   = "Web (Next/Payload) Lambda reported >=1 error in 5 minutes."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = var.web_function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops_alerts.arn]
  ok_actions          = [aws_sns_topic.ops_alerts.arn]
}

# Isolated PDF Lambda — errors (Chromium render failures) …
resource "aws_cloudwatch_metric_alarm" "pdf_errors" {
  count = var.pdf_function_name == "" ? 0 : 1

  alarm_name          = "bulbau-lu-pdf-lambda-errors"
  alarm_description   = "Pdf Lambda reported >=1 error in 5 minutes."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = var.pdf_function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops_alerts.arn]
  ok_actions          = [aws_sns_topic.ops_alerts.arn]
}

# … and throttles (would mean the account concurrency ceiling is being hit —
# exactly the per-account Lambda-quota risk that drove the account migration).
resource "aws_cloudwatch_metric_alarm" "pdf_throttles" {
  count = var.pdf_function_name == "" ? 0 : 1

  alarm_name          = "bulbau-lu-pdf-lambda-throttles"
  alarm_description   = "Pdf Lambda was throttled — approaching the account concurrency ceiling."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = var.pdf_function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops_alerts.arn]
  ok_actions          = [aws_sns_topic.ops_alerts.arn]
}
