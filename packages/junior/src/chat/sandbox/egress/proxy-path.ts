// The sandbox egress proxy URL carries the signed credential token as its first
// path segment. This module has no imports so the Sentry payload filter can
// redact it during SDK setup.

export const SANDBOX_EGRESS_PROXY_PATH = "/api/internal/sandbox-egress";

const PROXY_PATH_PREFIX = `${SANDBOX_EGRESS_PROXY_PATH}/`;
// The local signals route takes the token in a header, not in its path.
const SIGNALS_SEGMENT = "signals";

/**
 * Replace the credential token and everything after it in a sandbox egress
 * proxy path or URL. Other values are returned unchanged.
 */
export function redactSandboxEgressProxyPath(value: string): string {
  const index = value.indexOf(PROXY_PATH_PREFIX);
  if (index === -1) {
    return value;
  }
  const rest = value.slice(index + PROXY_PATH_PREFIX.length);
  if (rest.split(/[/?#]/, 1)[0] === SIGNALS_SEGMENT) {
    return value;
  }
  return `${value.slice(0, index)}${PROXY_PATH_PREFIX}<token>`;
}
