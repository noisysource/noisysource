#!/bin/bash
#
# Creates the Firebase Auth account the bridge signs in as, and writes the
# credentials the Pi needs to deploy/bridge.env.
#
# Run this on the Mac, once. It needs `gcloud auth login` to be current.
#
# Why a user account and not a service account: key creation is refused by the
# org policy iam.disableServiceAccountKeyCreation, and the role that path needed
# (roles/datastore.user) would have granted this Raspberry Pi read/write over
# every collection in the project — including the finances bank data. Signing in
# as a user means firestore.rules decides what the bridge may touch, which is
# both narrower and easier to audit.
#
# The password is generated here and written straight to bridge.env. It is never
# printed, and bridge.env is gitignored.
set -euo pipefail

PROJECT=kidclub-dev
EMAIL=domotics-bridge@kidclub.pt
HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$HERE/bridge.env"
APP_ENV="$HERE/../../domotics/.env.development"

command -v gcloud >/dev/null || { echo "gcloud not found"; exit 1; }
TOKEN=$(gcloud auth print-access-token 2>/dev/null) || {
  echo "gcloud is not authenticated. Run: gcloud auth login"; exit 1; }
AUTH=(-H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT" -H "Content-Type: application/json")

# Read via node rather than grep|cut|tr: quoting a `tr -d` set containing both
# quote characters is error-prone enough that the first version silently
# deleted every "r" and backslash from the key.
API_KEY=$(node -e '
  const fs = require("fs");
  const prefix = "VITE_FIREBASE_API_KEY=";
  const line = fs.readFileSync(process.argv[1], "utf8")
    .split(/\r?\n/).find(l => l.startsWith(prefix));
  process.stdout.write(line ? line.slice(prefix.length).replace(/^["\x27]|["\x27]$/g, "").trim() : "");
' "$APP_ENV")
[ -n "$API_KEY" ] || { echo "could not read VITE_FIREBASE_API_KEY from $APP_ENV"; exit 1; }

echo "1. enabling email/password sign-in on $PROJECT"
curl -s --max-time 30 "${AUTH[@]}" -X PATCH \
  "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT/config?updateMask=signIn.email.enabled,signIn.email.passwordRequired" \
  -d '{"signIn":{"email":{"enabled":true,"passwordRequired":true}}}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s);
      if(c.error){console.error("   error: "+c.error.message);process.exit(1);}
      console.log("   email/password:", c.signIn?.email?.enabled ? "enabled":"disabled");});'

# Reuse an existing password on re-run, so a Pi already in the field does not
# get orphaned by a rotation it never hears about.
if [ -f "$ENV_FILE" ] && grep -q '^BRIDGE_PASSWORD=' "$ENV_FILE"; then
  PASSWORD=$(grep '^BRIDGE_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
  echo "2. reusing the password already in bridge.env"
else
  # No pipeline here on purpose. `tr -dc … < /dev/urandom | head -c 40` makes
  # head exit first, tr take SIGPIPE, and `set -o pipefail` kill the script
  # without a word — which is exactly how the first run died after step 1.
  PASSWORD=$(node -e '
    process.stdout.write(require("crypto").randomBytes(48).toString("base64url").slice(0, 40));
  ')
  echo "2. generated a new 40-character password"
fi

echo "3. creating $EMAIL"
BODY=$(node -e 'console.log(JSON.stringify({email:process.argv[1],password:process.argv[2],emailVerified:true}))' "$EMAIL" "$PASSWORD")
RESULT=$(curl -s --max-time 30 "${AUTH[@]}" -X POST \
  "https://identitytoolkit.googleapis.com/v1/projects/$PROJECT/accounts" -d "$BODY")

if printf '%s' "$RESULT" | grep -q EMAIL_EXISTS; then
  echo "   already exists — resetting its password to match bridge.env"
  EXISTING=$(curl -s --max-time 30 "${AUTH[@]}" -X POST \
    "https://identitytoolkit.googleapis.com/v1/projects/$PROJECT/accounts:query" \
    -d "$(node -e 'console.log(JSON.stringify({expression:[{email:process.argv[1]}]}))' "$EMAIL")" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        const c=JSON.parse(s);console.log((c.userInfo||[])[0]?.localId||"");});')
  [ -n "$EXISTING" ] || { echo "   could not locate the account"; exit 1; }
  curl -s --max-time 30 "${AUTH[@]}" -X PATCH \
    "https://identitytoolkit.googleapis.com/v1/projects/$PROJECT/accounts" \
    -d "$(node -e 'console.log(JSON.stringify({localId:process.argv[1],password:process.argv[2]}))' "$EXISTING" "$PASSWORD")" >/dev/null
  UID_OUT="$EXISTING"
else
  UID_OUT=$(printf '%s' "$RESULT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const c=JSON.parse(s);
    if(c.error){console.error("   error: "+c.error.message);process.exit(1);}
    console.log(c.localId);});')
fi

umask 077
cat > "$ENV_FILE" <<EOF
# Credentials for the domotics bridge. Contains a password — 0600, gitignored.
# Regenerate with deploy/create-bridge-user.sh
FIREBASE_API_KEY=$API_KEY
BRIDGE_EMAIL=$EMAIL
BRIDGE_PASSWORD=$PASSWORD
EOF
chmod 600 "$ENV_FILE"

echo
echo "   account : $EMAIL"
echo "   uid     : $UID_OUT"
echo "   written : $ENV_FILE (0600, password not shown)"
echo
echo "firestore.rules already grants this address exactly:"
echo "  read  domotics_config/tuya_devices"
echo "  write domotics_state/*"
echo "  read/update/delete domotics_commands/*"
echo "and nothing else. Deploy the rules before the bridge will work:"
echo "  npx firebase-tools deploy --only firestore:rules --project $PROJECT"
