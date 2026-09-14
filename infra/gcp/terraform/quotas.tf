# Hard per-API quota caps on Places/Routes — the actual circuit breaker for
# a repeat of the ~€500 Routes API incident. A billing budget (budget.tf)
# only alerts after the fact and reacts on a several-hour data lag; these
# make GCP itself reject calls the instant the daily cap is hit, no billing
# system round-trip needed.
#
# NOT MANAGED VIA google_service_usage_consumer_quota_override: that
# resource 404s ("No quota limit with limitId...") when creating overrides
# for these specific Places/Routes metrics — a provider-level bug, not a
# config mistake (confirmed by hitting the same underlying Service Usage API
# directly via `gcloud alpha services quota update`, which works). Applied
# instead via the idempotent script below, which is the actual source of
# truth for these values. Re-run it any time to confirm/reassert the caps
# (e.g. after a project recreate, or to verify nothing has drifted):
#
#   ./infra/gcp/terraform/apply-quota-overrides.sh kidclub-dev
#   ./infra/gcp/terraform/apply-quota-overrides.sh rainbow-prod-2454b
#
# Values applied 2026-09-14 (verified live via `gcloud alpha services quota
# list`), same on both projects:
#
#   places.googleapis.com/AutocompletePlacesRequest   100/day
#   routes.googleapis.com/compute_route_matrix_elements 150/day
#   routes.googleapis.com/compute_routes_requests       20/day
#
# Pricing behind these numbers (checked 2026-09-14): Places Autocomplete
# (no session token, matches PlacesInput.tsx) is $2.83/1,000 requests.
# Routes Compute Route Matrix, Advanced tier (TRAFFIC_AWARE /
# TRAFFIC_AWARE_OPTIMAL, matches routeSolver.ts) is $10/1,000 elements,
# where elements = origins × destinations — cost scales with N² per solve.
# Each cap is sized so its own worst-case-if-maxed-every-day stays a modest
# slice of the combined €50/month hard ceiling (see budget.tf), not close to
# consuming it alone. Routes' 150/day is tight — it barely covers one real
# iterative planning session at N=10 addresses; see the caching notes in
# routeSolver.ts / TransportPlannerPage.tsx before raising it.
#
# Routes overrides are applied even though routes.googleapis.com is
# currently disabled: the point is to have the cap already configured
# *before* the API is ever re-enabled, per the rule in CLAUDE.md that quota
# + key restriction must land in the same change as re-enabling it, never
# after.
