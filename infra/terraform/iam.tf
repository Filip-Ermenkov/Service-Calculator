# ── GitHub Actions deploy IAM role + inline policy (IMPORT-ONLY, opt-in) ─────
#
# PURPOSE: make infra/aws/github-actions-deploy-policy.json the SINGLE SOURCE OF
# TRUTH. Today that JSON is applied to the live role by hand
# (`aws iam put-role-policy`), so the committed file can silently drift from what
# AWS actually enforces (the "file ≠ live" trap that bit twice during the account
# migration — see infra/aws/README.md). Managing the role here means `terraform
# apply` pushes the JSON verbatim, and `terraform plan` becomes a continuous
# drift-detector (file = live, provable in CI later).
#
# The role ALREADY EXISTS, so this is import-only, mirroring neon.tf:
#   • Gated by var.manage_deploy_role (default FALSE) so a first apply can't try
#     to CREATE a role whose name already exists (which would error out).
#   • prevent_destroy so Terraform can never delete the role CI depends on.
#
# ENABLE SEQUENCE (see README):
#   1. Leave manage_deploy_role = false for the initial apply.
#   2. Set manage_deploy_role = true, then:
#        terraform import 'aws_iam_role.deploy[0]'        <role-name>
#        terraform import 'aws_iam_role_policy.deploy[0]' <role-name>:<policy-name>
#   3. `terraform plan` — the trust/permission JSON is loaded via file() from the
#      committed infra/aws/*.json, so a clean plan proves file == live. Known
#      quirk: the aws provider can show a spurious inline-policy diff on the FIRST
#      plan after import; a second apply settles it (see README).

resource "aws_iam_role" "deploy" {
  count = var.manage_deploy_role ? 1 : 0

  name               = var.deploy_role_name
  assume_role_policy = file("${path.module}/../aws/github-actions-trust-policy.json")

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_iam_role_policy" "deploy" {
  count = var.manage_deploy_role ? 1 : 0

  name   = "bulbau-staging-deploy"
  role   = aws_iam_role.deploy[0].id
  policy = file("${path.module}/../aws/github-actions-deploy-policy.json")
}
