/** Loopback hostnames, in the bracketed form that `URL.hostname` uses. */
export const LOOPBACK_HOSTNAMES: readonly string[] = [
  "localhost",
  "127.0.0.1",
  "[::1]",
];

/**
 * Resolve the public origin of this Junior app for browser sign-in and
 * protocol metadata. A configured origin always wins. The request origin is
 * used only on loopback, because a deployed request can carry any host.
 */
export function resolvePublicOrigin(
  request: Request,
  configured?: string,
): URL | undefined {
  const value = configured?.trim();
  let origin: string;
  if (value) {
    origin = /^https?:\/\//.test(value) ? value : `https://${value}`;
  } else {
    const requestURL = new URL(request.url);
    if (!LOOPBACK_HOSTNAMES.includes(requestURL.hostname)) return undefined;
    origin = requestURL.origin;
  }
  const url = new URL(origin);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}
