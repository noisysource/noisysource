# Firebase Storage — the default bucket is owned by Firebase and cannot be
# created or updated via the GCS Terraform provider (domain lock on
# *.firebasestorage.app). It must be activated via the Firebase Console once.
# CORS is managed separately via gsutil (see scripts/set-storage-cors.sh).
#
# This file only registers the existing bucket with the Firebase project.

locals {
  finhub_site_id = [for s in var.firebase_hosting_site_ids : s if can(regex("finhub", s))][0]
}

data "google_storage_bucket" "firebase_storage" {
  name = "${var.gcp_project_id}.firebasestorage.app"
}

resource "google_firebase_storage_bucket" "default" {
  provider  = google-beta
  project   = var.gcp_project_id
  bucket_id = data.google_storage_bucket.firebase_storage.name

  depends_on = [google_firebase_project.default]
}

# storage.rules reads Firestore (firestore.get / firestore.exists) to check
# KidClub admin roles and billing ownership for payment-proof uploads.
# Cross-service rules only work when the Storage service agent holds this
# role; without it every such rule denies. The firebase CLI would also offer
# to grant it on the first deploy, but CI is non-interactive — granting it
# here, before the "Deploy Storage Rules" step, makes the order explicit.
# Prod: terraform doesn't run there yet (deploy-prod.yml), so this has to be
# granted by hand once Storage is active on prod — see kidclub STATUS.md.
resource "google_project_iam_member" "storage_rules_firestore_access" {
  project = var.gcp_project_id
  role    = "roles/firebaserules.firestoreServiceAgent"
  member  = "serviceAccount:service-${data.google_project.project.number}@gcp-sa-firebasestorage.iam.gserviceaccount.com"

  depends_on = [google_firebase_storage_bucket.default]
}
