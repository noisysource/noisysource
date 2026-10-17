import { addDoc, serverTimestamp, Timestamp } from 'firebase/firestore';
import { auth } from './firebase';
import { col } from './db';

// Failed-action tracing: when something a signed-in user does doesn't land
// (permission-denied, a callable error, a save that threw), record it in
// `clientErrors` so it reaches the admin — Admin → "Erros dos clientes" and the
// daily digest email (functions/src/kidclub/clientErrorsDigest.ts).
//
// Why: in Sept–Oct 2026 every parent enrollment failed with permission-denied
// for ~4 weeks, swallowed by a try/finally — parents saw "nothing happened" and
// nobody found out until one phoned. Most failures here are caught and logged
// with console.error, never shown, so that's where this listens, plus unhandled
// promise rejections (the exact shape of that bug) and uncaught errors.
//
// Never throws into the caller and never awaits in its path. Hard-capped per
// page load and deduped, so a page stuck in a failing loop can't become a
// write storm.

const MAX_REPORTS_PER_PAGE_LOAD = 20;
const DEDUPE_WINDOW_MS = 60_000;
const RETENTION_DAYS = 90; // expireAt — for a Firestore TTL policy on clientErrors
const IMPERSONATION_KEY = 'kidclub_impersonate'; // ImpersonationContext's sessionStorage key

type Context = Record<string, string | number | boolean | null>;

let sent = 0;
const lastSentAt = new Map<string, number>();

const clip = (s: unknown, max: number) => String(s ?? '').slice(0, max);

function impersonatingFamilyId(): string | null {
  try {
    const raw = sessionStorage.getItem(IMPERSONATION_KEY);
    return raw ? (JSON.parse(raw).familyId ?? null) : null;
  } catch {
    return null;
  }
}

function isErrorLike(x: unknown): x is { message?: unknown; code?: unknown } {
  return x instanceof Error ||
    (!!x && typeof x === 'object' && typeof (x as any).code === 'string' && 'message' in (x as any));
}

export function reportClientError(action: string, err: unknown, context?: Context): void {
  try {
    const user = auth.currentUser;
    if (!user) return; // rules require a signed-in reporter
    if (sent >= MAX_REPORTS_PER_PAGE_LOAD) return;

    const code = clip((err as any)?.code, 80);
    const message = clip(isErrorLike(err) ? err.message : err, 1000);
    if (message.includes('clientErrors')) return; // never report a failure to report

    const key = `${action}|${code}|${message}`;
    const now = Date.now();
    if (now - (lastSentAt.get(key) ?? 0) < DEDUPE_WINDOW_MS) return;
    lastSentAt.set(key, now);
    sent++;

    const doc: Record<string, unknown> = {
      userId: user.uid,
      email: clip(user.email, 200),
      impersonatingFamilyId: impersonatingFamilyId(),
      action: clip(action, 120),
      code,
      message,
      route: clip(window.location.pathname + window.location.search, 300),
      userAgent: clip(navigator.userAgent, 300),
      mode: import.meta.env.MODE,
      createdAt: serverTimestamp(),
      expireAt: Timestamp.fromMillis(now + RETENTION_DAYS * 86_400_000),
    };
    if (context) doc.context = Object.fromEntries(Object.entries(context).slice(0, 10));

    addDoc(col('clientErrors'), doc).catch(() => { /* best-effort */ });
  } catch {
    // reporting must never break the page
  }
}

let installed = false;

/** Call once at startup (main.tsx). */
export function installClientErrorReporting(): void {
  if (installed) return;
  installed = true;

  window.addEventListener('unhandledrejection', (e) => reportClientError('unhandled-rejection', e.reason));
  window.addEventListener('error', (e) => {
    // Only our own scripts — not browser extensions, not failed <img>/<script> loads.
    if (e.error && (!e.filename || e.filename.startsWith(window.location.origin))) {
      reportClientError('uncaught-error', e.error);
    }
  });

  // Caught-and-logged failures: `console.error('[page] save failed', err)`.
  // Reported only when an error object is among the arguments; the first string
  // argument becomes the action label.
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    original(...args);
    const err = args.find(isErrorLike);
    if (err) reportClientError(typeof args[0] === 'string' ? args[0] : 'console.error', err);
  };
}
