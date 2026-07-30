# ── Neon Postgres project (IMPORT-ONLY, opt-in) ─────────────────────────────
#
# ⚠️  DANGER / READ BEFORE ENABLING ⚠️
# The Neon project ALREADY EXISTS and holds the app's live data. This resource is
# strictly for bringing that existing project UNDER Terraform via `terraform
# import` — never to create one. It is:
#   • Gated by var.manage_neon (default FALSE) so a first `terraform apply` can
#     NOT create a second, duplicate project by accident.
#   • Guarded by prevent_destroy so Terraform can never delete the database.
#
# ENABLE SEQUENCE (see README "Importing existing resources"):
#   1. Leave manage_neon = false for the initial apply (zone/budget/SNS only).
#   2. Set manage_neon = true, provide the API key (TF_VAR_neon_api_key), then:
#        terraform import 'neon_project.main[0]' <project-id>
#   3. Run `terraform plan` and RECONCILE the attributes below until the plan
#      shows NO changes (adjust neon_project_name / region_id / pg_version vars).
#      Only when the plan is clean is the database safely under IaC.
#
# The community provider (kislerdm/neon) does not guarantee every attribute
# round-trips; if a harmless field keeps showing drift, add it to ignore_changes
# rather than letting `apply` fight the provider.

resource "neon_project" "main" {
  count = var.manage_neon ? 1 : 0

  name       = var.neon_project_name
  region_id  = var.neon_region_id
  pg_version = var.neon_pg_version

  # Stated explicitly to match the live project (import plan stays clean) rather
  # than letting the provider impose its 86400s default. See the variable.
  history_retention_seconds = var.neon_history_retention_seconds

  lifecycle {
    prevent_destroy = true
  }
}
