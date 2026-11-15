import { setGlobalOptions } from "firebase-functions/v2";

// Every function in this codebase: Frankfurt, a small instance cap (these are
// one person's tools; a runaway loop should hit a wall, not a bill), and the
// runtime account from Terraform, which can use Firestore and write logs and
// nothing else.
//
// This is its own module, imported first in index.ts, on purpose: imports run
// before the importing file's own statements, so a setGlobalOptions call
// written in index.ts would run after every function was already defined with
// the defaults (us-central1, the default account, no cap). That happened on
// the first deploy.
setGlobalOptions({
  region: "europe-west3",
  maxInstances: 3,
  serviceAccount: "functions-runtime@",
});
