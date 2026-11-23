project_id = "noisysource-prod"

hosting_site_ids = ["noisysource-prod-domotics", "noisysource-prod-website"]

# noisysource.com serves the website; www redirects to it. Each goes live once
# its DNS records (output custom_domain_dns_records) are added at the registrar.
custom_domains = {
  "noisysource.com"     = { site = "noisysource-prod-website" }
  "www.noisysource.com" = { site = "noisysource-prod-website", redirect_target = "noisysource.com" }
}

web_apps = {
  domotics = "Domotics"
}

# Only a run triggered by a push to staging (a merge) in this repository: a
# pull request's token has a different subject and can't act as this account.
# (The private tools release on merge into staging; the staging -> main
# promotion is KidClub's.)
deploy_wif_members = [
  "principal://iam.googleapis.com/projects/245453200769/locations/global/workloadIdentityPools/github-pool/subject/repo:noisysource/noisysource:ref:refs/heads/staging",
]
