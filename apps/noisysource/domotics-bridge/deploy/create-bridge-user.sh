#!/bin/bash
#
# Creates the Firebase Auth account the bridge signs in as, and writes the
# credentials the Pi needs to deploy/bridge.env.
#
# Run this on the Mac, once per project. It needs `gcloud auth login` to be current.
#
#   ./deploy/create-bridge-user.sh noisysource-prod    # the house's project
#
# bridge.env also carries the project (GCLOUD_PROJECT), so that one file decides
# where the Pi publishes: systemd lets it override the unit's own setting.
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

PROJECT="${1:-}"
EMAIL=domotics-bridge@kidclub.pt
HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$HERE/bridge.env"
# The project's web API key, from the app's committed build config.
case "$PROJECT" in
  noisysource-prod) APP_ENV="$HERE/../../domotics/.env.nsprod" ;;
  noisysource-dev)  APP_ENV="$HERE/../../domotics/.env.nsdev" ;;
  *) echo "usage: $0 <noisysource-prod | noisysource-dev>"; exit 1 ;;
esac

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

# A bridge.env without GCLOUD_PROJECT is from before the cutover: kidclub-dev.
OLD_PROJECT=""
if [ -f "$ENV_FILE" ]; then
  OLD_PROJECT=$(grep '^GCLOUD_PROJECT=' "$ENV_FILE" | cut -d= -f2- || true)
  OLD_PROJECT="${OLD_PROJECT:-kidclub-dev}"
fi
# Another project's file is kept beside the new one (it's the way back), and
# its password is not reused: each project gets its own.
if [ -n "$OLD_PROJECT" ] && [ "$OLD_PROJECT" != "$PROJECT" ]; then
  mv "$ENV_FILE" "$HERE/bridge.env.$OLD_PROJECT"
  chmod 600 "$HERE/bridge.env.$OLD_PROJECT"
  echo "0. kept the $OLD_PROJECT credentials as deploy/bridge.env.$OLD_PROJECT"
fi

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
  # accounts:update (POST) is the admin update; a PATCH on /accounts isn't an
  # endpoint, and its answer was thrown away, so a reset silently did nothing.
  curl -s --max-time 30 "${AUTH[@]}" -X POST \
    "https://identitytoolkit.googleapis.com/v1/projects/$PROJECT/accounts:update" \
    -d "$(node -e 'console.log(JSON.stringify({localId:process.argv[1],password:process.argv[2]}))' "$EXISTING" "$PASSWORD")" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        let c; try { c = JSON.parse(s); } catch { console.error("   unexpected answer from the API"); process.exit(1); }
        if (c.error) { console.error("   error: " + c.error.message); process.exit(1); }});'

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
GCLOUD_PROJECT=$PROJECT
FIREBASE_API_KEY=$API_KEY
BRIDGE_EMAIL=$EMAIL
BRIDGE_PASSWORD=$PASSWORD
EOF
chmod 600 "$ENV_FILE"

# The same sign-in the bridge does on the Pi. If this fails, so will the bridge.
echo "4. signing in as the bridge"
curl -s --max-time 30 -H "Content-Type: application/json" -X POST \
  "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=$API_KEY" \
  -d "$(node -e 'console.log(JSON.stringify({email:process.argv[1],password:process.argv[2],returnSecureToken:true}))' "$EMAIL" "$PASSWORD")" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s);
      if(c.error){console.error("   error: "+c.error.message);process.exit(1);}
      console.log("   ok, signed in as", c.email);});'

echo
echo "   account : $EMAIL"
echo "   uid     : $UID_OUT"
echo "   written : $ENV_FILE (0600, password not shown)"
echo
echo "   project : $PROJECT"
echo
echo "What this address may read and write is in the project's Firestore rules"
echo "(isBridge); CI deploys them."
