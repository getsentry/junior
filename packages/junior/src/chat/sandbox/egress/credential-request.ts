import {
  HOST_MANAGED_CREDENTIAL_PLACEHOLDER,
  resolveAuthTokenPlaceholder,
} from "@/chat/plugins/auth/auth-token-placeholder";
import type { PluginManifest } from "@/chat/plugins/types";

// Module overview: decide whether one Sandbox request asks for its plugin's
// credential.
//
// Code in the Sandbox is untrusted, so a request to a provider domain does not
// get the Actor's credential only because of where it goes. A tool asks for a
// credential by sending its plugin's placeholder. A request that carries its
// own credential, such as a test login, keeps it. A browser never gets one,
// because page scripts are untrusted and can send the placeholder too.

/** How one Sandbox request relates to its plugin's credential. */
export type SandboxCredentialRequest =
  /** It sends the plugin's placeholder, so it asks for the credential. */
  | "placeholder"
  /** It sends its own credential, which the host never replaces. */
  | "carried"
  /** It comes from a browser, which never gets the credential. */
  | "browser"
  /** It sends no credential. */
  | "none";

// Headers that carry a credential for any provider. Cookies are included, so
// a browser session that a person signed in keeps its own identity.
const CREDENTIAL_HEADERS = ["authorization", "cookie"];

// Browsers, such as the Chromium that Playwright drives, send Fetch Metadata
// headers on every request. CLIs and git do not. Sandbox code can omit these
// headers, so this is not a security boundary; it keeps page traffic, which
// the code did not write, from acting as the Actor.
const BROWSER_HEADER = "sec-fetch-mode";

function placeholders(manifest: PluginManifest): string[] {
  return [
    HOST_MANAGED_CREDENTIAL_PLACEHOLDER,
    ...(manifest.credentials
      ? [resolveAuthTokenPlaceholder(manifest.credentials)]
      : []),
  ];
}

function credentialHeaders(manifest: PluginManifest): Set<string> {
  return new Set(
    [
      ...CREDENTIAL_HEADERS,
      ...Object.keys(manifest.apiHeaders ?? {}),
      ...Object.keys(manifest.credentials?.apiHeaders ?? {}),
    ].map((name) => name.toLowerCase()),
  );
}

// Git and other tools send the placeholder as the password of Basic auth.
function decodedBasicAuth(value: string): string | undefined {
  const match = /^basic\s+(\S+)$/i.exec(value.trim());
  if (!match?.[1]) {
    return undefined;
  }
  return Buffer.from(match[1], "base64").toString("utf8");
}

function hasPlaceholder(value: string, markers: string[]): boolean {
  const decoded = decodedBasicAuth(value);
  return markers.some(
    (marker) =>
      value.includes(marker) ||
      (decoded !== undefined && decoded.includes(marker)),
  );
}

/**
 * Classify one Sandbox request by the credential it sends.
 *
 * A browser request is `browser`, whatever it sends. Otherwise a credential
 * header with any value other than a placeholder makes the request `carried`, even when another header has a placeholder, so the host
 * never replaces a credential that the request brought.
 */
export function classifySandboxCredentialRequest(
  manifest: PluginManifest,
  headers: Headers,
): SandboxCredentialRequest {
  if (headers.has(BROWSER_HEADER)) {
    return "browser";
  }
  const markers = placeholders(manifest);
  const names = credentialHeaders(manifest);
  let sawPlaceholder = false;
  for (const [key, value] of headers) {
    if (hasPlaceholder(value, markers)) {
      sawPlaceholder = true;
    } else if (names.has(key) && value.trim()) {
      return "carried";
    }
  }
  return sawPlaceholder ? "placeholder" : "none";
}

/**
 * Return whether the host adds the plugin's credential to a Sandbox request.
 *
 * A request gets a credential when it sends the plugin's placeholder, or when
 * it sends no credential and the plugin says that its tools send none.
 */
export function sandboxRequestGetsCredential(
  manifest: PluginManifest,
  request: SandboxCredentialRequest,
): boolean {
  return (
    request === "placeholder" ||
    (request === "none" && manifest.toolsSendNoCredential === true)
  );
}
