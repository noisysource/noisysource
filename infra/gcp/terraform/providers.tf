terraform {
  required_providers {
    google = {
      source = "hashicorp/google"
    }
    # Some Firebase resources are only available in the beta provider
    google-beta = {
      source = "hashicorp/google-beta"
    }
  }
}

provider "google-beta" {
  project               = var.gcp_project_id
  user_project_override = true
  billing_project       = var.gcp_project_id
}