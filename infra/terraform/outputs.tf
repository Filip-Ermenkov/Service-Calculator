# Outputs. `name_servers` is the one you act on: paste these four into EuroDNS
# (Profiles → Name Server profile → apply to bulbau.lu) exactly once. Because they
# come from the reusable delegation set, they never change again.

output "name_servers" {
  description = "The four Route 53 nameservers to set at EuroDNS (stable — from the reusable delegation set)."
  value       = aws_route53_delegation_set.main.name_servers
}

output "delegation_set_id" {
  description = "Reusable delegation set ID — reference this if the zone is ever recreated so the nameservers stay identical."
  value       = aws_route53_delegation_set.main.id
}

output "zone_id" {
  description = "Route 53 hosted zone ID — SST's production `domain` block references this zone (next slice) rather than creating its own."
  value       = aws_route53_zone.main.zone_id
}

# ── SES (only meaningful when manage_ses = true) ──────────────────────────────
output "ses_identity_arn" {
  description = "ARN of the SES domain identity for bulbau.lu (empty until manage_ses = true). The SST Web function's ses:SendEmail permission is scoped to identities in this account/region."
  value       = var.manage_ses ? aws_sesv2_email_identity.domain[0].arn : ""
}

output "ses_verified_for_sending" {
  description = "SES 'verified for sending' status of the domain identity (empty until manage_ses = true). Becomes true once the in-zone DKIM records resolve — usually a few minutes after apply."
  value       = var.manage_ses ? aws_sesv2_email_identity.domain[0].verified_for_sending_status : null
}

output "ses_mail_from_domain" {
  description = "The custom MAIL FROM subdomain (empty until manage_ses = true)."
  value       = var.manage_ses ? local.ses_mail_from_domain : ""
}

# ── Uptime monitoring (only meaningful when manage_uptime_monitoring = true) ──
output "site_health_check_id" {
  description = "Route 53 health check id probing https://<domain>/api/health (empty until manage_uptime_monitoring = true). Use it to find the check in the Route 53 console."
  value       = var.manage_uptime_monitoring ? aws_route53_health_check.site[0].id : ""
}

output "ops_alerts_topic_arn_us_east_1" {
  description = "ARN of the us-east-1 SNS topic the uptime + CloudFront alarms publish to (empty until manage_uptime_monitoring = true). Its email subscription needs its OWN confirmation click, separate from the eu-central-1 topic's."
  value       = var.manage_uptime_monitoring ? aws_sns_topic.ops_alerts_us_east_1[0].arn : ""
}
