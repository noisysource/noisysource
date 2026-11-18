# Variables for the 'kidclub-dev' environment.

gcp_project_id = "kidclub-dev"

firebase_hosting_site_ids = ["kidclub-dev-arcoiris", "kidclub-dev-finhub"]

gmail_sender_sa_id = "gmail-sender-kidclub-dev"

gcp_region = "europe-west3"

firestore_database_name = "(default)"

storage_cors_extra_origins = ["http://localhost:5174"]

# Combined dev+prod billing budget (see budget.tf) is only created once,
# under this environment's apply.
manage_combined_budget = true
