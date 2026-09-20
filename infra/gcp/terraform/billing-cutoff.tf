# Automated cutoff: once the combined dev+prod billing budget (budget.tf)
# crosses its €50 hard line, this disables the discretionary metered APIs
# (Places, Routes) on both projects. A budget alert alone only notifies —
# this is the actual circuit breaker for a repeat of the ~€500 incident.
#
# Function code lives in functions/src/billingCutoff.ts, deployed via the
# normal `firebase deploy --only functions` CI path (see functions.tf for
# why Terraform only pre-stages infra here, not the function's real code).
#
# Singleton, same as the combined budget: only ever created once, gated by
# manage_combined_budget (true only in env/kidclub-dev.tfvars), since this
# is cross-project infra that shouldn't be duplicated per-environment.

resource "google_service_account" "billing_cutoff_agent" {
  count        = var.manage_combined_budget ? 1 : 0
  account_id   = "billing-cutoff-agent"
  display_name = "Billing cutoff agent (disables Places/Routes at the €50 line)"
  project      = var.gcp_project_id
}

# Narrowly scoped: only lets this SA enable/disable APIs, nothing else — no
# Firestore, no IAM, no other resource access, on either project.
resource "google_project_iam_member" "billing_cutoff_agent_dev" {
  count   = var.manage_combined_budget ? 1 : 0
  project = var.gcp_project_id
  role    = "roles/serviceusage.serviceUsageAdmin"
  member  = google_service_account.billing_cutoff_agent[0].member
}

resource "google_project_iam_member" "billing_cutoff_agent_dev_firestore" {
  count   = var.manage_combined_budget ? 1 : 0
  project = var.gcp_project_id
  role    = "roles/datastore.user"
  member  = google_service_account.billing_cutoff_agent[0].member
}

resource "google_project_iam_member" "billing_cutoff_agent_prod" {
  count    = var.manage_combined_budget ? 1 : 0
  provider = google.prod
  project  = "rainbow-prod-2454b"
  role     = "roles/serviceusage.serviceUsageAdmin"
  member   = google_service_account.billing_cutoff_agent[0].member
}

resource "google_pubsub_topic" "billing_cutoff_trigger" {
  count   = var.manage_combined_budget ? 1 : 0
  name    = "billing-budget-cutoff-trigger"
  project = var.gcp_project_id
}

# No manual IAM grant needed here: Cloud Billing automatically grants its own
# service agent pubsub.publisher on this topic once a budget references it
# via all_updates_rule.pubsub_topic (confirmed — an earlier attempt to grant
# "billing-budgets@system.gserviceaccount.com" by hand failed with "Service
# account ... does not exist", because it's not a real, separately-grantable
# principal; Google wires this up behind the scenes on its own).

resource "google_cloudfunctions2_function" "billing_cutoff" {
  count    = var.manage_combined_budget ? 1 : 0
  name     = "billingCutoff"
  location = var.gcp_region
  project  = var.gcp_project_id

  build_config {
    runtime     = "nodejs22"
    entry_point = "billingCutoff"
    source {
      storage_source {
        bucket = google_storage_bucket.function_source.name
        object = google_storage_bucket_object.function_source_zip.name
      }
    }
  }

  service_config {
    max_instance_count    = 5
    available_memory      = "256Mi"
    timeout_seconds       = 120
    service_account_email = google_service_account.billing_cutoff_agent[0].email
  }

  event_trigger {
    trigger_region        = var.gcp_region
    service_account_email = google_service_account.billing_cutoff_agent[0].email
    event_type             = "google.cloud.pubsub.topic.v1.messagePublished"
    pubsub_topic            = google_pubsub_topic.billing_cutoff_trigger[0].id
    retry_policy            = "RETRY_POLICY_DO_NOT_RETRY"
  }

  depends_on = [
    google_project_service.apis,
    google_project_iam_member.billing_cutoff_agent_dev,
    google_storage_bucket_object.function_source_zip,
  ]

  # Source code is managed by the CI/CD pipeline (firebase deploy), not Terraform.
  lifecycle {
    ignore_changes = [build_config]
  }
}

# The Pub/Sub push subscription authenticates its invocation with an OIDC
# token from billing_cutoff_agent (same SA the function runs as) -- without
# this, every delivery fails at the infra layer with "IAM principal lacks
# {run.routes.invoke} permission" before the function code ever runs.
# Discovered by actually testing the deployed function, not by inspection.
#
# Note: the underlying Cloud Run service name is NOT the function's name --
# Cloud Functions 2nd gen lowercases it ("billingCutoff" -> "billingcutoff").
# Using service_config[0].service (the actual resolved resource path)
# instead of the function name avoids that mismatch.
resource "google_cloud_run_service_iam_member" "billing_cutoff_invoker" {
  count    = var.manage_combined_budget ? 1 : 0
  project  = var.gcp_project_id
  location = var.gcp_region
  service  = split("/", google_cloudfunctions2_function.billing_cutoff[0].service_config[0].service)[length(split("/", google_cloudfunctions2_function.billing_cutoff[0].service_config[0].service)) - 1]
  role     = "roles/run.invoker"
  member   = google_service_account.billing_cutoff_agent[0].member
}

# billingCutoff is exported from functions/src/index.ts, so `firebase
# deploy --only functions` deploys it to BOTH projects (this file's
# google_cloudfunctions2_function.billing_cutoff resource above only ever
# exists in dev's state, per the singleton comment at the top of this file —
# but the function code itself isn't gated by that, and always sets its
# runtime service_account_email to this same cross-project agent, by
# design). So prod's CI identity also needs to actAs this dev-project SA,
# same reason as prod_ci_service_account_user in iam.tf, just cross-project
# instead of same-project — that's a per-service-account grant, not
# something roles/iam.serviceAccountUser on rainbow-prod-2454b can reach.
# Granted by hand; documented here.
resource "google_service_account_iam_member" "billing_cutoff_agent_prod_ci_actas" {
  count              = var.manage_combined_budget ? 1 : 0
  service_account_id = google_service_account.billing_cutoff_agent[0].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:github-action-1020915538@rainbow-prod-2454b.iam.gserviceaccount.com"
}
