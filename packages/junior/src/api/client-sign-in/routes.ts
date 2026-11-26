/**
 * Own the sign-in session of Junior's own app clients, such as the iOS app.
 *
 * The app opens `CLIENT_SIGN_IN_AUTHORIZE_PATH` in a browser sheet. After the
 * user confirms there, the redirect carries a one-time code, which the app
 * trades with its PKCE verifier at `CLIENT_SIGN_IN_TOKEN_PATH` for a stored
 * session token. The app sends that token as `Authorization: Bearer` on
 * `/api/*`, and at `CLIENT_MCP_TOKEN_PATH` to get MCP tokens. The session and
 * the MCP grant stay separate credentials: neither one works where the other
 * does. The grant ends with the session that minted it.
 */
import type { StateAdapter } from "chat";
import { createHash, randomBytes } from "node:crypto";
import * as z from "zod";
import type { User } from "@sentry/junior-plugin-api";
import {
  JUNIOR_IOS_CLIENT,
  type McpClient,
} from "@/api/mcp/oauth/client-metadata";
import { issueSessionGrant } from "@/api/mcp/oauth/grants";
import { resolveMcpUrls } from "@/api/mcp/oauth/metadata";
import type { McpState } from "@/api/mcp/oauth/state";
import { PKCE_CODE_CHALLENGE_PATTERN, pkceVerifierMatches } from "@/api/pkce";
import {
  authenticateSignInSession,
  bearerSignInSessionToken,
  CLIENT_SESSION_LIFETIME_MS,
  createSignInSession,
  revokeSignInSession,
  type SignInSessionClient,
} from "@/chat/sign-in/sessions";

/**
 * Dashboard-authenticated page where the user confirms an app sign-in. It is
 * a page, not a JSON route, so it is not under `/api/`.
 */
export const CLIENT_SIGN_IN_AUTHORIZE_PATH =
  "/_junior/client/sign-in/authorize";
export const CLIENT_SIGN_IN_TOKEN_PATH = "/api/client/sign-in/token";
export const CLIENT_MCP_TOKEN_PATH = "/api/client/mcp-token";
export const CLIENT_SIGN_OUT_PATH = "/api/client/sign-out";
/** Client session routes. They mount before the dashboard, which needs a session. */
export const CLIENT_SIGN_IN_PUBLIC_PATHS = [
  CLIENT_SIGN_IN_TOKEN_PATH,
  CLIENT_MCP_TOKEN_PATH,
  CLIENT_SIGN_OUT_PATH,
];

type AppSessionClient = Exclude<SignInSessionClient, "web">;

/** Junior's own apps, by session client. Only they may ask for a session. */
export const APP_CLIENTS: Record<AppSessionClient, McpClient> = {
  ios: JUNIOR_IOS_CLIENT,
};

/** Return the session client of one of Junior's own apps, by MCP client ID. */
export function appSessionClient(
  clientId: string,
): AppSessionClient | undefined {
  return clientId === APP_CLIENTS.ios.clientId ? "ios" : undefined;
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
 * Issue a one-time session code for the user who confirmed an app sign-in.
 * The sign-in redirect carries it to the app.
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

/**
 * Issue MCP tokens to the app of the session that the request carries as a
 * bearer token. The response has the shape of the MCP token endpoint, so the
 * app refreshes there. The grant ends no later than the session, and
 * revoking the session ends it at once.
 */
export async function handleClientMcpToken(args: {
  baseURL?: string | undefined;
  request: Request;
  state: McpState;
}): Promise<Response> {
  const token = bearerSignInSessionToken(args.request);
  const session = token ? await authenticateSignInSession(token) : undefined;
  if (!session) {
    return Response.json(
      { error: "invalid_token", error_description: "Sign in again." },
      { status: 401, headers: NO_STORE },
    );
  }
  if (session.client === "web") {
    return Response.json(
      {
        error: "unauthorized_client",
        error_description: "Only an app session can get MCP tokens.",
      },
      { status: 403, headers: NO_STORE },
    );
  }
  const result = await issueSessionGrant({
    clientId: APP_CLIENTS[session.client].clientId,
    email: session.user.email,
    resource: resolveMcpUrls(args.request, args.baseURL).resource,
    sessionExpiresAt: session.expiresAt,
    sessionId: session.id,
    state: args.state,
  });
  return result.ok
    ? Response.json(result.tokens, { headers: NO_STORE })
    : Response.json(
        { error: result.error, error_description: result.description },
        { status: 400, headers: NO_STORE },
      );
}

/** End the client session whose token the request carries. */
export async function handleClientSignOut(request: Request): Promise<Response> {
  const token = bearerSignInSessionToken(request);
  if (token) await revokeSignInSession(token);
  return new Response(null, { status: 204, headers: NO_STORE });
}
