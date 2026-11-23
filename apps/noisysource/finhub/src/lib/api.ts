// What Strata's Express server used to answer (fetch('/api/...')): reading
// payslips, statements and invoices with Gemini, Gmail and Drive scans, AI
// match suggestions. FinHub has no AI and no server of its own any more:
// Atlas reads the documents (it already has Drive and Gmail) and writes what it
// finds into FinHub's books, where these screens show it (decided 2026-11-23,
// apps/noisysource/finhub/STATUS.md).
//
// apiFetch keeps the fetch shape the views were written against and answers
// every former route with a clear message, so the old buttons say where the
// work went instead of failing silently. The views that use it become
// "what Atlas imported" as the Atlas side is built.
export interface ApiResponse {
  ok: boolean;
  status: number;
  json(): Promise<any>;
  text(): Promise<string>;
}

export const MOVED_TO_ATLAS =
  'Document reading moved to Atlas: ask Atlas to import the month (e.g. "import March 2026 for Noisy Source"), and what it finds appears here.';

export async function apiFetch(
  _path: string,
  _init: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<ApiResponse> {
  const body = { error: MOVED_TO_ATLAS };
  return {
    ok: false,
    status: 410,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
