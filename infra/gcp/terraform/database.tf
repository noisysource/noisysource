
resource "google_firestore_database" "database" {
  depends_on = [google_project_service.apis]
  project     = var.gcp_project_id
  name        = var.firestore_database_name
  location_id = var.gcp_region
  type        = "FIRESTORE_NATIVE"

  delete_protection_state = "DELETE_PROTECTION_DISABLED"
  deletion_policy         = "DELETE"
}