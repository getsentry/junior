import {
  createHmac,
  createSecretKey,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const LOCAL_OAUTH_STATE_PREFIX = "jr-local";
const LOCAL_OAUTH_SIGNATURE_CONTEXT = "junior.local-oauth-relay.v1";

function relaySecret(): string {
  const secret = process.env.JUNIOR_SECRET?.trim();
  if (!secret) {
    throw new Error("Local OAuth requires JUNIOR_SECRET");
  }
  return secret;
}

function relaySignature(port: number, nonce: string): string {
  const signingKey = createSecretKey(Buffer.from(relaySecret(), "utf8"));
  return createHmac("sha256", signingKey)
    .update(`${LOCAL_OAUTH_SIGNATURE_CONTEXT}:${port}:${nonce}`)
    .digest("base64url");
}

/** Create an OAuth state value that can be safely relayed to a local CLI callback. */
export function createLocalOAuthState(port: number): string {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Local OAuth callback port is invalid");
  }
  const nonce = randomBytes(24).toString("base64url");
  return [
    LOCAL_OAUTH_STATE_PREFIX,
    String(port),
    nonce,
    relaySignature(port, nonce),
  ].join(".");
}

/** Resolve a signed local OAuth state to its loopback callback port. */
export function localOAuthRelayPort(state: string): number | undefined {
  const [prefix, portText, nonce, signature, ...extra] = state.split(".");
  if (
    prefix !== LOCAL_OAUTH_STATE_PREFIX ||
    !portText ||
    !nonce ||
    !signature ||
    extra.length > 0
  ) {
    return undefined;
  }
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return undefined;
  }
  const expected = Buffer.from(relaySignature(port, nonce));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return undefined;
  }
  return port;
}

/** Redirect a provider callback from the public dev URL to the owning local CLI. */
export function relayLocalOAuthCallback(
  request: Request,
): Response | undefined {
  const url = new URL(request.url);
  if (url.searchParams.get("jr_local_relay") === "complete") {
    return undefined;
  }
  const state = url.searchParams.get("state");
  const port = state ? localOAuthRelayPort(state) : undefined;
  if (!port) {
    return undefined;
  }
  url.protocol = "http:";
  url.hostname = "127.0.0.1";
  url.port = String(port);
  url.searchParams.set("jr_local_relay", "complete");
  return Response.redirect(url, 302);
}
