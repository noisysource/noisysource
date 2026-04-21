# This block configures Terraform to store its state file remotely in a GCS bucket.
terraform {
  backend "gcs" {
    bucket = "rainbow-terraform-state"
  }
}
