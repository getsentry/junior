/**
 * Hosts of the browser push services. A push endpoint is a URL that the
 * browser gives us, and Junior sends a POST request to it. Only these hosts
 * are accepted, so a user cannot make Junior send requests to other servers.
 */
const PUSH_SERVICE_HOSTS = [
  // Chrome, Edge on Android, Opera, Samsung Internet and other Chromium browsers.
  "fcm.googleapis.com",
  // Firefox.
  "push.services.mozilla.com",
  // Safari on macOS, iOS and iPadOS.
  "push.apple.com",
  // Edge on Windows.
  "notify.windows.com",
];

/**
 * Return true when the endpoint is an HTTPS URL on the default port of a
 * known browser push service host or one of its subdomains.
 */
export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password) {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}
