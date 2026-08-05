# ── SES sending identity for bulbau.lu (Phase 4 part 2 — quote-by-email) ──────
#
# WHY THIS LIVES IN TERRAFORM (not sst.config.ts):
# A verified SES DOMAIN identity is a long-lived, DNS-anchored resource — its
# DKIM/SPF/DMARC records live in the Route 53 zone this same layer owns, and it
# must OUTLIVE any app stage teardown (an `sst remove` must never de-verify the
# sending domain). So it belongs to the foundational layer, exactly like the
# hosted zone and the deploy role. The app only *sends* through it at runtime
# (ses:SendEmail, granted to the Web function in sst.config.ts) — it never
# creates or owns the identity. Same two-layer split as the production domain.
#
# WHAT THIS PROVISIONS (all in one `terraform apply`, since the DNS is in-zone):
#   1. The domain identity for bulbau.lu with Easy DKIM (2048-bit).
#   2. The three DKIM CNAME records → SES auto-verifies within minutes.
#   3. A custom MAIL FROM subdomain (mail.bulbau.lu) so the envelope/Return-Path
#      aligns to the domain (better deliverability + a clean DMARC posture) with
#      its required MX + SPF records.
#   4. A DMARC policy record (p=none to start — monitor before enforcing).
#
# AFTER APPLY: the identity verifies automatically (DNS is in-zone). Then set the
# SST `EmailSender` secret to an address at this domain (e.g. quotes@bulbau.lu)
# and — to send to arbitrary visitor addresses — request SES PRODUCTION ACCESS
# (the sandbox only delivers to verified recipients). See the manual guide.
#
# Feature-flagged like the other opt-in resources so a first apply on a checkout
# that isn't ready doesn't surprise-create; flip manage_ses = true to provision.

locals {
  # Custom MAIL FROM subdomain. Kept as a local (not read back off the
  # mail_from_attributes resource, which exports no additional attributes) so the
  # MX/SPF record names below are unambiguous regardless of provider version.
  ses_mail_from_domain = "mail.${var.domain_name}"
}

# ── The domain identity + Easy DKIM ──────────────────────────────────────────
resource "aws_sesv2_email_identity" "domain" {
  count          = var.manage_ses ? 1 : 0
  email_identity = var.domain_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

# The three Easy-DKIM CNAMEs. SES verifies the identity once these resolve; since
# they're created in the same zone in the same apply, verification is automatic.
resource "aws_route53_record" "ses_dkim" {
  count   = var.manage_ses ? 3 : 0
  zone_id = aws_route53_zone.main.zone_id
  name    = "${aws_sesv2_email_identity.domain[0].dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain_name}"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_sesv2_email_identity.domain[0].dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

# ── Custom MAIL FROM subdomain (mail.bulbau.lu) ──────────────────────────────
# Aligns the Return-Path/envelope sender to the domain (SPF alignment) instead of
# the default amazonses.com — a cleaner DMARC posture and better deliverability.
resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  count                  = var.manage_ses ? 1 : 0
  email_identity         = aws_sesv2_email_identity.domain[0].email_identity
  mail_from_domain       = local.ses_mail_from_domain
  # If the MX below ever fails to resolve, fall back to amazonses.com rather than
  # rejecting the send — availability over strict alignment for a transactional
  # quote email.
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

# MX for the MAIL FROM subdomain → SES's regional feedback endpoint.
# depends_on the attributes resource so the subdomain is registered with SES
# before its DNS is published (ordering only; USE_DEFAULT_VALUE means a missing
# MX degrades gracefully rather than failing the send).
resource "aws_route53_record" "ses_mail_from_mx" {
  count      = var.manage_ses ? 1 : 0
  zone_id    = aws_route53_zone.main.zone_id
  name       = local.ses_mail_from_domain
  type       = "MX"
  ttl        = 600
  records    = ["10 feedback-smtp.${var.aws_region}.amazonses.com"]
  depends_on = [aws_sesv2_email_identity_mail_from_attributes.domain]
}

# SPF for the MAIL FROM subdomain — authorises Amazon SES to send for it.
resource "aws_route53_record" "ses_mail_from_spf" {
  count      = var.manage_ses ? 1 : 0
  zone_id    = aws_route53_zone.main.zone_id
  name       = local.ses_mail_from_domain
  type       = "TXT"
  ttl        = 600
  records    = ["v=spf1 include:amazonses.com -all"]
  depends_on = [aws_sesv2_email_identity_mail_from_attributes.domain]
}

# ── DMARC ────────────────────────────────────────────────────────────────────
# Start at p=none (monitor-only) so a misconfiguration can't silently drop mail;
# aggregate reports go to the alert address. Tighten to quarantine/reject only
# after confirming DKIM+SPF pass on real sends (a deliberate later change).
resource "aws_route53_record" "ses_dmarc" {
  count   = var.manage_ses ? 1 : 0
  zone_id = aws_route53_zone.main.zone_id
  name    = "_dmarc.${var.domain_name}"
  type    = "TXT"
  ttl     = 600
  records = ["v=DMARC1; p=none; rua=mailto:${var.alert_email}; fo=1"]
}
