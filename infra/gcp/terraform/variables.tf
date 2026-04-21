variable "gcp_project_id" {
  type        = string
  description = "The Google Cloud project ID."
}

variable "gcp_region" {
  type        = string
  description = "The Google Cloud region for resources."
  default     = "europe-west3" # Standardizing on this region
}

variable "firebase_hosting_site_ids" {
  type        = set(string)
  description = "A list of the exact Firebase Hosting site IDs for the environment."
}

variable "gmail_sender_sa_id" {
  type        = string
  description = "The account ID for the Gmail sender service account."
}

variable "firestore_database_name" {
  type        = string
  description = "The name of the Firestore database."
  default     = "kidclub"
}

