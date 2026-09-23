# Dev wipe + prod import runbook (Phase 1)

**Status: written down, NOT run.** Decision 15 — the Phase 2 agent writes the script only;
Renato reviews the dry run first, and runs this himself. Nothing in this file has been
executed.

Purpose: prove the Phase 2 migration against real data with no pre-existing dev records
polluting the result. `gcloud firestore import` **merges** — it does not replace — so without
an explicit delete the old dev docs survive alongside the imported ones, which is exactly the
pollution this is meant to avoid.

---

## 🔴 The boundary: KidClub only

```
DELETE:  _apps/arcoiris/**          ← KidClub's own root, and nothing else
KEEP:    finances_entities/**       ← FinHub dev. Shared (default) database.
KEEP:    users/**                   ← shared with FinHub. See below.
```

**Never run `firebase firestore:delete --all-collections`.** KidClub and FinHub share the
single `(default)` database in each project (root `CLAUDE.md`, "Firestore Architecture"), so a
blanket wipe destroys FinHub's dev data too.

**Do not wipe the top-level `users` collection** — verified 2026-09-22. It is not under
`_apps/arcoiris`; `billing.ts` reads `db.collection("users")` directly. All 46 prod docs carry
a `roles` map holding both `rainbowAdmin` and `finhubAdmin`, and `functions/src/userManagement.ts`
— shared, not KidClub-scoped — gates on `roles.finhubAdmin`. Wiping it would strip FinHub's
admin access in dev. Fix the two accounts that need fixing individually instead.

---

## 1. Back up dev first

A wipe of `_apps/arcoiris/**` is not reversible from inside Firestore.

```bash
gcloud config set project kidclub-dev
gcloud firestore export gs://kidclub-dev-exports/pre-wipe-$(date +%Y%m%d-%H%M) \
  --collection-ids=billing,children,config,eventModifications,families,financialEvents,\
invoices,reservationEvents,settings,studyroom,subscriptionVersions,transportationSubscriptions
```

`--collection-ids` matches by collection ID at any depth, which is what scopes this to
KidClub's subcollections. `emailOutbox` / `emailCampaigns` are deliberately excluded so
nothing can re-queue real emails — same exclusion the 2026-09-22 prod→dev sync used.

## 2. Delete KidClub's data only

Two ways. The second is what actually worked on 2026-09-23.

**(a) Path-scoped, via the firebase CLI** — the obvious one, but its credentials expire
independently of gcloud's and it needs an interactive `firebase login --reauth`:

```bash
firebase firestore:delete --project kidclub-dev --recursive _apps/arcoiris
```

**(b) Collection-group scoped, via gcloud** — server-side and fast (11,440 documents in about
two minutes, versus one API round trip per document for a client-side recursive walk):

```bash
gcloud firestore bulk-delete --project kidclub-dev --collection-ids=billing,children,config,\
eventModifications,families,financialEvents,invoices,reservationEvents,settings,studyroom,\
subscriptionVersions,transportationSubscriptions
```

🔴 **`bulk-delete` scopes by collection ID at ANY depth, not by path.** It is not the same
boundary as `--recursive _apps/arcoiris`. If FinHub ever holds a collection sharing one of
these IDs — `invoices`, `config`, `settings` and `financialEvents` are all plausible under
`finances_entities/{entityId}/` — this deletes those too. **Verify before every run**, with a
collection-group query per ID checking that every hit is under `_apps/arcoiris/`:

```js
// structuredQuery: { from: [{ collectionId: id, allDescendants: true }],
//                    select: { fields: [{ fieldPath: "__name__" }] } }
// then assert every document name starts with "_apps/arcoiris/"
```

Verified clean on 2026-09-23: all 11,440 documents across the 12 IDs were inside
`_apps/arcoiris`, and `finances_entities` held nothing at top level.

**Confirm afterwards** that `users` still has its full count (49 docs in dev on 2026-09-23) —
that is the check that the boundary held.

## 3. Export prod (read-only on prod)

