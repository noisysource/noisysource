# Shared Firebase Cloud Functions

> **Context**: See root `../CLAUDE.md` for full group architecture and stack overview.

## Purpose
This directory contains all shared Firebase Cloud Functions used across every NoisySource app. No app should contain its own backend logic — everything lives here.

---

## Structure
```
/functions/
├── CLAUDE.md
├── package.json
├── index.js                  ← entry point, exports all functions
├── src/
│   ├── auth/                 ← user management, auth triggers
│   ├── finances/             ← functions specific to the Finances app
│   ├── domotics/             ← functions specific to Domotics app
│   ├── tasks/                ← functions specific to Tasks app
│   ├── social/               ← functions specific to Social app
│   ├── kidclub/              ← functions specific to KidClub
│   └── shared/               ← truly cross-app utilities (email, notifications, etc.)
└── firestore.rules           ← centralised Firestore security rules
```

---

## Conventions
- **Pure functions preferred** — no classes, functional style throughout
- Each domain folder exports its own functions, `index.js` aggregates
- Use **callable functions** for app-triggered logic
- Use **background triggers** (Firestore, Auth) for reactive logic
- Environment config via Firebase environment variables, never hardcoded

---

## Firestore
- All collections and their schemas are documented in each domain folder
- Security rules live in `firestore.rules` — centralised, reviewed on every change
- Firestore is shared across all apps — namespace collections clearly (e.g. `finances_transactions`, `tasks_events`)

---

## Cost Awareness
- Firebase Cloud Functions free tier: 2M calls/month — sufficient for all internal apps combined
- Avoid unnecessary reads/writes; batch where possible
- Prefer Firestore realtime listeners on the client over polling

---

## Deployment
```bash
# Deploy all functions
firebase deploy --only functions

# Deploy specific function
firebase deploy --only functions:finances-createTransaction
```

---

## Adding a New Function
1. Create or update the relevant domain folder under `src/`
2. Write the function as a named export
3. Import and re-export from `index.js`
4. Update `firestore.rules` if new collections are involved
5. Document the function signature in the domain folder's own `README.md`
