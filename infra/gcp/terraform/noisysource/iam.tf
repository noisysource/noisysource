# --- The identity GitHub Actions deploys as ---------------------------------
# No keys: GitHub's OIDC token is exchanged through the workload identity pool
# that lives in kidclub-dev (project number 245453200769) for a short-lived
# token of this account. Who may do that is var.deploy_wif_members.
resource "google_service_account" "deploy" {
  project      = var.project_id
  account_id   = "github-deploy"
  display_name = "GitHub Actions deploy (${var.project_id})"
  depends_on   = [google_project_service.apis]
}

resource "google_service_account_iam_member" "deploy_wif" {
  for_each           = var.deploy_wif_members
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = each.key
}

# What a deploy needs, and no more. Deliberately absent: roles/editor,
# roles/owner, resourcemanager.projectIamAdmin and iam.serviceAccountAdmin.
# This account can read IAM (so `terraform apply` can see nothing changed) but
# can't grant anything, to itself included.
resource "google_project_iam_member" "deploy" {
  for_each = toset([
    "roles/firebase.admin",                 # hosting, rules, indexes, Auth config
    "roles/cloudfunctions.admin",           # deploy functions
    "roles/run.admin",                      # set the invoker on a new callable
    "roles/iam.serviceAccountUser",         # deploy functions that run as the runtime account
    "roles/artifactregistry.admin",         # function images, and their cleanup
    "roles/cloudbuild.builds.editor",       # function builds
    "roles/serviceusage.serviceUsageAdmin", # firebase deploy / terraform enable APIs
    "roles/iam.serviceAccountViewer",       # terraform reads the bindings in this file
    "roles/orgpolicy.policyViewer",         # terraform reads the org policy override
  ])
  project = var.project_id
  role    = each.key
  member  = google_service_account.deploy.member
}

# --- The identity functions run as ------------------------------------------
# Not the default compute account: this one exists from the first apply and has
# exactly Firestore read/write in its own project. Cross-project reads (FinHub
# reading KidClub billing) get their own grant when that is built.
resource "google_service_account" "functions_runtime" {
  project      = var.project_id
  account_id   = "functions-runtime"
  display_name = "Cloud Functions runtime (${var.project_id})"
  depends_on   = [google_project_service.apis]
}

resource "google_project_iam_member" "functions_runtime" {
  for_each = toset([
    "roles/datastore.user",
    "roles/logging.logWriter",
  ])
  project = var.project_id
  role    = each.key
  member  = google_service_account.functions_runtime.member
}

# --- The identity function builds run as --------------------------------------
# Cloud Functions builds each deploy as the project's default compute account.
# Google used to give that account broad rights by itself; the org policy
# switches that off, so in a new project it has none and every build fails
# with "missing permission on the build service account" (the first deploy to
# noisysource-dev, 2026-11-15). This is the one role a build needs: read the
# source, write the image and the logs.
data "google_project" "this" {
  project_id = var.project_id
}

resource "google_project_iam_member" "functions_build" {
  project    = var.project_id
  role       = "roles/cloudbuild.builds.builder"
  member     = "serviceAccount:${data.google_project.this.number}-compute@developer.gserviceaccount.com"
  depends_on = [google_project_service.apis]
}
