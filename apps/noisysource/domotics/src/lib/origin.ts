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
