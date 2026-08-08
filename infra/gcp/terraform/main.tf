# Configure the providers with variables
provider "google" {
  project               = var.gcp_project_id
  user_project_override = true
  billing_project       = var.gcp_project_id
}

# Alias for cross-project IAM grants targeting prod (e.g. granting dev SA BigQuery access)
provider "google" {
  alias                 = "prod"
  project               = "rainbow-prod-2454b"
  user_project_override = true
  billing_project       = "rainbow-prod-2454b"
}
