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
