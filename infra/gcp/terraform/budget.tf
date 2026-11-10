# Spend cap on NoisySource Central Billing — added after an uncapped Routes
# API bill produced an unexpected ~€500 charge. Renato's hard constraint:
# total Google Cloud spend must never exceed €50/mo, with an early warning
# at €30.
#
# Scope: the WHOLE billing account (no budget_filter), not a project list.
# NoisySource pays for every project in the org (decided 2026-11-10, when
# the projects moved from "My Billing Account" 012710-30B4D5-DCC57E to
# "NoisySource Central Billing" 01B2DE-83C5F5-B12BC9), so any project
# linked to it later — noisysource-dev/prod, Jarvis if it ever gets
# billing — counts toward the same €50 without anyone remembering to add
# it here. A budget only sees spend on its own billing account: a project
# moved to another account silently drops out, which is exactly what
# happened on 2026-11-10 until this was moved.
#
# The email at €30/€50 is the alert. The actual circuit breakers are the
# Places/Routes quota caps (quotas.tf) and the automated cutoff
# (billing-cutoff.tf), which this budget feeds through Pub/Sub.
#
# ONE budget, not one per environment. The same config is applied per
# environment (separate tfvars and state prefixes), so this is guarded by
# manage_combined_budget: true only in env/kidclub-dev.tfvars.
#
# var.billing_account_id comes from the BILLING_ACCOUNT_ID repo secret in
# CI. The dev CI SA (gmail-sender-kidclub-dev) manages this budget with
# roles/billing.costsManager on the billing account, granted by hand (see
# the note at the end of iam.tf). Local apply:
#   terraform apply -var-file="env/kidclub-dev.tfvars" -var="billing_account_id=01B2DE-83C5F5-B12BC9"

variable "billing_account_id" {
  type        = string
  description = "Billing account every project is linked to: NoisySource Central Billing, 01B2DE-83C5F5-B12BC9."
}

variable "combined_budget_amount" {
  type        = number
  description = "Monthly EUR spend cap across the whole billing account (Renato's hard ceiling)."
  default     = 50
}

variable "manage_combined_budget" {
  type        = bool
  description = "Only one environment's apply should own this resource, since it spans the whole billing account. True only in env/kidclub-dev.tfvars."
  default     = false
}

resource "google_billing_budget" "combined_budget" {
  count           = var.manage_combined_budget ? 1 : 0
  billing_account = var.billing_account_id
  display_name    = "NoisySource Central Billing spend cap (€${var.combined_budget_amount})"

  # No budget_filter: covers every project on the billing account.

  amount {
    specified_amount {
      currency_code = "EUR"
      units         = tostring(var.combined_budget_amount)
    }
  }

  # 60% of €50 = €30 early warning. 100% = €50, the hard ceiling the
  # automated cutoff (billing-cutoff.tf) reacts to.
  threshold_rules { threshold_percent = 0.6 }
  threshold_rules { threshold_percent = 1.0 }

  all_updates_rule {
    monitoring_notification_channels = []
    disable_default_iam_recipients   = false # keep default: emails billing account admins
    # Feeds the automated cutoff (see billing-cutoff.tf): it disables Places/Routes
    # on the KidClub projects once costAmount reaches the €50 line, whichever
    # project the spend came from. Doesn't replace the email above, which still
    # fires at every threshold including the €30 warning.
    pubsub_topic = google_pubsub_topic.billing_cutoff_trigger[0].id
  }
}

# --- NOTES: this budget alert is not a hard cap ---
#
# A billing budget only sends a notification; it cannot stop an API from
# being called once the threshold is crossed. Two complementary layers of
# actual hard-capping, in increasing order of guarantee strength:
#
#   1. Per-API daily quota caps on Places/Routes, so GCP itself rejects
#      calls past the cap. See quotas.tf / apply-quota-overrides.sh.
#   2. The automated cutoff in billing-cutoff.tf: this budget crossing 100%
#      (€50) publishes to Pub/Sub, and functions/src/billingCutoff.ts
#      disables Places/Routes on the KidClub projects via the Service Usage
#      API. Core services (Firestore, Hosting, Auth, Functions) are
#      explicitly NOT touched — the site stays up, it only loses
#      address-autocomplete/route-planning features.
