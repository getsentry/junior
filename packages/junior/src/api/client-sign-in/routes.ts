/**
 * Own the dashboard API session of Junior's own app clients, such as the iOS
 * app.
 *
 * A client signs in once, through MCP OAuth. Its authorization request also
 * carries a `session_code_challenge`, and the consent redirect carries a
 * one-time session code next to the MCP code. The client trades that code
 * and its verifier at `CLIENT_SIGN_IN_TOKEN_PATH` for a stored session
 * token, which it sends as `Authorization: Bearer` on `/api/*`. The session
 * and the MCP grant stay separate credentials: neither one works where the
 * other does.
 */
import type { StateAdapter } from "chat";
import { createHash, randomBytes } from "node:crypto";
import * as z from "zod";
import type { User } from "@sentry/junior-plugin-api";
import { JUNIOR_IOS_CLIENT } from "@/api/mcp/oauth/client-metadata";
import { PKCE_CODE_CHALLENGE_PATTERN, pkceVerifierMatches } from "@/api/pkce";
import {
  bearerSignInSessionToken,
  CLIENT_SESSION_LIFETIME_MS,
  createSignInSession,
  revokeSignInSession,
  type SignInSessionClient,
} from "@/chat/sign-in/sessions";

export const CLIENT_SIGN_IN_TOKEN_PATH = "/api/client/sign-in/token";
export const CLIENT_SIGN_OUT_PATH = "/api/client/sign-out";
/** Client session routes. They mount before the dashboard, which needs a session. */
export const CLIENT_SIGN_IN_PUBLIC_PATHS = [
  CLIENT_SIGN_IN_TOKEN_PATH,
  CLIENT_SIGN_OUT_PATH,
];

type AppSessionClient = Exclude<SignInSessionClient, "web">;

// Junior's own app clients, by MCP client ID. Only they may ask for a session.
const APP_SESSION_CLIENTS: Record<string, AppSessionClient> = {
  [JUNIOR_IOS_CLIENT.clientId]: "ios",
};

/** Return the session client of one of Junior's own apps, by MCP client ID. */
export function appSessionClient(
  clientId: string,
): AppSessionClient | undefined {
  return Object.hasOwn(APP_SESSION_CLIENTS, clientId)
    ? APP_SESSION_CLIENTS[clientId]
    : undefined;
}

const CODE_TTL_MS = 60 * 1000;
const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

type ClientSignInState = Pick<StateAdapter, "get" | "set" | "setIfNotExists">;

const codeRecordSchema = z
  .object({
    client: z.enum(["ios"]),
    codeChallenge: z.string().regex(PKCE_CODE_CHALLENGE_PATTERN),
    email: z.string().min(1),
    name: z.string().optional(),
  })
  .strict();

function codeKey(code: string): string {
  const hash = createHash("sha256").update(code, "utf8").digest("hex");
  return `junior:client-sign-in:v1:code:${hash}`;
}

/**
 * Issue a one-time session code for the user who approved an app client's
 * MCP consent. The consent redirect carries it to the app with the MCP code.
 */
export async function issueClientSessionCode(args: {
  client: AppSessionClient;
  codeChallenge: string;
  state: ClientSignInState;
  user: User;
}): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  await args.state.set(
    codeKey(code),
    codeRecordSchema.parse({
      client: args.client,
      codeChallenge: args.codeChallenge,
      email: args.user.email,
      name: args.user.displayName,
    }),
    CODE_TTL_MS,
  );
  return code;
}

function tokenError(description: string, status = 400): Response {
  return Response.json(
    { error: "invalid_grant", error_description: description },
    { status, headers: NO_STORE },
  );
}

/**
 * Trade one code and its PKCE verifier for a client session token. Each code
 * works once.
 */
export async function handleClientSignInToken(args: {
  request: Request;
  state: ClientSignInState;
}): Promise<Response> {
  const contentType = args.request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    return tokenError("Send a form-encoded body.");
  }
  const form = new URLSearchParams(await args.request.text());
  const code = form.get("code");
  const verifier = form.get("code_verifier");
  if (!code || !verifier) {
    return tokenError("The code and code_verifier are required.");
  }
  const key = codeKey(code);
  const stored = await args.state.get(key);
  const record = stored === null ? undefined : codeRecordSchema.parse(stored);
  if (!record || !pkceVerifierMatches(verifier, record.codeChallenge)) {
    return tokenError("The code is not valid.");
  }
  if (!(await args.state.setIfNotExists(`${key}:used`, true, CODE_TTL_MS))) {
    return tokenError("The code was already used.");
  }
  const session = await createSignInSession({
    client: record.client,
    email: record.email,
    lifetimeMs: CLIENT_SESSION_LIFETIME_MS,
    name: record.name,
  });
  return Response.json(
    { expires_at: session.expiresAt.toISOString(), token: session.token },
    { headers: NO_STORE },
  );
}

/** End the client session whose token the request carries. */
export async function handleClientSignOut(request: Request): Promise<Response> {
  const token = bearerSignInSessionToken(request);
  if (token) await revokeSignInSession(token);
  return new Response(null, { status: 204, headers: NO_STORE });
}
