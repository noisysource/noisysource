# Variables for the 'prod' environment.

gcp_project_id = "rainbow-prod-2454b"

# No domotics site here: Domotics goes to noisysource-prod, not this project
# (infra/HANDOFF-repo-restructure.md). CI doesn't apply this file; prod's
# state isn't reconciled yet.
firebase_hosting_site_ids = ["rainbow-prod-2454b-arcoiris", "rainbow-prod-2454b-finhub"]

gmail_sender_sa_id = "gmail-sender-prod"

# Same as dev: the default Firestore database.
firestore_database_name = "(default)"