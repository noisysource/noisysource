/**
 * Where this page was served from.
 *
 * Two unrelated decisions hang off the same question — whether to require
 * sign-in, and whether the LAN bridge is worth trying — so the test lives in
 * one place rather than being written twice with different edge cases.
 */
export function isLanOrigin(): boolean {
  const { hostname } = window.location;
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.endsWith('.local') ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

/**
 * Running as an app added to the home screen, rather than in a browser tab.
 * iOS reports it through `navigator.standalone`; everything else through the
 * display-mode media query.
 */
export function isInstalledApp(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

/** Served over HTTPS from one of the project's own Firebase Hosting domains. */
export function isFirebaseHosting(): boolean {
  const { protocol, hostname } = window.location;
  return protocol === 'https:' && (hostname.endsWith('.web.app') || hostname.endsWith('.firebaseapp.com'));
}
