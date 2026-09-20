# Secret Manager secrets used by Cloud Functions.
# Secret values are managed outside Terraform (via gcloud or CI) — only the
# secret shell is defined here. On first apply for a new project, import any
# secrets that were created manually:
#   terraform import 'google_secret_manager_secret.secrets["SA_CLIENT_EMAIL"]' \
#     projects/PROJECT_ID/secrets/SA_CLIENT_EMAIL
#
# EASYPAY_WEBHOOK_URL was added to secret_ids below but was created by hand
# (like the others originally were) and is NOT yet in state — import it
# the same way before the first apply after this change, or `apply` will
# try to create a secret that already exists and fail:
#   terraform import 'google_secret_manager_secret.secrets["EASYPAY_WEBHOOK_URL"]' \
#     projects/kidclub-dev/secrets/EASYPAY_WEBHOOK_URL
#   terraform import 'google_secret_manager_secret.secrets["EASYPAY_WEBHOOK_URL"]' \
#     projects/rainbow-prod-2454b/secrets/EASYPAY_WEBHOOK_URL   # (in the prod state prefix)

locals {
  secret_ids = toset([
    "SA_CLIENT_EMAIL",
    "SA_PRIVATE_KEY",
    "VENDUS_API_KEY",
    "VENDUS_REGISTER_ID",
    "EASYPAY_ACCOUNT_ID",
    "EASYPAY_API_KEY",
    "EASYPAY_WEBHOOK_URL", # used by functions/src/kidclub/easypay.ts + billing.ts, was untracked here
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

# The CI deploy service account needs to read these at deploy time
# (firebase deploy --only functions resolves secret values to validate them)
# — without this, `firebase deploy --only functions` 403s on every secret
# even though the function runtime itself accesses them fine via its own
# default compute SA. Discovered when deploy-dev.yml's first real run
# failed on exactly this.
resource "google_secret_manager_secret_iam_member" "gmail_sender_secret_accessor" {
  for_each  = local.secret_ids
  project   = var.gcp_project_id
  secret_id = google_secret_manager_secret.secrets[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.gmail_sender.member
}

# Same gap, prod's CI identity (github-action-1020915538, not managed by
# Terraform at all — see iam.tf's prod_ci_datastore_index_admin comment).
# Hit the exact same 403 dev did, for the same reason: nothing had ever
# granted this SA secret access before deploy-prod.yml's first real run.
# Granted by hand (terraform apply is off for prod); this documents it.
resource "google_secret_manager_secret_iam_member" "prod_ci_secret_accessor" {
  provider  = google.prod
  for_each  = local.secret_ids
  project   = "rainbow-prod-2454b"
  secret_id = each.key
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:github-action-1020915538@rainbow-prod-2454b.iam.gserviceaccount.com"
}
