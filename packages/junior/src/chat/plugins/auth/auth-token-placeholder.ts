import type { OAuthBearerCredentials } from "../types";

/**
 * Marks a sandbox credential placeholder.
 *
 * Every sandbox credential placeholder contains this text. Sandbox egress adds
 * provider credentials only to requests that carry it, so other clients in the
 * sandbox, such as a browser, keep their own login.
 */
export const HOST_MANAGED_CREDENTIAL_MARKER = "host_managed_credential";

const DEFAULT_PLACEHOLDERS: Record<OAuthBearerCredentials["type"], string> = {
  "oauth-bearer": HOST_MANAGED_CREDENTIAL_MARKER,
};

/** Resolve the non-secret sandbox token placeholder for token-backed credentials. */
export function resolveAuthTokenPlaceholder(
  credentials: OAuthBearerCredentials,
): string {
  return (
    credentials.authTokenPlaceholder?.trim() ||
    DEFAULT_PLACEHOLDERS[credentials.type]
  );
}

function decodedBasicCredentials(value: string): string | undefined {
  const match = /^basic\s+(\S+)\s*$/i.exec(value);
  if (!match) {
    return undefined;
  }
  try {
    return Buffer.from(match[1]!, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

/**
 * Return whether a sandbox request asks the host to add provider credentials.
 *
 * Clients ask by sending a credential placeholder in any auth header, in any
 * scheme (`Bearer`, `token`, an API key header, or `Basic` user:password).
 * Cookies are not checked: a browser login is never a placeholder.
 */
export function hasHostManagedCredentialPlaceholder(headers: Headers): boolean {
  let found = false;
  headers.forEach((value, key) => {
    if (found || key.toLowerCase() === "cookie") {
      return;
    }
    found =
      value.includes(HOST_MANAGED_CREDENTIAL_MARKER) ||
      Boolean(
        decodedBasicCredentials(value)?.includes(
          HOST_MANAGED_CREDENTIAL_MARKER,
        ),
      );
  });
  return found;
}
