# Variables for the 'prod' environment.

gcp_project_id = "rainbow-prod-2454b"

# rainbow-prod-2454b-domotics added 2026-10-18 for domotics in prod. Prod's
# state isn't reconciled yet (CI doesn't apply prod), so this declares it for
# that reconciliation; the site itself is created once by hand (root
# CLAUDE.md, "Domotics in prod") and imported then.
firebase_hosting_site_ids = ["rainbow-prod-2454b-arcoiris", "rainbow-prod-2454b-finhub", "rainbow-prod-2454b-domotics"]

gmail_sender_sa_id = "gmail-sender-prod"

# Prod uses the default Firestore database (dev uses a named 'kidclub' database)
firestore_database_name = "(default)"