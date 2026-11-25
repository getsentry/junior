/**
 * Own the dashboard-authenticated MCP consent page.
 *
 * The dashboard verifies Google sign-in before it calls this page. A POST must
 * come from the same origin and carry the form token issued to the same user
 * on GET. Approve and deny each end the pending authorization.
 */
import { timingSafeEqual } from "node:crypto";
import type { User } from "@sentry/junior-plugin-api";
import { escapeHtml, requestHasSameOrigin } from "@/api/html";
import { issueIosSessionCode } from "@/api/ios-sign-in/routes";
import {
  authorizationRedirect,
  bindMcpConsent,
  claimMcpAuthorization,
  readMcpAuthorization,
  type McpAuthorization,
} from "./authorization";
import { issueAuthorizationCode } from "./grants";
import { resolveMcpUrls } from "./metadata";
import { renderMcpPage } from "./page";
import { MCP_SCOPE_DESCRIPTIONS, parseMcpScopes } from "./scopes";
import { sha256Hex, type McpState } from "./state";

function expiredPage(): Response {
  return renderMcpPage({
    message: "Return to your MCP client and connect again.",
    status: 410,
    title: "This sign-in request expired",
  });
}

function blockedPage(): Response {
  return renderMcpPage({
    message: "Return to your MCP client and connect again.",
    status: 403,
    title: "Request blocked",
  });
}

// A custom-scheme redirect, such as the iOS app's, has the origin "null",
// which matches nothing in CSP. Allow its scheme instead.
function formActionSource(redirectUri: string): string {
  const url = new URL(redirectUri);
  return url.protocol === "https:" || url.protocol === "http:"
    ? url.origin
    : url.protocol;
}

function consentPage(args: {
  agentName: string;
  authorization: McpAuthorization;
  csrfToken: string;
}): Response {
  const clientHost = new URL(args.authorization.clientId).host;
  const clientName = args.authorization.clientName ?? clientHost;
  const scopeItems = (parseMcpScopes(args.authorization.scope) ?? [])
    .map(
      (scope) =>
        `<li>${escapeHtml(MCP_SCOPE_DESCRIPTIONS[scope])}<code>${escapeHtml(scope)}</code></li>`,
    )
    .join("");
  const sessionItem = args.authorization.sessionCodeChallenge
    ? "<li>Use the dashboard API as you for 30 days</li>"
    : "";
  return renderMcpPage({
    bodyHtml: `    <p>The app is published at <strong>${escapeHtml(clientHost)}</strong>.</p>
    <h2>In ${escapeHtml(args.agentName)}, it can:</h2>
    <ul class="list">${scopeItems}${sessionItem}</ul>
    <p class="warning" role="note">Only continue if you started this connection.</p>
    <form method="post" class="actions">
      <input type="hidden" name="csrf" value="${escapeHtml(args.csrfToken)}">
      <button type="submit" name="action" value="deny">Deny</button>
      <button type="submit" name="action" value="approve" class="primary">Allow</button>
    </form>`,
    formActionSource: formActionSource(args.authorization.redirectUri),
    message: `${clientName} wants to connect to ${args.agentName}.`,
    status: 200,
    title: `Connect ${clientName}`,
  });
}

function csrfMatches(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(sha256Hex(value), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readForm(
  request: Request,
): Promise<{ action?: string | undefined; csrf?: string | undefined }> {
  try {
    const form = await request.formData();
    const action = form.get("action");
    const csrf = form.get("csrf");
    return {
      action: typeof action === "string" ? action : undefined,
      csrf: typeof csrf === "string" ? csrf : undefined,
    };
  } catch {
    // Invalid form input is handled as a blocked request.
    return {};
  }
}

/** Show or complete MCP consent for one dashboard-authenticated user. */
export async function handleMcpConsentPage(args: {
  agentName: string;
  baseURL?: string | undefined;
  request: Request;
  state: McpState;
  user: User;
}): Promise<Response> {
  const authorizationId =
    new URL(args.request.url).pathname.split("/").at(-1) ?? "";
  const pending = await readMcpAuthorization(args.state, authorizationId);
  if (!pending) return expiredPage();
  const { authorization, consent } = pending;

  if (args.request.method === "GET") {
    const csrfToken = await bindMcpConsent({
      authorization,
      authorizationId,
      state: args.state,
      userId: args.user.id,
    });
    if (!csrfToken) return blockedPage();
    return consentPage({ agentName: args.agentName, authorization, csrfToken });
  }

  const form = await readForm(args.request);
  if (
    !requestHasSameOrigin(args.request) ||
    consent?.userId !== args.user.id ||
    !form.csrf ||
    !csrfMatches(form.csrf, consent.csrfHash) ||
    (form.action !== "approve" && form.action !== "deny")
  ) {
    return blockedPage();
  }
  if (!(await claimMcpAuthorization(args.state, authorizationId))) {
    return expiredPage();
  }

  const { issuer } = resolveMcpUrls(args.request, args.baseURL);
  if (form.action === "deny") {
    return authorizationRedirect({
      issuer,
      params: {
        error: "access_denied",
        error_description: "The user denied access.",
      },
      redirectUri: authorization.redirectUri,
      state: authorization.state,
    });
  }
  const code = await issueAuthorizationCode({
    clientId: authorization.clientId,
    codeChallenge: authorization.codeChallenge,
    email: args.user.email,
    redirectUri: authorization.redirectUri,
    resource: authorization.resource,
    scope: authorization.scope,
    state: args.state,
  });
  const sessionCode =
    authorization.sessionCodeChallenge &&
    (await issueIosSessionCode({
      codeChallenge: authorization.sessionCodeChallenge,
      state: args.state,
      user: args.user,
    }));
  return authorizationRedirect({
    issuer,
    params: sessionCode ? { code, session_code: sessionCode } : { code },
    redirectUri: authorization.redirectUri,
    state: authorization.state,
  });
}
