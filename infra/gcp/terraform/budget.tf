# Combined billing budget alert — added after an uncapped Routes API bill
# produced an unexpected ~€500 charge. Renato's hard constraint: total spend
# across kidclub-dev + rainbow-prod-2454b together must never exceed €50/mo,
# with an early warning at €30.
#
# This resource only sends notifications — it does NOT stop spend by itself.
# The automated cutoff (disabling discretionary metered APIs once the €50
# threshold is hit) is a separate, not-yet-built piece: a Pub/Sub topic +
# Cloud Function reacting to this budget's threshold crossing. That needs its
# own design review before being wired up (cross-project permissions to
# disable APIs on prod is not something to bolt on without a explicit look),
# so for now this only gets you the alert emails at €30 and €50.
#
# It is intentionally ONE budget spanning both projects, not one per project
# — Renato wants a single combined €30/€50, not €30/€50 each. Because the
# same Terraform config is applied separately per-environment (dev vs prod
# tfvars, separate backend state prefixes), this resource is guarded by
# manage_combined_budget so it's only ever created once: true in
# env/kidclub-dev.tfvars, left at its default false in env/prod.tfvars.
#
# Requires: var.billing_account_id (format "XXXXXX-XXXXXX-XXXXXX", found at
# https://console.cloud.google.com/billing) and the Cloud Billing Budget API
# enabled on the billing account. Apply with your existing ADC login:
#   terraform apply -var-file="env/kidclub-dev.tfvars" -var="billing_account_id=..."
# (prod tfvars doesn't need billing_account_id passed for this resource since
#  manage_combined_budget defaults false there, but project.tf/other
#  resources may still need it wired the same way as before)

variable "billing_account_id" {
  type        = string
  description = "GCP Billing Account ID (e.g. 01AB23-CD4567-89EF01). Same billing account covers both dev and prod."
}

variable "combined_budget_amount" {
  type        = number
  description = "Combined monthly EUR spend cap across kidclub-dev + rainbow-prod-2454b together (Renato's hard ceiling)."
  default     = 50
}

variable "manage_combined_budget" {
  type        = bool
  description = "Only one environment's apply should own this resource, since it spans both projects. True only in env/kidclub-dev.tfvars."
  default     = false
}

data "google_project" "prod_for_budget" {
  count      = var.manage_combined_budget ? 1 : 0
  project_id = "rainbow-prod-2454b"
}

resource "google_billing_budget" "combined_budget" {
  count           = var.manage_combined_budget ? 1 : 0
  billing_account = var.billing_account_id
  display_name    = "Combined dev+prod spend cap (€${var.combined_budget_amount})"

  budget_filter {
    projects = [
      "projects/${data.google_project.project.number}",
      "projects/${data.google_project.prod_for_budget[0].number}",
    ]
  }

  amount {
    specified_amount {
      currency_code = "EUR"
      units         = tostring(var.combined_budget_amount)
    }
  }

  # 60% of €50 = €30 early warning. 100% = €50, the hard ceiling — this is
  # the threshold the (not-yet-built) automated cutoff will react to.
  threshold_rules { threshold_percent = 0.6 }
  threshold_rules { threshold_percent = 1.0 }

  all_updates_rule {
    monitoring_notification_channels = []
    disable_default_iam_recipients   = false # keep default: emails billing account admins
  }
}

# --- NOTES: this budget alert is not a hard cap ---
#
# A billing budget only sends a notification; it cannot stop an API from
# being called once the threshold is crossed. Two complementary layers of
# actual hard-capping, in increasing order of guarantee strength:
#
#   1. Per-API quota overrides (google_service_usage_consumer_quota_override)
#      — bounds call volume on Places/Routes directly so GCP itself rejects
#      calls past the cap, no custom code needed. See quotas.tf.
#   2. An automated cutoff triggered by this budget crossing 100% (€50):
#      Pub/Sub topic + Cloud Function that disables the discretionary metered
#      APIs (Places, Routes, Maps) on both projects via the Service Usage
#      API. NOT YET BUILT — needs its own review given it requires a service
#      account with cross-project serviceusage.services.disable on prod.
#      Core services (Firestore, Hosting, Auth, Functions) are explicitly
#      NOT touched by this — the site stays up, it only loses
#      address-autocomplete/route-planning features.
