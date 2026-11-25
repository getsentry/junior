/**
 * Own the iOS app's sign-in to the dashboard API.
 *
 * The app opens `IOS_SIGN_IN_PATH` in its browser sheet with a PKCE
 * challenge. After Google sign-in, the person confirms, and Junior redirects
 * to the app with a one-time code. The app trades the code and its verifier
 * at `IOS_SIGN_IN_TOKEN_PATH` for a stored session token, which it sends as
 * `Authorization: Bearer` on `/api/*`. This is not the MCP grant: MCP stays
 * a separate consent.
 */
import type { StateAdapter } from "chat";
import { createHash, randomBytes } from "node:crypto";
import * as z from "zod";
import type { User } from "@sentry/junior-plugin-api";
import { requestHasSameOrigin } from "@/api/html";
import { PKCE_CODE_CHALLENGE_PATTERN, pkceVerifierMatches } from "@/api/pkce";
import {
  bearerSignInSessionToken,
  createSignInSession,
  IOS_SESSION_LIFETIME_MS,
  revokeSignInSession,
} from "@/chat/sign-in/sessions";
import { renderIosSignInBlockedPage, renderIosSignInPage } from "./page";

export const IOS_SIGN_IN_PATH = "/api/ios/sign-in";
export const IOS_SIGN_IN_TOKEN_PATH = "/api/ios/sign-in/token";
export const IOS_SIGN_OUT_PATH = "/api/ios/sign-out";
/** Public iOS routes. They mount before the dashboard, which needs a session. */
export const IOS_SIGN_IN_PUBLIC_PATHS = [
  IOS_SIGN_IN_TOKEN_PATH,
  IOS_SIGN_OUT_PATH,
];

// Only the app can open its `junior-ios` scheme from its browser sheet.
const IOS_REDIRECT_URI = "junior-ios://session/callback";
const CODE_TTL_MS = 60 * 1000;
const STATE_MAX_LENGTH = 1_000;
const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

type IosSignInState = Pick<StateAdapter, "get" | "set" | "setIfNotExists">;

const codeRecordSchema = z
  .object({
    codeChallenge: z.string().regex(PKCE_CODE_CHALLENGE_PATTERN),
    email: z.string().min(1),
    name: z.string().optional(),
  })
  .strict();

function codeKey(code: string): string {
  const hash = createHash("sha256").update(code, "utf8").digest("hex");
  return `junior:ios-sign-in:v1:code:${hash}`;
}

function readParams(values: {
  get(name: string): unknown;
}): { codeChallenge: string; state: string } | undefined {
  const codeChallenge = values.get("code_challenge");
  const state = values.get("state");
  if (
    typeof codeChallenge !== "string" ||
    !PKCE_CODE_CHALLENGE_PATTERN.test(codeChallenge) ||
    typeof state !== "string" ||
    !state ||
    state.length > STATE_MAX_LENGTH
  ) {
    return undefined;
  }
  return { codeChallenge, state };
}

/**
 * Show or complete the iOS sign-in for one dashboard-authenticated user. GET
 * asks the person to confirm. A same-origin POST issues the code, so another
 * site cannot send a signed-in browser through this page on its own.
 */
export async function handleIosSignInPage(args: {
  agentName: string;
  request: Request;
  state: IosSignInState;
  user: User;
}): Promise<Response> {
  if (args.request.method === "GET") {
    const params = readParams(new URL(args.request.url).searchParams);
    if (!params) return renderIosSignInBlockedPage();
    return renderIosSignInPage({
      agentName: args.agentName,
      email: args.user.email,
      ...params,
    });
  }

  // A body that is not a form is a blocked request.
  const form = requestHasSameOrigin(args.request)
    ? await args.request.formData().catch(() => undefined)
    : undefined;
  const params = form && readParams(form);
  if (!params) return renderIosSignInBlockedPage();
  const code = randomBytes(32).toString("base64url");
  await args.state.set(
    codeKey(code),
    codeRecordSchema.parse({
      codeChallenge: params.codeChallenge,
      email: args.user.email,
      name: args.user.displayName,
    }),
    CODE_TTL_MS,
  );
  const redirect = new URL(IOS_REDIRECT_URI);
  redirect.searchParams.set("code", code);
  redirect.searchParams.set("state", params.state);
  return new Response(null, {
    status: 303,
    headers: { ...NO_STORE, location: redirect.toString() },
  });
}

function tokenError(description: string, status = 400): Response {
  return Response.json(
    { error: "invalid_grant", error_description: description },
    { status, headers: NO_STORE },
  );
}

/**
 * Trade one code and its PKCE verifier for an iOS session token. Each code
 * works once.
 */
export async function handleIosSignInToken(args: {
  request: Request;
  state: IosSignInState;
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
    client: "ios",
    email: record.email,
    lifetimeMs: IOS_SESSION_LIFETIME_MS,
    name: record.name,
  });
  return Response.json(
    { expires_at: session.expiresAt.toISOString(), token: session.token },
    { headers: NO_STORE },
  );
}

/** End the iOS session whose token the request carries. */
export async function handleIosSignOut(request: Request): Promise<Response> {
  const token = bearerSignInSessionToken(request);
  if (token) await revokeSignInSession(token);
  return new Response(null, { status: 204, headers: NO_STORE });
}
