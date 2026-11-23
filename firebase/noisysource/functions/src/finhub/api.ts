import { HttpsError, onCall } from "firebase-functions/v2/https";
import { requireFinhubUser } from "./access";
import { routes } from "./routes";

interface ApiRequest {
  route?: unknown;
  body?: unknown;
  workspaceToken?: unknown;
}

/**
 * The FinHub app's whole backend, one callable (apps/noisysource/finhub/src/lib/api.ts).
 * `route` names one of routes.ts's handlers; the answer is what it would have
 * sent as HTTP: { status, body }. The Google token for Gmail/Drive is the
 * signed-in user's own, from the app's sign-in, and is used for that request
 * only (never stored).
 */
export const finhubApi = onCall(
  // Reading a long PDF with Gemini, or a Drive folder, takes minutes.
  { timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    requireFinhubUser(request.auth);
    const { route, body, workspaceToken } = (request.data ?? {}) as ApiRequest;
    if (typeof route !== "string" || !Object.prototype.hasOwnProperty.call(routes, route)) {
      throw new HttpsError("not-found", "Unknown FinHub route");
    }
    if (workspaceToken !== undefined && workspaceToken !== null && typeof workspaceToken !== "string") {
      throw new HttpsError("invalid-argument", "workspaceToken must be a string");
    }

    let status = 200;
    let answer: unknown = null;
    const res = {
      status(code: number) {
        status = code;
        return res;
      },
      json(b: unknown) {
        answer = b;
      },
    };
    try {
      await routes[route](
        {
          body: body ?? {},
          headers: workspaceToken ? { authorization: `Bearer ${workspaceToken}` } : {},
        },
        res,
      );
    } catch (err) {
      // The daily cap, thrown from inside a route: let the app see it as such.
      if (err instanceof HttpsError) throw err;
      throw new HttpsError("internal", err instanceof Error ? err.message : "FinHub route failed");
    }
    return { status, body: answer };
  },
);
