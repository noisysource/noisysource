#!/bin/bash
#
# Creates (or updates) the Firebase Auth account Atlas signs in as. Atlas is
# Renato's assistant (repo noisysource/Atlas, on his Mac); with this account it
# sees and runs the house through the Domotics backend, the way the app does.
#
# Run this on the Mac. It needs `gcloud auth login` to be current.
#
#   ./deploy/create-agent-user.sh noisysource-prod [atlas@kidclub.pt]
#
# A user account, like the bridge's (create-bridge-user.sh), and for the same
# reason: the Firestore rules (isAtlas) and the callables (requireOwnerOrAgent)
# decide what it may do, where a service account's role would not. The account
# is created verified, because the rules and the callables only take a verified
# address. Email/password sign-in is already on (the bridge uses it).
#
# The password is yours to choose: the script asks for it twice, never prints
# it and writes it nowhere. You type the same one into Atlas afterwards.
set -euo pipefail

PROJECT="${1:-}"
EMAIL="${2:-atlas@kidclub.pt}"
case "$PROJECT" in
  noisysource-prod | noisysource-dev) ;;
  *) echo "usage: $0 <noisysource-prod | noisysource-dev> [email]"; exit 1 ;;
esac
# The rules and the callables know Atlas by this one address.
if [ "$EMAIL" != "atlas@kidclub.pt" ]; then
  echo "note: the rules (isAtlas) and the callables (AGENT_EMAIL) only know atlas@kidclub.pt;"
  echo "      $EMAIL will be able to sign in and do nothing until they are changed."
fi

command -v gcloud >/dev/null || { echo "gcloud not found"; exit 1; }
command -v node >/dev/null || { echo "node not found"; exit 1; }
TOKEN=$(gcloud auth print-access-token 2>/dev/null) || {
  echo "gcloud is not authenticated. Run: gcloud auth login"; exit 1; }
AUTH=(-H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT" -H "Content-Type: application/json")
API="https://identitytoolkit.googleapis.com/v1/projects/$PROJECT"

read -r -s -p "Password for $EMAIL (at least 16 characters): " PASSWORD; echo
[ "${#PASSWORD}" -ge 16 ] || { echo "too short: at least 16 characters"; exit 1; }
read -r -s -p "Again: " PASSWORD2; echo
[ "$PASSWORD" = "$PASSWORD2" ] || { echo "the two don't match"; exit 1; }
unset PASSWORD2

# The request body goes from node to curl through a pipe, and the password
# reaches node in the environment of that one command: never in an argument
# list (visible in `ps`), never in a file.
body() { # body <localId or ""> : {email, password, emailVerified[, localId]} on stdout
  AGENT_PASSWORD="$PASSWORD" node -e '
    const [email, localId] = process.argv.slice(1);
    const b = { email, password: process.env.AGENT_PASSWORD, emailVerified: true };
    if (localId) b.localId = localId;
    process.stdout.write(JSON.stringify(b));
  ' "$EMAIL" "$1"
}
# Prints the response's localId, or the API's error and fails.
local_id='let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  let c; try { c = JSON.parse(s); } catch { console.error("   unexpected answer from the API"); process.exit(1); }
  if (c.error) { console.error("   error: " + c.error.message); process.exit(1); }
  console.log(c.localId || "");});'

echo "1. looking for $EMAIL in $PROJECT"
EXISTING=$(curl -s --max-time 30 "${AUTH[@]}" -X POST "$API/accounts:query" \
  -d "$(node -e 'console.log(JSON.stringify({expression:[{email:process.argv[1]}]}))' "$EMAIL")" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const c=JSON.parse(s);
      if(c.error){console.error("   error: "+c.error.message);process.exit(1);}
      console.log((c.userInfo||[])[0]?.localId||"");});')

if [ -n "$EXISTING" ]; then
  echo "2. it exists: setting its password and marking it verified"
  UID_OUT=$(body "$EXISTING" | curl -s --max-time 30 "${AUTH[@]}" -X PATCH "$API/accounts" -d @- | node -e "$local_id")
else
  echo "2. creating it, verified"
  UID_OUT=$(body "" | curl -s --max-time 30 "${AUTH[@]}" -X POST "$API/accounts" -d @- | node -e "$local_id")
fi
unset PASSWORD
[ -n "$UID_OUT" ] || { echo "   the API returned no account id"; exit 1; }

echo
echo "   account : $EMAIL (verified)"
echo "   uid     : $UID_OUT"
echo "   project : $PROJECT"
echo
echo "What this address may read and change is in the project's Firestore rules"
echo "(isAtlas) and callables (requireOwnerOrAgent); CI deploys them."
echo
case "$PROJECT" in
  noisysource-prod) ENV_NAME=.env.nsprod ;;
  *)                ENV_NAME=.env.nsdev ;;
esac
echo "Next, in Atlas (type the same password when it asks):"
echo
echo "   npm run house:connect -- $PROJECT <VITE_FIREBASE_API_KEY from apps/noisysource/domotics/$ENV_NAME> $EMAIL"
