# Secret Manager secrets used by Cloud Functions.
# Secret values are managed outside Terraform (via gcloud or CI) — only the
# secret shell is defined here. On first apply for a new project, import any
# secrets that were created manually:
#   terraform import 'google_secret_manager_secret.secrets["SA_CLIENT_EMAIL"]' \
#     projects/PROJECT_ID/secrets/SA_CLIENT_EMAIL

locals {
  secret_ids = toset([
    "SA_CLIENT_EMAIL",
    "SA_PRIVATE_KEY",
    "VENDUS_API_KEY",
    "VENDUS_REGISTER_ID",
    "EASYPAY_ACCOUNT_ID",
    "EASYPAY_API_KEY",
  ])
}

resource "google_secret_manager_secret" "secrets" {
  for_each  = local.secret_ids
  project   = var.gcp_project_id
  secret_id = each.key

  replication {
    auto {}
  }

  lifecycle {
    prevent_destroy = true
  }
}
