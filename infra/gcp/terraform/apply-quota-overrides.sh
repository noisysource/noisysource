#!/usr/bin/env bash
# Applies the Places/Routes daily quota caps documented in quotas.tf.
#
# Not Terraform-managed: google_service_usage_consumer_quota_override 404s
# for these metrics (provider bug), so this script is the actual source of
# truth. Safe to re-run — gcloud's quota update is idempotent for a given
# value, and --force is required because we're deliberately dropping from
# the (much higher) default limits by more than the 10% GCP allows without
# it.
#
# Usage: ./apply-quota-overrides.sh <project-id>

set -euo pipefail

PROJECT="${1:?Usage: $0 <project-id>}"

echo "Applying quota caps to project: $PROJECT"

gcloud alpha services quota update \
  --service=places.googleapis.com \
  --consumer="projects/${PROJECT}" \
  --metric=places.googleapis.com/AutocompletePlacesRequest \
  --unit='1/d/{project}' --value=100 --force

gcloud alpha services quota update \
  --service=routes.googleapis.com \
  --consumer="projects/${PROJECT}" \
  --metric=routes.googleapis.com/compute_route_matrix_elements \
  --unit='1/d/{project}' --value=150 --force

gcloud alpha services quota update \
  --service=routes.googleapis.com \
  --consumer="projects/${PROJECT}" \
  --metric=routes.googleapis.com/compute_routes_requests \
  --unit='1/d/{project}' --value=20 --force

echo "Done. Verify with:"
echo "  gcloud alpha services quota list --service=places.googleapis.com --consumer=projects/${PROJECT}"
echo "  gcloud alpha services quota list --service=routes.googleapis.com --consumer=projects/${PROJECT}"
