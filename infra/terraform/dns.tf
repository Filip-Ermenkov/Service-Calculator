# ── DNS foundation: reusable delegation set + public hosted zone ────────────
#
# WHY A REUSABLE DELEGATION SET (the key design choice):
# A hosted zone is a foundational, long-lived resource — if it is ever destroyed
# and recreated, Route 53 mints FOUR NEW nameservers, which forces a re-delegation
# at the registrar (EuroDNS), up to 48h of propagation, and a window where the
# domain resolves to nothing (a hijack risk). A *reusable delegation set* is a
# fixed group of four nameservers that is created once and costs nothing. Creating
# the zone against it means the zone can be deleted and later recreated with the
# SAME four nameservers — so EuroDNS never has to change. This is what makes the
# project's "one-click on/off at $0" goal safe: you can delete the $0.50/mo zone
# to reach literal $0 and restore it later with identical DNS.
#
# The four nameservers this produces are the values to paste into EuroDNS ONCE
# (see `terraform output name_servers` and the apply guide).

resource "aws_route53_delegation_set" "main" {
  reference_name = "bulbau-lu"

  # Never destroy: the whole point is nameserver stability across the zone's life.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_route53_zone" "main" {
  name              = var.domain_name
  delegation_set_id = aws_route53_delegation_set.main.id
  comment           = "bulbau.lu public zone — foundational (managed by infra/terraform). Do not destroy."

  # A public zone destroy is a domain-outage/hijack event. Guard it hard; a
  # deliberate teardown for the $0 "off" mode is done via `terraform destroy
  # -target` after temporarily removing this guard, never by accident.
  lifecycle {
    prevent_destroy = true
  }
}
