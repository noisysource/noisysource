# Configure the providers with variables
provider "google" {
  project               = var.gcp_project_id
  user_project_override = true
  billing_project       = var.gcp_project_id
}
