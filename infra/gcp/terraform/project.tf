# 1. Enable necessary APIs
resource "google_project_service" "apis" {
  for_each = toset([
    "gmail.googleapis.com",
    "cloudfunctions.googleapis.com",
    "cloudbuild.googleapis.com",
    "eventarc.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "run.googleapis.com", # Required for 2nd gen functions
    "firestore.googleapis.com"
  ])
  service                    = each.key
  disable_on_destroy         = false
  disable_dependent_services = true
}

# --- Firebase Project and Hosting ---

# Define the Firebase Project resource itself
resource "google_firebase_project" "default" {
  provider = google-beta # The firebase provider is in beta
  project  = var.gcp_project_id
}

# Define the hosting sites for your apps
resource "google_firebase_hosting_site" "sites" {
  provider = google-beta
  project  = var.gcp_project_id
  for_each = var.firebase_hosting_site_ids
  site_id  = each.key
}

data "google_project" "project" {
  project_id = var.gcp_project_id
}
