output "deploy_service_account" {
  description = "service_account input of the deploy workflow for this project."
  value       = google_service_account.deploy.email
}

output "functions_runtime_service_account" {
  value = google_service_account.functions_runtime.email
}

# The values for each app's .env.<mode> (VITE_FIREBASE_*). A web API key is not
# a secret: it identifies the project, and the rules decide what it can do.
output "web_app_config" {
  value = {
    for key, cfg in data.google_firebase_web_app_config.apps : key => {
      VITE_FIREBASE_PROJECT_ID          = var.project_id
      VITE_FIREBASE_APP_ID              = google_firebase_web_app.apps[key].app_id
      VITE_FIREBASE_API_KEY             = cfg.api_key
      VITE_FIREBASE_AUTH_DOMAIN         = cfg.auth_domain
      VITE_FIREBASE_STORAGE_BUCKET      = cfg.storage_bucket
      VITE_FIREBASE_MESSAGING_SENDER_ID = cfg.messaging_sender_id
    }
  }
}
