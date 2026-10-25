/**
 * Google sign-in for people who use Junior.
 *
 * Junior owns this OAuth flow, so it works without the dashboard. Slack sends
 * a person here the first time they mention Junior. The callback checks the
 * Google account against the same allowlist as the dashboard. Then it links
 * the Google identity to the person's user, so later checks can reuse it.
 */
import { createHash, randomBytes } from "node:crypto";
import type { StateAdapter } from "chat";
import { z } from "zod";
import { botConfig } from "@/chat/config";
import { getSqlExecutor } from "@/chat/db";
import { GOOGLE_IDENTITY_PROVIDER } from "@/chat/identities/identity";
import {
  findSlackIdentityUserId,
  upsertLinkedIdentity,
} from "@/chat/identities/sql";
import { findUserByEmailFromSql } from "@/chat/plugins/viewer";
import { resolveBaseUrl } from "@/chat/oauth-flow";
import { escapeXml } from "@/chat/xml";
import { htmlCallbackResponse } from "@/handlers/oauth-html";

export const SIGN_IN_CALLBACK_PATH = "/api/sign-in/callback";

const AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set([
  "accounts.google.com",
  "https://accounts.google.com",
]);
const SIGN_IN_STATE_TTL_MS = 10 * 60 * 1000;

/** Google accounts that may sign in. Empty lists allow nobody. */
export interface SignInAllowlist {
  domains: string[];
  emails: string[];
}

const signInStateSchema = z.object({
  codeVerifier: z.string().min(1),
  slackTeamId: z.string().min(1),
  slackUserId: z.string().min(1),
});

const tokenResponseSchema = z.object({ id_token: z.string().min(1) });

const idTokenClaimsSchema = z.object({
  aud: z.string(),
  email: z.string(),
  email_verified: z.boolean().optional(),
  iss: z.string(),
  sub: z.string().min(1),
});

function stateKey(state: string): string {
  return `sign-in:v1:${state}`;
}

function clientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      "Sign-in requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET",
    );
  }
  return { clientId, clientSecret };
}

function redirectUri(): string {
  const baseUrl = resolveBaseUrl();
  if (!baseUrl) {
    throw new Error("Sign-in requires JUNIOR_BASE_URL or a Vercel deployment");
  }
  return `${baseUrl}${SIGN_IN_CALLBACK_PATH}`;
}

/**
 * Resolve the sign-in allowlist. Use the same values as the dashboard: its
 * options when set, else its environment variables.
 */
export function resolveSignInAllowlist(
  options: { allowedEmails?: string[]; allowedGoogleDomains?: string[] } = {},
): SignInAllowlist {
  const list = (values: string[] | undefined, name: string) =>
    (values ?? (process.env[name] ?? "").split(","))
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
  return {
    domains: list(
      options.allowedGoogleDomains,
      "JUNIOR_DASHBOARD_GOOGLE_DOMAINS",
    ),
    emails: list(options.allowedEmails, "JUNIOR_DASHBOARD_ALLOWED_EMAILS"),
  };
}

function isAllowed(email: string, allowlist: SignInAllowlist): boolean {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  return allowlist.emails.includes(email) || allowlist.domains.includes(domain);
}

/** Start one Google sign-in for a Slack user and return the consent URL. */
export async function createSlackSignInUrl(args: {
  slackTeamId: string;
  slackUserId: string;
  state: StateAdapter;
}): Promise<string> {
  const { clientId } = clientCredentials();
  const state = randomBytes(24).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  await args.state.set(
    stateKey(state),
    {
      codeVerifier,
      slackTeamId: args.slackTeamId,
      slackUserId: args.slackUserId,
    } satisfies z.input<typeof signInStateSchema>,
    SIGN_IN_STATE_TTL_MS,
  );
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: clientId,
    code_challenge: createHash("sha256")
      .update(codeVerifier)
      .digest("base64url"),
    code_challenge_method: "S256",
    prompt: "select_account",
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: "openid email",
    state,
  }).toString();
  return url.toString();
}

function page(title: string, message: string, status: number): Response {
  return htmlCallbackResponse(escapeXml(title), escapeXml(message), status);
}

// The token response comes straight from Google over TLS, so the identity
// token claims are trusted without a signature check (OpenID Connect Core
// 3.1.3.7).
async function verifiedGoogleAccount(
  code: string,
  codeVerifier: string,
): Promise<{ email: string; subject: string } | undefined> {
  const { clientId, clientSecret } = clientCredentials();
  const response = await fetch(TOKEN_ENDPOINT, {
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri(),
    }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  if (!response.ok) return undefined;
  const tokens = tokenResponseSchema.safeParse(await response.json());
  if (!tokens.success) return undefined;
  const payload = tokens.data.id_token.split(".")[1] ?? "";
  let claims: z.output<typeof idTokenClaimsSchema>;
  try {
    claims = idTokenClaimsSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
  } catch {
    return undefined;
  }
  if (
    !GOOGLE_ISSUERS.has(claims.iss) ||
    claims.aud !== clientId ||
    claims.email_verified !== true
  ) {
    return undefined;
  }
  return { email: claims.email.trim().toLowerCase(), subject: claims.sub };
}

/**
 * Finish one Google sign-in and link the Google identity to the user of the
 * Slack identity that started it.
 */
export async function handleSignInCallback(args: {
  allowlist: SignInAllowlist;
  request: Request;
  state: StateAdapter;
}): Promise<Response> {
  const url = new URL(args.request.url);
  const stateParam = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const stored = stateParam
    ? signInStateSchema.safeParse(await args.state.get(stateKey(stateParam)))
    : undefined;
  if (!stateParam || !code || !stored?.success) {
    return page(
      "Sign-in link expired",
      `Mention ${botConfig.userName} in Slack again to get a new link.`,
      400,
    );
  }
  // One state starts one sign-in.
  await args.state.delete(stateKey(stateParam));

  const account = await verifiedGoogleAccount(code, stored.data.codeVerifier);
  if (!account) {
    return page(
      "Sign-in failed",
      "Google did not return a verified account. Try again.",
      400,
    );
  }
  const { email } = account;
  if (!isAllowed(email, args.allowlist)) {
    return page(
      "Account not allowed",
      `${email} cannot use ${botConfig.userName}. Sign in with your work account.`,
      403,
    );
  }
  // Link only when the Slack identity's user owns this Google email. A
  // forwarded link then cannot give another person's Slack account access.
  const executor = getSqlExecutor();
  const userId = await findSlackIdentityUserId(
    executor,
    stored.data.slackTeamId,
    stored.data.slackUserId,
  );
  const user = await findUserByEmailFromSql(executor.db(), email);
  if (!userId || user?.id !== userId) {
    return page(
      "Slack account does not match",
      `Your Slack email is not ${email}. Sign in with the account that matches your Slack email.`,
      403,
    );
  }
  await upsertLinkedIdentity(executor, userId, {
    kind: "user",
    provider: GOOGLE_IDENTITY_PROVIDER,
    providerSubjectId: account.subject,
    email,
    emailVerified: true,
  });
  return page(
    "You are signed in",
    "Return to Slack and send your message again.",
    200,
  );
}
