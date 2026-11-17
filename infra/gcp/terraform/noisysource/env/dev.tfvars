project_id = "noisysource-dev"

hosting_site_ids = ["noisysource-dev-domotics", "noisysource-dev-website"]

web_apps = {
  domotics = "Domotics (dev)"
}

# Any workflow run of this repository, pull requests included: dev is where a
# PR into staging previews.
deploy_wif_members = [
  "principalSet://iam.googleapis.com/projects/245453200769/locations/global/workloadIdentityPools/github-pool/attribute.repository/noisysource/noisysource",
]
