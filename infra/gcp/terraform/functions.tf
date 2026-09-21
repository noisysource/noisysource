# 7. Create a bucket to store the function source code for Terraform
resource "google_storage_bucket" "function_source" {
  name                        = "${var.gcp_project_id}-function-source"
  location                    = var.gcp_region
  force_destroy               = true
  uniform_bucket_level_access = true # Required by org policy
}

resource "google_storage_bucket_object" "function_source_zip" {
  name   = "source.zip"
  bucket = google_storage_bucket.function_source.name
  source = "./dummy_function/source.zip" # Path relative to the terraform directory
}

# 8. Define the 2nd Gen Cloud Function
# NOTE: This only defines the function's infrastructure.
# The source code itself is still deployed via your CI/CD pipeline (e.g., using gcloud functions deploy).
resource "google_cloudfunctions2_function" "send_email" {
  name     = "sendEmailFromOutbox"
  location = var.gcp_region
  project  = var.gcp_project_id

  build_config {
    runtime     = "nodejs22"
    entry_point = "sendEmailFromOutbox"
    source {
      storage_source {
        bucket = google_storage_bucket.function_source.name
        object = google_storage_bucket_object.function_source_zip.name
      }
    }
  }

  service_config {
    max_instance_count    = 20
    available_memory      = "256Mi"
    timeout_seconds       = 60
    service_account_email = google_service_account.gmail_sender.email

    secret_environment_variables {
      key        = "SA_CLIENT_EMAIL"
      project_id = var.gcp_project_id
      secret     = "SA_CLIENT_EMAIL"
      version    = "latest"
    }
    secret_environment_variables {
      key        = "SA_PRIVATE_KEY"
      project_id = var.gcp_project_id
      secret     = "SA_PRIVATE_KEY"
      version    = "latest"
    }
  }

  event_trigger {
    trigger_region = var.gcp_region
    service_account_email = google_service_account.gmail_sender.email
    event_type     = "google.cloud.firestore.document.v1.created"
    event_filters {
      attribute = "database"
      value     = var.firestore_database_name
    }
    event_filters {
      attribute = "namespace"
      value     = var.firestore_database_name
    }
    event_filters {
      attribute = "document"
      operator  = "match-path-pattern"
      value     = "_apps/arcoiris/emailOutbox/{id}"
    }
    retry_policy = "RETRY_POLICY_DO_NOT_RETRY"
  }

  # Ensure the necessary APIs and the database are enabled/created before creating the function
  depends_on = [
    google_project_service.apis,
    google_firestore_database.database,
    google_project_iam_member.cloudbuild_service_account_roles,
    google_storage_bucket_object.function_source_zip # Ensure zip is uploaded before function creation
  ]

  # Ignore changes to the build_config, as the source code is managed
  # by the CI/CD pipeline, not by Terraform.
  lifecycle {
    ignore_changes = [build_config]
  }
}

locals {
  # All HTTP-callable and HTTP-request functions (excludes Firestore triggers and scheduled functions).
  callable_functions = toset([
    # Shared / internal
    "getUsageSnapshot",
    "expandTemplatesInRange",
    "postPlannedInstance",
    "exportOrgData",
    "importOrgData",
    "wipeOrgData",
    "createRecurringExpenses",
    "impersonateUser",
    # KidClub — invoicing / VAT
    "getKidclubVatSummary",
    # KidClub — billing
    "sendBillingNotice",
    "backfillBillingSchedules",
    "initiateMbwayPayment",
    "initiateMultibancoPayment",
    "initiateCardPayment",
    "setPaymentMethod",
    "createPartyDeposit",
    "retryVendusInvoice",
    "easypayWebhook",
    # KidClub — reservation events
    "setReservationEventStatus",
    "backfillReservationEvents",
    # KidClub — camps
    "createCampSubscription",
    "confirmCampSubscription",
    "cancelCampSubscription",
    # User management
    "lookupUserByEmail",
    # Domotics
    "legrandGetStatus",
    "legrandSetState",
    "tuyaGetDevices",
    "tuyaSetState",
  ])
}

resource "google_cloudfunctions2_function" "callable_functions" {
  for_each = local.callable_functions
  name     = each.key
  location = var.gcp_region
  project  = var.gcp_project_id

  build_config {
    runtime     = "nodejs22"
    entry_point = each.key
    source {
      storage_source {
        bucket = google_storage_bucket.function_source.name
        object = google_storage_bucket_object.function_source_zip.name
      }
    }
  }

  service_config {
    max_instance_count               = 20
    available_memory                 = "256Mi"
    timeout_seconds                  = 60
    all_traffic_on_latest_revision   = true
    ingress_settings                 = "ALLOW_ALL" # Required for callable functions
    service_account_email            = google_service_account.gmail_sender.email
  }

  depends_on = [
    google_project_service.apis,
    google_project_iam_member.cloudbuild_service_account_roles,
    google_storage_bucket_object.function_source_zip # Ensure zip is uploaded before function creation
  ]

  lifecycle {
    ignore_changes = [build_config]
  }
}