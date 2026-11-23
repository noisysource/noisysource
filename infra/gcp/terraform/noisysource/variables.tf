variable "project_id" {
  type        = string
  description = "noisysource-dev or noisysource-prod."
}

variable "region" {
  type        = string
  description = "Firestore location and the region functions run in. Firestore's can't be changed after creation."
  default     = "europe-west3"
}

variable "hosting_site_ids" {
  type        = set(string)
  description = "Firebase Hosting site ids, one per app. Site ids are global, so they carry the project id."
}

variable "web_apps" {
  type        = map(string)
  description = "Firebase web apps: key -> display name. Each app's build reads its config (outputs.tf)."
}

variable "deploy_wif_members" {
  type        = set(string)
  description = "GitHub Actions identities (from the WIF pool in kidclub-dev) allowed to act as the deploy service account."
}

variable "custom_domains" {
  type = map(object({
    site            = string
    redirect_target = optional(string)
  }))
  description = "Custom domains on hosting sites: domain -> {site, redirect_target}. Only prod has any."
  default     = {}
}
