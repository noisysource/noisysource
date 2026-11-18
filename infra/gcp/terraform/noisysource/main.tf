# Terraform root for the NoisySource pair of projects (noisysource-dev,
# noisysource-prod): the home of Domotics, then FinHub and Tasks.
# Plan and order: infra/HANDOFF-repo-restructure.md. How to run: README.md here.
#
# Separate from the KidClub root (the directory above), with its own state:
# same bucket, prefix = the project id.
#
# Two rules this root keeps, both learned on the KidClub side:
#   - It does NOT manage Cloud Functions. `firebase deploy` owns them and their
#     runtime settings; on 2026-11-10 a Terraform-only run stripped the secrets
#     off 20 dev functions because Terraform owned them too.
#   - CI can apply this root but can't change IAM with it: the deploy service
#     account can read IAM policies, not set them. A change to iam.tf is applied
#     by Renato first; until then CI's apply fails closed.

terraform {
  required_version = ">= 1.5"

  backend "gcs" {
    bucket = "kidclub-terraform-state"
    # prefix: -backend-config="prefix=noisysource-dev" (or noisysource-prod)
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.0"
    }
  }
}

# user_project_override: Firebase APIs bill quota to a project, and with a
# person's credentials that must be said explicitly.
provider "google" {
  project               = var.project_id
  user_project_override = true
  billing_project       = var.project_id
}

provider "google-beta" {
  project               = var.project_id
  user_project_override = true
  billing_project       = var.project_id
}
