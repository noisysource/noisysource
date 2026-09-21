
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
    "roles/firebasehosting.admin", # Specific permissions for deploying to Hosting
    # This SA now also runs `terraform apply` from CI (deploy-dev.yml), not just
    # firebase deploys. Every previous apply ran under a human's own broadly-
    # privileged gcloud session, so this SA had never needed to read/manage the
    # rest of the config (secrets metadata, pubsub topics, budgets, quotas,
    # cross-project IAM, etc.) until CI actually tried it and failed on each one
    # in turn. roles/editor over one-off grants per resource type, deliberately —
    # this SA is meant to fully manage kidclub-dev's infra now.
    "roles/editor",
  ])
  project = var.gcp_project_id
  role    = each.key
  member  = google_service_account.gmail_sender.member
}

# roles/editor above does NOT cover this, on kidclub-dev or anywhere else:
# GCP's predefined Editor role deliberately excludes setIamPolicy permissions
# across almost every resource type, specifically to prevent privilege
# escalation via Editor. secrets.tf's gmail_sender_secret_viewer/
# gmail_sender_secret_accessor resources need
# secretmanager.secrets.setIamPolicy to grant those roles on each secret -
# only in roles/secretmanager.admin (or owner). Hit this as a real CI
# failure on a `staging` PR (the first one to actually apply these secret
# grants for real) despite gmail_sender already having roles/editor.
resource "google_project_iam_member" "gmail_sender_secretmanager_admin" {
  project = var.gcp_project_id
  role    = "roles/secretmanager.admin"
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

# ── Cross-project: grant dev functions SA BigQuery access on prod ─────────────
# The getGcpCosts function runs in kidclub-dev but queries rainbow-prod-2454b BigQuery.
# Two SAs need access: gmail_sender (Terraform-managed functions) and the default
# compute SA (firebase-cli-deployed functions like getGcpCosts).

resource "google_project_iam_member" "dev_sa_bq_job_user_prod" {
  provider = google.prod
  project  = "rainbow-prod-2454b"
  role     = "roles/bigquery.jobUser"
  member   = "serviceAccount:${google_service_account.gmail_sender.email}"
}

resource "google_bigquery_dataset_iam_member" "dev_sa_bq_data_viewer_billing_export" {
  provider   = google.prod
  project    = "rainbow-prod-2454b"
  dataset_id = "billing_export"
  role       = "roles/bigquery.dataViewer"
  member     = "serviceAccount:${google_service_account.gmail_sender.email}"
}

resource "google_project_iam_member" "dev_compute_sa_bq_job_user_prod" {
  provider = google.prod
  project  = "rainbow-prod-2454b"
  role     = "roles/bigquery.jobUser"
  member   = "serviceAccount:${data.google_project.project.number}-compute@developer.gserviceaccount.com"
}

resource "google_bigquery_dataset_iam_member" "dev_compute_sa_bq_data_viewer_billing_export" {
  provider   = google.prod
  project    = "rainbow-prod-2454b"
  dataset_id = "billing_export"
  role       = "roles/bigquery.dataViewer"
  member     = "serviceAccount:${data.google_project.project.number}-compute@developer.gserviceaccount.com"
}

# billing-cutoff.tf's google_project_iam_member.billing_cutoff_agent_prod[0]
# grants the dev-project billing-cutoff-agent SA a role directly on
# rainbow-prod-2454b. Terraform needs to read/manage that binding itself,
# which needs the calling identity (this SA, running `terraform apply` from
# CI) to be allowed to touch rainbow-prod-2454b's IAM policy at all —
# exactly the permission the plan error asked for.
resource "google_project_iam_member" "gmail_sender_service_usage_consumer_prod" {
  provider = google.prod
  project  = "rainbow-prod-2454b"
  role     = "roles/serviceusage.serviceUsageConsumer"
  member   = "serviceAccount:${google_service_account.gmail_sender.email}"
}

# roles/serviceusage.serviceUsageConsumer alone isn't enough to READ another
# project's IAM policy for diffing (only to be granted roles as a member) -
# every cross-project google_project_iam_member/google_bigquery_dataset_iam_member
# resource targeting rainbow-prod-2454b above (dev_sa_bq_job_user_prod,
# dev_compute_sa_bq_job_user_prod, billing_cutoff_agent_prod in
# billing-cutoff.tf) needs the calling identity to hold IAM-admin rights on
# that project itself, not just be a role recipient there.
#
# This is a deliberate, real cross-project trust escalation, made knowingly:
# the dev-project CI service account (gmail_sender) can now read and modify
# IAM policy on rainbow-prod-2454b directly. If that service account's
# workload-identity-federated credentials from GitHub Actions were ever
# compromised, the blast radius now includes prod IAM, not just dev
# resources. Chosen over the alternative (excluding these 5 cross-project
# resources from CI's automated apply, leaving them human-applied like
# before) because Renato explicitly asked for this option when presented
# with the tradeoff.
resource "google_project_iam_member" "gmail_sender_project_iam_admin_prod" {
  provider = google.prod
  project  = "rainbow-prod-2454b"
  role     = "roles/resourcemanager.projectIamAdmin"
  member   = "serviceAccount:${google_service_account.gmail_sender.email}"
}

# google_billing_budget (budget.tf) lives on the billing ACCOUNT, a
# separate IAM resource from any project - project-level roles (including
# projectIamAdmin above) don't cover it. roles/billing.admin is the
# standard predefined role for Terraform-managed budgets; there's no
# narrower predefined role that covers budget create/get/update/delete.
resource "google_billing_account_iam_member" "gmail_sender_billing_admin" {
  billing_account_id = var.billing_account_id
  role               = "roles/billing.admin"
  member             = "serviceAccount:${google_service_account.gmail_sender.email}"
}

# Prod's CI deploy identity, github-action-1020915538@rainbow-prod-2454b -
# NOT managed by Terraform at all (created out-of-band, predates this repo's
# Terraform use; no google_service_account resource for it exists anywhere
# here). Referenced by literal email, same pattern as the default compute SA
# elsewhere in this file. run_terraform is currently false for the prod
# pipeline (see deploy-prod.yml), so this resource doesn't apply automatically
# yet - it documents a grant already made BY HAND on 2026-09-20 to unblock
# deploy-prod.yml's first-ever `firestore:indexes` deploy (403, no prior grant
# of any kind existed for index management - the old prod pipeline never
# deployed indexes at all). Kept here so the eventual prod Terraform
# reconciliation (see STATUS.md) finds this already reflected in code instead
# of rediscovering it as more drift.
resource "google_project_iam_member" "prod_ci_datastore_index_admin" {
  provider = google.prod
  project  = "rainbow-prod-2454b"
  role     = "roles/datastore.indexAdmin"
  member   = "serviceAccount:github-action-1020915538@rainbow-prod-2454b.iam.gserviceaccount.com"
}

# Same identity, next gap in the same functions-deploy run:
# roles/serviceusage.serviceUsageConsumer (already granted) only lets it USE
# already-enabled APIs; `firebase deploy --only functions` also tries to
# enable cloudbilling.googleapis.com as a dependency and needs
# serviceusage.services.enable for that, which requires
# roles/serviceusage.serviceUsageAdmin instead. Granted by hand.
resource "google_project_iam_member" "prod_ci_service_usage_admin" {
  provider = google.prod
  project  = "rainbow-prod-2454b"
  role     = "roles/serviceusage.serviceUsageAdmin"
  member   = "serviceAccount:github-action-1020915538@rainbow-prod-2454b.iam.gserviceaccount.com"
}

# Same identity, next gap: "Caller is missing permission
# iam.serviceaccounts.actAs" while updating legrandSetState,
# tuyaGetDevices, tuyaSetState, getKidclubVatSummary - a Cloud Functions
# deploy needs the deploying identity to be allowed to actAs the function's
# runtime service account (the default compute SA here, since these
# functions don't set a custom one). roles/iam.serviceAccountUser at the
# project level covers actAs on every SA in the project, matching how this
# is granted project-wide rather than per-SA elsewhere in this repo.
resource "google_project_iam_member" "prod_ci_service_account_user" {
  provider = google.prod
  project  = "rainbow-prod-2454b"
  role     = "roles/iam.serviceAccountUser"
  member   = "serviceAccount:github-action-1020915538@rainbow-prod-2454b.iam.gserviceaccount.com"
}

# Same identity, next gap: most functions deployed fine, but the
# schedule-triggered ones (createRecurringExpenses, createCampBalanceBillings)
# failed to upsert their Cloud Scheduler jobs, and the pubsub-triggered one
# (billingCutoff) failed to create its topic. Two distinct resource types,
# two distinct roles needed on top of everything granted so far.
resource "google_project_iam_member" "prod_ci_cloudscheduler_admin" {
  provider = google.prod
  project  = "rainbow-prod-2454b"
  role     = "roles/cloudscheduler.admin"
  member   = "serviceAccount:github-action-1020915538@rainbow-prod-2454b.iam.gserviceaccount.com"
}

resource "google_project_iam_member" "prod_ci_pubsub_editor" {
  provider = google.prod
  project  = "rainbow-prod-2454b"
  role     = "roles/pubsub.editor"
  member   = "serviceAccount:github-action-1020915538@rainbow-prod-2454b.iam.gserviceaccount.com"
}

# A different identity hit a different gap: secrets.tf's
# prod_ci_secret_accessor/prod_ci_secret_viewer resources use the
# google.prod provider unconditionally, so they're part of EVERY apply,
# including a dev-triggered one (deploy-dev.yml runs as gmail_sender).
# gmail_sender's roles/resourcemanager.projectIamAdmin on prod (granted
# earlier) covers project-level IAM, but managing IAM on an individual
# secret is a separate resource-level ACL that needs
# secretmanager.secrets.setIamPolicy - only in roles/secretmanager.admin
# (or owner). Without this, the very first PR against staging after
# secrets.tf's prod resources were added failed terraform apply on
# google_secret_manager_secret_iam_member.prod_ci_secret_viewer. Granted
# by hand; documented here.
resource "google_project_iam_member" "gmail_sender_secretmanager_admin_prod" {
  provider = google.prod
  project  = "rainbow-prod-2454b"
  role     = "roles/secretmanager.admin"
  member   = "serviceAccount:${google_service_account.gmail_sender.email}"
}
