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
  value       = var.manage_ses ? aws_sesv2_email_identity_mail_from_attributes.domain[0].mail_from_domain : ""
}
