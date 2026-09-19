# ── Google Workspace mailbox DNS for the client's office@<domain> (opt-in) ─────
#
# WHY THIS LIVES HERE (not in sst.config.ts): the mailbox is the client's, not
# the app's. Its DNS is foundational — the root MX and SPF must survive any app
# stage teardown, exactly like the zone, the SES identity and the deploy role.
# The app never touches it; it only ADDRESSES the mailbox (CompanyInfo.email is
# the contact form's destination and the quote email's Reply-To).
#
# HOW IT FITS WITH SES (ses.tf), which already sends AS this domain:
#   • MX     — root → Google (this file); `mail.<domain>` → SES (ses.tf). Two
#              hosts, two records, no conflict: SES's custom MAIL FROM is a
#              subdomain precisely so the root MX stays free for a mailbox.
#   • SPF    — root: Google + SES (this file); `mail.<domain>`: SES (ses.tf).
#              SES's envelope sender is mail.<domain>, so its SPF check never
#              consults the root record; `include:amazonses.com` is kept on the
#              root anyway so the record stays a truthful list of everyone who
#              may send as bulbau.lu should the custom MAIL FROM ever be removed.
#              Google recommends `~all` (softfail) for Workspace domains; the
#              enforcement decision is DMARC's, which treats ~all and -all the
#              same, while -all can make strict receivers reject legitimate
#              forwarded mail before DMARC is even evaluated.
#   • DKIM   — Google signs with `<selector>._domainkey` (a TXT, this file);
#              SES with three `<token>._domainkey` CNAMEs (ses.tf). Disjoint.
#   • DMARC  — ONE `_dmarc` record covers both senders (ses.tf, parametrised by
#              var.dmarc_policy / var.dmarc_report_address).
#
# WHAT GOOGLE REQUIRES, IN ORDER (each step is a manual action in the client's
# Admin console — see the guide that accompanies this slice):
#   1. Prove domain ownership: a TXT at the root, `google-site-verification=…`
#      (var.google_site_verification). Google shows the value under Account →
#      Domains → Manage domains → Verify domain. Trial accounts must verify
#      within 9 days or Google deletes the account.
#   2. Route mail: ONE MX record, `1 smtp.google.com` — Google's current
#      recommendation replaces the five legacy aspmx hosts. Then "Activate
#      Gmail" in the console. Up to 72 h to be recognised; usually minutes.
#   3. Sign mail: 24–72 h AFTER Gmail is active the console offers "Generate
#      new record" (Apps → Google Workspace → Gmail → Authenticate email);
#      publish it (var.google_dkim_txt_value), then "Start authentication".
# Every value is optional and gated, so the MX + SPF can go live before the
# verification token is known and the DKIM key can follow days later — three
# applies, one file.
#
# ROUTE 53 TXT MECHANICS (the part that silently breaks if done by hand):
#   • A TXT record set is unique per name+type, so EVERY root TXT value (SPF,
#     the verification token, anything later) must sit in the ONE
#     `root_txt` resource below — a second resource for the same name fails.
#   • A single TXT string is at most 255 characters. A 2048-bit DKIM key is
#     ~410, so Route 53 needs it as several quoted strings; the AWS provider's
#     documented way to express that is a literal `""` between the chunks
#     inside one record value (`"first255chars""rest"`), which `local.dkim_txt`
#     builds mechanically so nobody counts characters.
#
# Gated on var.manage_workspace_mail like every other opt-in resource here.

locals {
  workspace_mail_enabled = var.manage_workspace_mail ? 1 : 0

  # Accept the value exactly as the Admin console shows it ('google-site-
  # verification=abc…') OR just the token, and normalise to the full TXT value.
  google_site_verification_raw = trimspace(var.google_site_verification)
  google_site_verification_txt = (
    local.google_site_verification_raw == ""
    ? ""
    : startswith(local.google_site_verification_raw, "google-site-verification=")
    ? local.google_site_verification_raw
    : "google-site-verification=${local.google_site_verification_raw}"
  )

  # The root SPF: Google Workspace (the mailbox) + Amazon SES (the site).
  # `_spf.google.com` is a single flat include today; amazonses.com is one more
  # — two of the ten DNS lookups SPF allows.
  root_spf = "v=spf1 include:_spf.google.com include:amazonses.com ~all"

  # Every root TXT value in one list (see ROUTE 53 TXT MECHANICS above).
  root_txt_records = compact([
    local.root_spf,
    local.google_site_verification_txt,
  ])

  # Google's DKIM value exactly as the console shows it (the spaces after `;`
  # are kept, so `nslookup` output compares 1:1 with the console), minus any
  # line break or tab a copy-paste may have introduced (RFC 6376 §3.6.1:
  # whitespace inside the key data is ignored, so dropping it is always safe),
  # then split into ≤255-character chunks joined by the provider's `""`
  # separator. An empty value publishes nothing.
  google_dkim_value_clean = replace(trimspace(var.google_dkim_txt_value), "/[\\r\\n\\t]+/", "")
  google_dkim_chunks      = regexall(".{1,255}", local.google_dkim_value_clean)
  google_dkim_txt         = join("\"\"", local.google_dkim_chunks)
  google_dkim_enabled     = var.manage_workspace_mail && local.google_dkim_value_clean != "" ? 1 : 0
}

# ── Inbound mail: the root MX → Google ────────────────────────────────────────
resource "aws_route53_record" "root_mx" {
  count   = local.workspace_mail_enabled
  zone_id = aws_route53_zone.main.zone_id
  name    = var.domain_name
  type    = "MX"
  ttl     = 3600
  records = ["1 smtp.google.com"]
}

# ── Root TXT: SPF (+ Google's domain-verification token once known) ───────────
resource "aws_route53_record" "root_txt" {
  count   = local.workspace_mail_enabled
  zone_id = aws_route53_zone.main.zone_id
  name    = var.domain_name
  type    = "TXT"
  ttl     = 3600
  records = local.root_txt_records
}

# ── Google Workspace DKIM (published once Google has issued the key) ──────────
resource "aws_route53_record" "google_dkim" {
  count   = local.google_dkim_enabled
  zone_id = aws_route53_zone.main.zone_id
  name    = "${var.google_dkim_selector}._domainkey.${var.domain_name}"
  type    = "TXT"
  ttl     = 3600
  records = [local.google_dkim_txt]

  lifecycle {
    precondition {
      condition     = startswith(local.google_dkim_value_clean, "v=DKIM1")
      error_message = "google_dkim_txt_value must be the full TXT value Google shows, starting with 'v=DKIM1' (e.g. 'v=DKIM1; k=rsa; p=MIIB…')."
    }
  }
}
