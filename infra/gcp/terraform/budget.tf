# Billing budget alerts — added after an uncapped Routes API bill produced an
# unexpected ~€500 charge. This gives an early warning; it does NOT stop
# spend by itself (billing budgets cannot disable billing or hard-cap an
# API — see NOTES below for how to add a real hard cap per API).
#
# Requires: var.billing_account_id (format "XXXXXX-XXXXXX-XXXXXX", found at
# https://console.cloud.google.com/billing) and the Cloud Billing Budget API
# enabled on the billing account. Apply with your existing ADC login:
#   terraform apply -var-file="env/kidclub-dev.tfvars" -var="billing_account_id=..."
#   terraform apply -var-file="env/prod.tfvars"        -var="billing_account_id=..."

variable "billing_account_id" {
  type        = string
  description = "GCP Billing Account ID (e.g. 01AB23-CD4567-89EF01). Same billing account is expected for both dev and prod projects unless overridden."
}

variable "monthly_budget_amount" {
  type        = number
  description = "Monthly budget amount in EUR for this project, used purely for alerting thresholds."
  default     = 25
}

resource "google_billing_budget" "project_budget" {
  billing_account = var.billing_account_id
  display_name    = "${var.gcp_project_id} — monthly spend alert"

  budget_filter {
    projects = ["projects/${data.google_project.project.number}"]
  }

  amount {
    specified_amount {
      currency_code = "EUR"
      units         = tostring(var.monthly_budget_amount)
    }
  }

  # Alert well before the full budget — at 50%, 90%, and 100% of actual spend,
  # so there's time to react instead of finding out at month's end.
  threshold_rules { threshold_percent = 0.5 }
  threshold_rules { threshold_percent = 0.9 }
  threshold_rules { threshold_percent = 1.0 }

  all_updates_rule {
    monitoring_notification_channels = []
    disable_default_iam_recipients   = false # keep default: emails billing account admins
  }
}

# --- NOTES: this budget alert is not a hard cap ---
#
# A billing budget only sends a notification; it cannot stop an API from
# being called once the threshold is crossed. To actually cap spend on a
# specific metered API (this is what should have existed before Routes API
# was ever turned on), do this per API key in the console — not yet
# automated in Terraform because it needs per-metric quota IDs that vary by
# API and must be verified against the live service:
#
#   1. GCP Console → APIs & Services → Credentials → the API key used for
#      Places/Routes/Maps → "Restrict key" → limit it to only the specific
#      APIs it needs (never leave a key unrestricted to "all APIs").
#   2. GCP Console → APIs & Services → [API name] → Quotas & System Limits →
#      find the relevant requests-per-day (or per-minute) quota → "Edit
#      quota" → set it to a number you're comfortable with even in a bug
#      scenario (e.g. a few hundred/day, not the default of tens of
#      thousands). Once a quota is hit, calls fail instead of billing more.
#   3. Repeat per metered API (Places, Routes, Maps, and anything added
#      later) — see the Cost & Production Safety section of the root
#      CLAUDE.md, which now requires this for any new metered API.
