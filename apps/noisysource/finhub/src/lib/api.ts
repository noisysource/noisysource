// The app's calls to its backend. Strata (AI Studio) ran an Express server
// next to the page and called it with fetch('/api/...'). Here that server is
// one callable function, `finhubApi` (firebase/noisysource/functions/src/finhub),
// which checks the caller is FinHub's owner and caps the AI calls per day.
//
// apiFetch keeps fetch's shape (ok, status, json, text) so the views didn't
// need rewriting: it sends { route, body, workspaceToken } to the callable and
// hands back what the route answered.
import { httpsCallable, type FunctionsError } from 'firebase/functions';
import { functions } from '../firebase';

interface ApiAnswer {
  status: number;
  body: unknown;
}

// Long documents and Drive scans can take minutes (the function allows 540 s).
const call = httpsCallable<
  { route: string; body: unknown; workspaceToken: string | null },
  ApiAnswer
>(functions, 'finhubApi', { timeout: 540_000 });

const CALLABLE_STATUS: Record<string, number> = {
  'functions/unauthenticated': 401,
  'functions/permission-denied': 403,
  'functions/invalid-argument': 400,
  'functions/not-found': 404,
  'functions/resource-exhausted': 429,
  'functions/deadline-exceeded': 504,
  'functions/unavailable': 503,
};

export interface ApiResponse {
  ok: boolean;
  status: number;
  json(): Promise<any>;
  text(): Promise<string>;
}

function answer(status: number, body: unknown): ApiResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

export async function apiFetch(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<ApiResponse> {
  const route = path.replace(/^\/api\//, '');
  const auth = init.headers?.Authorization ?? init.headers?.authorization ?? '';
  const workspaceToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() || null : null;
  const body = init.body ? JSON.parse(init.body) : {};
  try {
    const { data } = await call({ route, body, workspaceToken });
    return answer(data.status, data.body);
  } catch (err) {
    const e = err as FunctionsError;
    return answer(CALLABLE_STATUS[e.code] ?? 500, { error: e.message || 'FinHub backend error' });
  }
}
