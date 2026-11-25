/**
 * Own the dashboard-authenticated page where a user confirms that one of
 * Junior's own apps may sign in as them.
 *
 * The dashboard verifies Google sign-in before it calls this page, and it
 * sends a browser without a session through sign-in and back here. The page
 * never approves by itself: any app can open this URL with its own PKCE
 * challenge, so the user must confirm. A POST must come from the same origin
 * and carry the form token issued to the same user on GET. Approve and deny
 * each end the request.
 */
import { randomBytes } from "node:crypto";
import * as z from "zod";
import type { User } from "@sentry/junior-plugin-api";
import { escapeHtml, requestHasSameOrigin } from "@/api/html";
import {
  formActionSource,
  readConsentForm,
  renderMcpPage,
} from "@/api/mcp/oauth/page";
import { PKCE_CODE_CHALLENGE_PATTERN } from "@/api/pkce";
import { CLIENT_SESSION_LIFETIME_MS } from "@/chat/sign-in/sessions";
import { sha256Hex, type McpState } from "@/api/mcp/oauth/state";
import {
  APP_CLIENTS,
  appSessionClient,
  issueClientSessionCode,
} from "./routes";

const REQUEST_TTL_MS = 10 * 60 * 1000;
const STATE_MAX_LENGTH = 1_000;
const SESSION_LIFETIME_DAYS = Math.round(
  CLIENT_SESSION_LIFETIME_MS / (24 * 60 * 60 * 1000),
);

const signInRequestSchema = z
  .object({
    client: z.enum(["ios"]),
    codeChallenge: z.string().regex(PKCE_CODE_CHALLENGE_PATTERN),
    redirectUri: z.string().min(1),
    state: z.string().max(STATE_MAX_LENGTH).optional(),
    /** User who opened the page. Only they can confirm it. */
    userId: z.string().min(1),
  })
  .strict();

type SignInRequest = z.output<typeof signInRequestSchema>;

// The form token is the request ID. Only its hash is stored.
function requestKey(csrf: string): string {
  return `junior:client-sign-in:v1:request:${sha256Hex(csrf)}`;
}

function errorPage(title: string, status: number): Response {
  return renderMcpPage({
    message: "Return to the app and sign in again.",
    status,
    title,
  });
}

function signInRedirect(
  request: Pick<SignInRequest, "redirectUri" | "state">,
  params: Record<string, string>,
): Response {
  const url = new URL(request.redirectUri);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  if (request.state !== undefined) url.searchParams.set("state", request.state);
  return new Response(null, {
    status: 303,
    headers: { "cache-control": "no-store", location: url.toString() },
  });
}

async function showConfirmation(args: {
  agentName: string;
  request: Request;
  state: McpState;
  user: User;
}): Promise<Response> {
  const params = new URL(args.request.url).searchParams;
  const client = appSessionClient(params.get("client_id") ?? "");
  const redirectUri = params.get("redirect_uri") ?? "";
  // Never redirect to a URI that is not the app's own.
  if (!client || !APP_CLIENTS[client].redirectUris.includes(redirectUri)) {
    return errorPage("This app cannot sign in", 400);
  }
  const oauthState = params.get("state") ?? undefined;
  const codeChallenge = params.get("code_challenge") ?? "";
  if (
    params.get("code_challenge_method") !== "S256" ||
    !PKCE_CODE_CHALLENGE_PATTERN.test(codeChallenge) ||
    (oauthState !== undefined && oauthState.length > STATE_MAX_LENGTH)
  ) {
    return signInRedirect(
      { redirectUri, state: oauthState },
      {
        error: "invalid_request",
        error_description: "PKCE with S256 is required.",
      },
    );
  }

  const csrf = randomBytes(32).toString("base64url");
  await args.state.set(
    requestKey(csrf),
    signInRequestSchema.parse({
      client,
      codeChallenge,
      redirectUri,
      state: oauthState,
      userId: args.user.id,
    }),
    REQUEST_TTL_MS,
  );
  const appName = `${args.agentName} ${APP_CLIENTS[client].name ?? "app"}`;
  return renderMcpPage({
    bodyHtml: `    <p>It can use ${escapeHtml(args.agentName)} as you for ${SESSION_LIFETIME_DAYS} days.</p>
    <p class="warning" role="note">Only continue if you started this sign-in in the app.</p>
    <form method="post" class="actions">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <button type="submit" name="action" value="deny">Deny</button>
      <button type="submit" name="action" value="approve" class="primary">Sign in</button>
    </form>`,
    formActionSource: formActionSource(redirectUri),
    message: `The ${appName} wants to sign in as ${args.user.email}.`,
    status: 200,
    title: `Sign in to ${args.agentName}`,
  });
}

/** Show or complete one app sign-in for one dashboard-authenticated user. */
export async function handleClientSignInAuthorize(args: {
  agentName: string;
  request: Request;
  state: McpState;
  user: User;
}): Promise<Response> {
  if (args.request.method === "GET") return await showConfirmation(args);

  const form = await readConsentForm(args.request);
  if (
    !requestHasSameOrigin(args.request) ||
    !form.csrf ||
    (form.action !== "approve" && form.action !== "deny")
  ) {
    return errorPage("Request blocked", 403);
  }
  const key = requestKey(form.csrf);
  const stored = await args.state.get(key);
  const signInRequest =
    stored === null ? undefined : signInRequestSchema.parse(stored);
  if (!signInRequest) return errorPage("This sign-in request expired", 410);
  if (signInRequest.userId !== args.user.id) {
    return errorPage("Request blocked", 403);
  }
  if (!(await args.state.setIfNotExists(`${key}:used`, true, REQUEST_TTL_MS))) {
    return errorPage("This sign-in request expired", 410);
  }

  if (form.action === "deny") {
    return signInRedirect(signInRequest, {
      error: "access_denied",
      error_description: "The user denied access.",
    });
  }
  const code = await issueClientSessionCode({
    client: signInRequest.client,
    codeChallenge: signInRequest.codeChallenge,
    state: args.state,
    user: args.user,
  });
  return signInRedirect(signInRequest, { code });
}
