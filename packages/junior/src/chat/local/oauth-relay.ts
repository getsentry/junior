import { randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";

const LOCAL_OAUTH_STATE_PREFIX = "jr-local";
const LOCAL_OAUTH_TOKEN_CONTEXT = "junior.local-oauth-relay.v1";
const LOCAL_OAUTH_TOKEN_TTL = "10m";
const localOAuthRelayPayloadSchema = z
  .object({
    aud: z.literal(LOCAL_OAUTH_TOKEN_CONTEXT),
    exp: z.number().int(),
    iss: z.literal(LOCAL_OAUTH_TOKEN_CONTEXT),
    jti: z.string().min(1),
    port: z.number().int().min(1).max(65_535),
  })
  .strict();

/** Derive the HMAC key used only for signed local OAuth relay state. */
function relayKey(): Uint8Array {
  const secret = process.env.JUNIOR_SECRET?.trim();
  if (!secret) {
    throw new Error("Local OAuth requires JUNIOR_SECRET");
  }
  return new TextEncoder().encode(secret);
}

/** Create an OAuth state value that can be safely relayed to a local CLI callback. */
export async function createLocalOAuthState(port: number): Promise<string> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Local OAuth callback port is invalid");
  }
  const token = await new SignJWT({ port })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(LOCAL_OAUTH_TOKEN_CONTEXT)
    .setAudience(LOCAL_OAUTH_TOKEN_CONTEXT)
    .setJti(randomBytes(24).toString("base64url"))
    .setExpirationTime(LOCAL_OAUTH_TOKEN_TTL)
    .sign(relayKey());
  return `${LOCAL_OAUTH_STATE_PREFIX}.${token}`;
}

/** Resolve a signed local OAuth state to its loopback callback port. */
async function localOAuthRelayPort(state: string): Promise<number | undefined> {
  const prefix = `${LOCAL_OAUTH_STATE_PREFIX}.`;
  if (!state.startsWith(prefix)) {
    return undefined;
  }
  try {
    const { payload } = await jwtVerify(
      state.slice(prefix.length),
      relayKey(),
      {
        algorithms: ["HS256"],
        issuer: LOCAL_OAUTH_TOKEN_CONTEXT,
        audience: LOCAL_OAUTH_TOKEN_CONTEXT,
      },
    );
    const parsed = localOAuthRelayPayloadSchema.safeParse(payload);
    return parsed.success ? parsed.data.port : undefined;
  } catch {
    return undefined;
  }
}

/** Redirect a provider callback from the public dev URL to the owning local CLI. */
export async function relayLocalOAuthCallback(
  request: Request,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.searchParams.get("jr_local_relay") === "complete") {
    return undefined;
  }
  const state = url.searchParams.get("state");
  const port = state ? await localOAuthRelayPort(state) : undefined;
  if (!port) {
    return undefined;
  }
  url.protocol = "http:";
  url.hostname = "127.0.0.1";
  url.port = String(port);
  url.searchParams.set("jr_local_relay", "complete");
  return Response.redirect(url, 302);
}
