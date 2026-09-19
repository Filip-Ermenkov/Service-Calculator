# Native Terraform tests (`terraform test`) for the mail DNS in ses.tf +
# workspace-mail.tf. They run against MOCKED providers, so they need no AWS or
# Neon credentials and touch nothing live — they prove the pure value logic
# (record shapes, the >255-character DKIM split, the DMARC address rule, the
# opt-in gates) that a `terraform plan` against the real zone would otherwise
# be the first place to reveal.
#
# Run from infra/terraform:  terraform test
# (Run `terraform init -backend=false` once first if providers are not installed.)

mock_provider "aws" {}
mock_provider "aws" {
  alias = "us_east_1"
}
mock_provider "neon" {}

# Every test needs the always-required variables; per-run blocks add their own.
# The opt-in gates and the DMARC inputs are pinned here on purpose: `terraform
# test` also loads the module directory's (gitignored) terraform.tfvars, and a
# live tfvars must never change what these tests assert. `dkim_key_2048` is a realistic 2048-bit DKIM TXT value (the shape Google
# shows): the 18-character prefix + a 392-character base64 key = 410 characters,
# which must split into 255 + 155. (A test file allows no `locals`, so it is a
# file-level variable.)
variables {
  aws_account_id = "123456789012"
  alert_email    = "ops@example.test"
  domain_name    = "example.test"
  manage_ses     = true

  manage_workspace_mail    = false
  google_site_verification = ""
  google_dkim_selector     = "google"
  google_dkim_txt_value    = ""
  dmarc_policy             = "none"
  dmarc_report_address     = ""

  dkim_key_2048 = "v=DKIM1; k=rsa; p=${join("", [for i in range(392) : "A"])}"
}

run "workspace_mail_off_by_default_publishes_nothing" {
  command = plan

  assert {
    condition     = length(aws_route53_record.root_mx) == 0 && length(aws_route53_record.root_txt) == 0 && length(aws_route53_record.google_dkim) == 0
    error_message = "With manage_workspace_mail unset, no Workspace DNS record may be planned."
  }
}

run "dmarc_defaults_to_monitoring_with_an_in_domain_report_address" {
  command = plan

  assert {
    condition     = aws_route53_record.ses_dmarc[0].records == toset(["v=DMARC1; p=none; rua=mailto:dmarc@example.test"])
    error_message = "DMARC must default to p=none with rua=dmarc@<domain> — an external (gmail.com) rua is ignored by receivers."
  }
}

run "dmarc_policy_and_report_address_are_parametrised" {
  command = plan

  variables {
    dmarc_policy         = "quarantine"
    dmarc_report_address = "postmaster@example.test"
  }

  assert {
    condition     = aws_route53_record.ses_dmarc[0].records == toset(["v=DMARC1; p=quarantine; rua=mailto:postmaster@example.test"])
    error_message = "dmarc_policy / dmarc_report_address must flow into the _dmarc record verbatim."
  }
}

run "external_dmarc_report_address_is_refused" {
  command = plan

  variables {
    dmarc_report_address = "someone@gmail.com"
  }

  expect_failures = [var.dmarc_report_address]
}

run "invalid_dmarc_policy_is_refused" {
  command = plan

  variables {
    dmarc_policy = "block"
  }

  expect_failures = [var.dmarc_policy]
}

run "mx_and_spf_go_live_before_any_google_value_is_known" {
  command = plan

  variables {
    manage_workspace_mail = true
  }

  assert {
    condition     = aws_route53_record.root_mx[0].records == toset(["1 smtp.google.com"]) && aws_route53_record.root_mx[0].name == "example.test" && aws_route53_record.root_mx[0].type == "MX"
    error_message = "The root MX must be Google's single current record, 1 smtp.google.com (no trailing dot — the SES MX in ses.tf is written the same way and is known plan-clean)."
  }

  assert {
    condition     = aws_route53_record.root_txt[0].records == toset(["v=spf1 include:_spf.google.com include:amazonses.com ~all"])
    error_message = "With no verification token the root TXT must hold exactly the SPF (Google + SES, softfail)."
  }

  assert {
    condition     = length(aws_route53_record.google_dkim) == 0
    error_message = "No DKIM record may be planned while google_dkim_txt_value is empty."
  }
}

run "verification_token_joins_the_spf_in_the_one_root_txt_record" {
  command = plan

  variables {
    manage_workspace_mail    = true
    google_site_verification = "  abc123_XYZ  "
  }

  assert {
    condition = aws_route53_record.root_txt[0].records == toset([
      "v=spf1 include:_spf.google.com include:amazonses.com ~all",
      "google-site-verification=abc123_XYZ",
    ])
    error_message = "The bare token must be normalised to 'google-site-verification=<token>' and sit in the same TXT record set as the SPF (Route 53 allows one TXT set per name)."
  }
}

run "verification_value_pasted_in_full_is_kept_as_is" {
  command = plan

  variables {
    manage_workspace_mail    = true
    google_site_verification = "google-site-verification=abc123_XYZ"
  }

  assert {
    condition     = contains(aws_route53_record.root_txt[0].records, "google-site-verification=abc123_XYZ")
    error_message = "A value pasted with the prefix must not be double-prefixed."
  }
}

run "a_2048_bit_dkim_key_is_split_into_255_character_txt_strings" {
  command = plan

  variables {
    manage_workspace_mail = true
    google_dkim_txt_value = var.dkim_key_2048
  }

  assert {
    condition     = aws_route53_record.google_dkim[0].name == "google._domainkey.example.test" && aws_route53_record.google_dkim[0].type == "TXT"
    error_message = "The DKIM record must be a TXT at <selector>._domainkey.<domain>."
  }

  assert {
    condition     = length(tolist(aws_route53_record.google_dkim[0].records)[0]) == 410 + 2
    error_message = "A 410-character value must become two chunks joined by the provider's \"\" separator (412 characters in total)."
  }

  assert {
    condition     = substr(tolist(aws_route53_record.google_dkim[0].records)[0], 255, 2) == "\"\""
    error_message = "The chunk separator must sit exactly after the 255th character."
  }

  assert {
    condition     = replace(tolist(aws_route53_record.google_dkim[0].records)[0], "\"\"", "") == var.dkim_key_2048
    error_message = "Removing the separators must give back the original DKIM value unchanged."
  }
}

run "a_short_dkim_value_is_published_unsplit_and_whitespace_is_stripped" {
  command = plan

  variables {
    manage_workspace_mail = true
    google_dkim_txt_value = "v=DKIM1; k=rsa; p=ABC\nDEF"
  }

  assert {
    condition     = aws_route53_record.google_dkim[0].records == toset(["v=DKIM1; k=rsa; p=ABCDEF"])
    error_message = "A value under 255 characters must be published as one string, byte-identical to the console value except for a pasted line break, which is dropped."
  }
}

run "custom_dkim_selector_names_the_record" {
  command = plan

  variables {
    manage_workspace_mail = true
    google_dkim_selector  = "google2026"
    google_dkim_txt_value = "v=DKIM1; k=rsa; p=ABC"
  }

  assert {
    condition     = aws_route53_record.google_dkim[0].name == "google2026._domainkey.example.test"
    error_message = "The selector must be the DKIM record's first label."
  }
}

run "a_dkim_value_that_is_not_a_dkim_record_is_refused" {
  command = plan

  variables {
    manage_workspace_mail = true
    google_dkim_txt_value = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A"
  }

  expect_failures = [aws_route53_record.google_dkim[0]]
}
