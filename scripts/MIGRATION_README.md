# Migration Script: Legacy Subscriptions → Family-Centric Model

This script migrates existing subscriptions from the legacy model (userId-based) to the new family-centric model (familyId + childId).

## What it does

1. **Creates Family records** from existing users (if they don't exist)
2. **Creates Child records** from subscription data (student names, school info)
3. **Links subscriptions** to families and children by:
   - Matching student names from subscriptions to children
   - Creating children when they don't exist
4. **Updates all subscriptions** with `familyId` and `childId` fields

## Requirements

- Node.js installed
- Firebase Admin SDK (already in dependencies)
- Service account JSON file in `scripts/` directory:
  - `dev-service-account.json` (for dev project)
  - `prod-service-account.json` (for prod project)

## Usage

### Dry Run (Recommended First)

Test the migration without making changes:

```bash
node scripts/migrate-to-family-model.js --dry-run --project=dev
```

### Live Migration

Run the actual migration (requires confirmation):

```bash
node scripts/migrate-to-family-model.js --project=dev
```

Or for production:

```bash
node scripts/migrate-to-family-model.js --project=prod
```

## What Gets Migrated

### Study Room Subscriptions
- Collections: `studyroom`
- Fields migrated:
  - `userId` → creates/finds Family → sets `familyId`
  - `studentName` → creates/finds Child → sets `childId`
  - `studentAge` → sets `childAge`
  - Preserves all existing subscription data

### Transport Subscriptions
- Collections: `transportationSubscriptions`
- Fields migrated:
  - `userId` or `contactEmail` → creates/finds Family → sets `familyId`
  - `studentName` → creates/finds Child → sets `childId`
  - `studentAge` → sets `childAge`
  - Preserves all existing subscription data

### Party Bookings
- Collections: `bookings`
- Fields migrated:
  - `email` → finds user → creates/finds Family → sets `familyId`
  - `childName` → creates/finds Child → sets `childId` (if available)
  - Preserves all existing booking data

## Migration Logic

### Family Creation
- Looks up user by `userId` in Firebase Auth
- Creates Family record with:
  - `primaryContact.userId`: Firebase Auth UID
  - `primaryContact.email`: User's email
  - `primaryContact.name`: Display name or email username
  - `status`: 'active'

### Child Matching/Creation
- Tries to match by `firstName` + `lastName` within the same family
- If no match found, creates new Child with:
  - Name from subscription's `studentName`
  - School info from subscription (if available)
  - Estimated date of birth from age (if available)
  - Default age of 5 if no age provided

### Subscription Updates
- Adds `familyId` field linking to Family
- Adds `childId` field linking to Child
- Adds `childName` for denormalized quick access
- Updates `updatedAt` timestamp
- Preserves all other existing fields

## Safety Features

1. **Dry Run Mode**: Test without making changes
2. **Confirmation Prompt**: Asks for confirmation before live migration
3. **Error Handling**: Logs all errors but continues processing
4. **Idempotent**: Safe to run multiple times (skips already migrated records)
5. **Detailed Logging**: Shows exactly what's being migrated

## Output

The script prints:
- Progress for each subscription being migrated
- Summary statistics:
  - Families Created
  - Children Created
  - Children Matched (existing)
  - Subscriptions Updated (by type)
  - Bookings Updated
  - Errors encountered

## Troubleshooting

### "Service account not found"
Make sure the service account JSON file exists in `scripts/` directory with the correct name.

### "No user found for email"
Some subscriptions might be linked to emails that don't have Firebase Auth accounts. These will be skipped.

### "Cannot create child without first name"
Subscriptions without student names will be skipped.

## After Migration

After running the migration:
1. Verify in Firebase Console that subscriptions have `familyId` and `childId`
2. Check that Family records were created
3. Check that Child records were created and linked correctly
4. Test the client dashboard - subscriptions should now appear under children

## Rollback

If something goes wrong:
1. Firestore has automatic backups
2. You can restore from a backup point
3. Or manually revert the changes (this script doesn't remove fields, just adds new ones)

## Notes

- The migration is **non-destructive** - it only adds new fields
- Legacy fields (`userId`, `studentName`, etc.) are **not removed** (for backwards compatibility)
- The script handles both new and legacy data models
- Subscriptions without `userId` or `studentName` will be skipped












