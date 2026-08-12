#!/usr/bin/env bash
# Sets CORS on Firebase Storage buckets.
# Run after activating Firebase Storage on a new project via the console.
# Requires: gcloud auth application-default login

set -e

CORS_FILE="$(dirname "$0")/storage-cors.json"

cat > "$CORS_FILE" <<'EOF'
[
  {
    "origin": ["https://kidclub-dev-finhub.web.app", "http://localhost:5174"],
    "method": ["GET", "POST", "PUT", "DELETE", "HEAD"],
    "maxAgeSeconds": 3600,
    "responseHeader": ["Content-Type", "Authorization", "Content-Length", "User-Agent", "x-goog-resumable"]
  }
]
EOF

echo "Setting CORS on kidclub-dev..."
gsutil cors set "$CORS_FILE" gs://kidclub-dev.firebasestorage.app

echo "Done. Remember to add prod bucket when ready:"
echo "  gsutil cors set <prod-cors.json> gs://rainbow-prod-2454b.firebasestorage.app"