```bash
gcloud config set project rainbow-prod-2454b
gcloud firestore export gs://rainbow-prod-2454b-exports/to-dev-$(date +%Y%m%d-%H%M) \
  --collection-ids=billing,children,config,eventModifications,families,financialEvents,\
invoices,settings,studyroom,subscriptionVersions,transportationSubscriptions
```

`reservationEvents` is **not** in this list: prod holds zero of them, and Phase 2 is what
creates them. `users` is **not** in this list either — see the boundary above.

Prod is imported **unrepaired** (decision 12). The 11 subscriptions with no `familyId` come
across broken on purpose; `identity.mjs --apply` is what fixes them, in dev.

## 4. Copy the export between buckets and import

⚠️ **The destination prefix's basename must match the source's**, or the import fails. `gcloud
firestore import` derives the metadata filename from the prefix basename — it looks for
`<prefix>/<basename>.overall_export_metadata` — while `rsync` keeps the original filename
`to-dev-<stamp>.overall_export_metadata`. Copying into a prefix named `from-prod-<stamp>` gives
a `NOT_FOUND` on a path that does not exist, and passing the metadata file explicitly does not
help: gcloud appends `.overall_export_metadata` to whatever it is given. So keep the name:

```bash
gcloud storage rsync -r gs://rainbow-prod-2454b-exports/to-dev-<stamp> \
                        gs://kidclub-dev-exports/to-dev-<stamp>
gcloud storage du -s gs://kidclub-dev-exports/to-dev-<stamp>/ \
                     gs://rainbow-prod-2454b-exports/to-dev-<stamp>/   # sizes must match
gcloud firestore import gs://kidclub-dev-exports/to-dev-<stamp> --project kidclub-dev
```

The copy has to go through dev's own bucket rather than importing straight from prod's:
dev's service agent has no read access to `rainbow-prod-2454b-exports`.

Delete both temporary export prefixes afterwards.

⚠️ **gcloud's own credentials can expire mid-runbook** (they did on 2026-09-23, between the
copy and the import). `gcloud auth login` is interactive, so an agent cannot recover from it —
if you are handing this to one, re-auth first.

## 5. Post-import fixes

1. **Re-enter dev's own transport costs.** The import overwrites `config/transportation`
   wholesale with prod's doc, which has no `driverMonthlyCost` / `electricityMonthlyCost`.
   Re-enter €1400 / €300 in the Financial Summary "Custos Fixos" panel if dev testing still
   wants them.
2. **Point one family at a real dev Auth UID.** Firebase Auth is per-project and a Firestore
   wipe does not touch it, so every imported `primaryContact.userId` is a *prod* UID matching
   no dev account. Pick a test family and set `primaryContact.userId` to a real `kidclub-dev`
   UID, or the parent path cannot be validated at all.
3. **The parent path cannot be validated as `renato343@gmail.com`** — that account holds
   `owner: true, rainbowAdmin: true` in dev's `users`, and `setReservationEventStatus` checks
   staff first, so it never reaches the family check. Use a non-staff dev account.

## 6. Then, and only then, the migration — in this order

```bash
cd scripts/kidclub-migration
node identity.mjs  --project kidclub-dev                 # dry run, review
node identity.mjs  --project kidclub-dev --apply         # ~25 identity writes
node migrate.mjs   --project kidclub-dev                 # dry run, review
node migrate.mjs   --project kidclub-dev --apply         # dates → events → absences → billing
node reconcile-report.mjs --project kidclub-dev          # verify
```

The order is a correctness rule, not a preference — `migrate.mjs` refuses to `--apply` while
any active subscription still has no `familyId`, and its step 1 (date repairs) runs before
generation because clearing `endDate` fires `regenerateFutureEvents()`, which voids and
recreates future events.

## 7. Verify

`reconcile-report.mjs --project kidclub-dev` should reproduce the prod figures: Carolina
**€182.40**, José Eduardo **€165.12**, Maria Manon **€130.56**, Mogo **€210.00**,
**+€53.28/month**, and August 2027 at **€2,134.56** once the endDates are cleared.

If it disagrees, that is a finding — investigate before assuming the report is right.
