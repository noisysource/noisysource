# APIs. cloudresourcemanager, iam and serviceusage come first in practice:
# everything else in this root is created through them (see README, first apply).
resource "google_project_service" "apis" {
  for_each = toset([
    "cloudresourcemanager.googleapis.com",
    "serviceusage.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com", # GitHub Actions -> deploy service account
    "orgpolicy.googleapis.com",
    "firebase.googleapis.com",
    "firestore.googleapis.com",
    "firebaserules.googleapis.com",
    "firebasehosting.googleapis.com",
    "identitytoolkit.googleapis.com", # Firebase Auth
    "cloudfunctions.googleapis.com",
    "cloudbuild.googleapis.com",
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "eventarc.googleapis.com",
    "pubsub.googleapis.com",
    # No metered third-party API (Maps, Routes, Places...) belongs here without
    # its quota cap in the same change: root CLAUDE.md, "Cost & Production Safety".
  ])
  project                    = var.project_id
  service                    = each.key
  disable_on_destroy         = false
  disable_dependent_services = false
}

resource "google_firebase_project" "default" {
  provider   = google-beta
  project    = var.project_id
  depends_on = [google_project_service.apis]
}

# One database per company: this one is NoisySource's alone (KidClub's stays in
# its own projects). It will hold the house's history and FinHub's books, so it
# can't be deleted by a `terraform destroy` or a removed block.
resource "google_firestore_database" "default" {
  project     = var.project_id
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  deletion_policy         = "ABANDON"

  depends_on = [google_project_service.apis]
}

resource "google_firebase_hosting_site" "sites" {
  provider   = google-beta
  for_each   = var.hosting_site_ids
  project    = var.project_id
  site_id    = each.key
  depends_on = [google_firebase_project.default]
}

resource "google_firebase_web_app" "apps" {
  provider        = google-beta
  for_each        = var.web_apps
  project         = var.project_id
  display_name    = each.value
  deletion_policy = "DELETE"
  depends_on      = [google_firebase_project.default]
}

data "google_firebase_web_app_config" "apps" {
  provider   = google-beta
  for_each   = var.web_apps
  project    = var.project_id
  web_app_id = google_firebase_web_app.apps[each.key].app_id
}

# Callable functions are public Cloud Run services that check the caller in
# code. The org policy iam.allowedPolicyMemberDomains forbids `allUsers`
# bindings unless a project opts out, and without that `firebase deploy` can't
# set the invoker (same override as on the KidClub projects).
resource "google_org_policy_policy" "allow_public_invoker" {
  name   = "projects/${var.project_id}/policies/iam.allowedPolicyMemberDomains"
  parent = "projects/${var.project_id}"

  spec {
    rules {
      allow_all = "TRUE"
    }
  }

  depends_on = [google_project_service.apis]
}
