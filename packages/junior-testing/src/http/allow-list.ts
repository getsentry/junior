const LOCAL_TEST_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const LIVE_TEST_HTTP_HOST_ALLOWLIST = new Set([
  "oidc.vercel.com",
  "vercel.app",
  "vercel.com",
  "vercel.run",
  "vercel.sh",
]);

const LIVE_TEST_HTTP_HOST_SUFFIX_ALLOWLIST = [
  ".vercel.app",
  ".vercel.com",
  ".vercel.run",
  ".vercel.sh",
] as const;

/** Return whether a test HTTP request is allowed to bypass fixtures. */
export function allowsLiveTestHttpHost(
  hostname: string,
  options: { juniorBaseUrl?: string | undefined } = {},
): boolean {
  if (LOCAL_TEST_HTTP_HOSTS.has(hostname) || hostname.endsWith(".localhost")) {
    return true;
  }

  const juniorBaseUrl = options.juniorBaseUrl?.trim();
  if (juniorBaseUrl) {
    if (hostname === new URL(juniorBaseUrl).hostname) {
      return true;
    }
  }

  return (
    LIVE_TEST_HTTP_HOST_ALLOWLIST.has(hostname) ||
    LIVE_TEST_HTTP_HOST_SUFFIX_ALLOWLIST.some((suffix) =>
      hostname.endsWith(suffix),
    )
  );
}
