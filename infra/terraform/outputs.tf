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
