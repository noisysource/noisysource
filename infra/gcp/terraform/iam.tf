
# 2. Create the service account for the email function
resource "google_service_account" "gmail_sender" {
  account_id   = var.gmail_sender_sa_id
  display_name = var.gmail_sender_sa_id
  project      = var.gcp_project_id
}

# Grant Firebase deployment roles to the service account
resource "google_project_iam_member" "gmail_sender_firebase_roles" {
  for_each = toset([
    "roles/firebase.admin",      # Broad permissions for Firebase services
    "roles/firebasehosting.admin" # Specific permissions for deploying to Hosting
  ])
  project = var.gcp_project_id
  role    = each.key
  member  = google_service_account.gmail_sender.member
}



# Grant the default Compute SA Firebase/Firestore access so callable functions can
# reach Firestore via the Admin SDK even before Terraform has set gmail_sender as SA.
resource "google_project_iam_member" "compute_sa_firebase_roles" {
  for_each = toset([
    "roles/firebase.admin",
    "roles/datastore.user",
  ])
  project = var.gcp_project_id
  role    = each.key
  member  = "serviceAccount:${data.google_project.project.number}-compute@developer.gserviceaccount.com"
}

# 6. Grant the Eventarc Service Agent role (ensures 2nd gen functions can be triggered)
resource "google_project_iam_member" "eventarc_service_agent" {
  depends_on = [google_project_service.apis]
  project = data.google_project.project.project_id
  role    = "roles/eventarc.serviceAgent"
  member  = "serviceAccount:service-${data.google_project.project.number}@gcp-sa-eventarc.iam.gserviceaccount.com"
}

# Grant the Cloud Build service account necessary roles for deploying functions.
resource "google_project_iam_member" "cloudbuild_service_account_roles" {
  for_each = toset([
    "roles/iam.serviceAccountUser",
    "roles/cloudfunctions.developer",
    "roles/artifactregistry.writer",
    "roles/editor" # TEMPORARY: Broad role for debugging build issues
  ])
  project = var.gcp_project_id
  role    = each.key
  member  = "serviceAccount:${data.google_project.project.number}@cloudbuild.gserviceaccount.com"
}

resource "google_iam_workload_identity_pool" "github_pool" {
  project                   = var.gcp_project_id
  workload_identity_pool_id = "github-pool"
  display_name              = "GitHub Actions Pool"
}

resource "google_iam_workload_identity_pool_provider" "github_provider" {
  project                            = var.gcp_project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github_pool.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-provider"
  display_name                       = "GitHub Actions Provider"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.actor"      = "assertion.actor"
    "attribute.repository" = "assertion.repository"
  }
  attribute_condition = "attribute.repository == 'noisysource/noisysource'"
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "workload_identity_user" {
  service_account_id = google_service_account.gmail_sender.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github_pool.name}/attribute.repository/noisysource/noisysource"
}
