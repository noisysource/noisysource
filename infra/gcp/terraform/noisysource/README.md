# Terraform — NoisySource projects

The root for `noisysource-dev` and `noisysource-prod`. What it manages and why is at the top
of `main.tf`; the plan it belongs to is `infra/HANDOFF-repo-restructure.md`.

State: bucket `kidclub-terraform-state`, prefix = the project id.

## First apply of a project (Renato, by hand)
It creates the service accounts and their IAM grants, so CI can't do it.

```bash
# 0. Once per project, before Terraform: it enables APIs through the Cloud
#    Resource Manager API, which a new project doesn't have, so it can't enable
#    that one itself (403 "Cloud Resource Manager API has not been used").
gcloud services enable cloudresourcemanager.googleapis.com --project noisysource-dev

cd infra/gcp/terraform/noisysource
terraform init -backend-config="prefix=noisysource-dev" -reconfigure

# 1. APIs alone. Everything else is created through them, and a new API takes
#    a minute or two to be usable.
terraform apply -var-file=env/dev.tfvars -target=google_project_service.apis

# 2. The rest. If it stops on "API has not been used ... or it is disabled",
#    wait two minutes and run it again; it carries on where it stopped.
terraform apply -var-file=env/dev.tfvars

terraform output
```

For prod: the same with `prefix=noisysource-prod` and `env/prod.tfvars`. Always pass
`-reconfigure` when switching: the prefix decides which project's state is loaded.

## After that
- **Once per project, so CI can reach the Terraform state** (Renato; the bucket is in
  `kidclub-dev`, so this root can't grant it):

  ```bash
  gcloud storage buckets add-iam-policy-binding gs://kidclub-terraform-state \
    --member="serviceAccount:github-deploy@noisysource-dev.iam.gserviceaccount.com" \
    --role="roles/storage.objectAdmin"
  ```

  For prod, the same with `github-deploy@noisysource-prod.iam.gserviceaccount.com`. The
  grant covers the whole bucket, KidClub's state included: a grant limited to one prefix
  breaks `terraform init`, which lists the bucket.
- **A change that doesn't touch `iam.tf`**: CI applies it (`.github/workflows/_deploy-env.yml`,
  called from `deploy-dev.yml` for `noisysource-dev`, on a PR into `staging`, and from
  `deploy-noisysource-prod.yml` for `noisysource-prod`, on a merge into `staging`).
- **A change to `iam.tf`**: Renato applies it by hand first, with the two commands above
  (`init`, then `apply`). The deploy account can read IAM but can't grant anything, so
  CI's apply fails until then. That is on purpose.

## Not in this root
- **Cloud Functions.** `firebase deploy` owns them and their runtime settings.
- **Google sign-in for Firebase Auth.** It needs an OAuth client that the Firebase console
  creates; set up when the first app arrives (PR 8).
- **The state bucket, the GitHub workload identity pool, budgets and the billing cutoff.**
  They live in `kidclub-dev` and belong to the KidClub root until the org root exists.
