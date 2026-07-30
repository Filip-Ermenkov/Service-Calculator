# ── Cost guardrails: AWS Budgets ────────────────────────────────────────────
# Directly addresses the recurring cost concern in this project: "if the app
# breaks or runs away, nothing tells you." These are AWS-native, effectively free,
# and need no domain — so they are applied in this first foundational pass.
#
# Budgets read the account's billing data, which is only available in us-east-1,
# so both resources use the us_east_1 provider alias. Notifications go DIRECTLY to
# the alert email (no SNS topic required for budgets), so there is nothing else to
# wire — the address just has to accept the AWS Budgets confirmation.

resource "aws_budgets_budget" "daily_cost" {
  provider = aws.us_east_1

  name         = "bulbau-lu-daily-cost"
  budget_type  = "COST"
  limit_amount = var.daily_budget_limit
  limit_unit   = "USD"
  time_unit    = "DAILY"

  # An idle, scale-to-zero stack should cost ~$0/day, so any actual daily spend
  # over the low ceiling is an early warning of something unexpected running.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }
}

resource "aws_budgets_budget" "monthly_cost" {
  provider = aws.us_east_1

  name         = "bulbau-lu-monthly-cost"
  budget_type  = "COST"
  limit_amount = var.monthly_budget_limit
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Warn at 80% actual…
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  # …and when the month is FORECAST to exceed the ceiling (earlier signal).
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}
