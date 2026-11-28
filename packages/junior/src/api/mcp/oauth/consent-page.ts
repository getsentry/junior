/**
 * Own the dashboard-authenticated MCP consent page.
 *
 * The dashboard verifies Google sign-in before it calls this page. A POST must
 * come from the same origin and carry the form token issued to the same user
 * on GET. Approve and deny each end the pending authorization.
 */
import { timingSafeEqual } from "node:crypto";
import type { User } from "@sentry/junior-plugin-api";
import { escapeHtml, renderHtmlPage, requestHasSameOrigin } from "@/api/html";
import {
  authorizationRedirect,
  authorizationResponseUrl,
  type AuthorizationResponse,
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

function isWebUrl(url: URL): boolean {
  return url.protocol === "https:" || url.protocol === "http:";
}

// A web callback gets a redirect page, so the consent form only posts to
// Junior. A custom-scheme callback, such as the iOS app's, still gets a 303,
// so the form must reach its scheme. Its origin is "null", which matches
// nothing in CSP.
function formActionSource(redirectUri: string): string | undefined {
  const url = new URL(redirectUri);
  return isWebUrl(url) ? undefined : url.protocol;
}

/*
 * Chrome and Safari check `form-action` on every redirect after a form POST,
 * even `302`/`303` hops; Firefox does not. Ending the POST with this page
 * keeps a web callback's own redirects out of `form-action`. Return a `303`
 * once browsers skip those hops: https://github.com/w3c/webappsec-csp/issues/8
 */
function authorizationResponse(args: AuthorizationResponse): Response {
  const url = authorizationResponseUrl(args);
  // Safari can ignore a meta refresh to a custom scheme, such as the iOS app's.
  if (!isWebUrl(url)) return authorizationRedirect(args);
  const href = escapeHtml(url.toString());
  return renderHtmlPage({
    bodyHtml: `    <p><a href="${href}">Continue to the app</a> if nothing happens.</p>`,
    headHtml: `  <meta http-equiv="refresh" content="0;url=${href}" />`,
    headers: {
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
      // The callback URL carries the code, so no page it reaches may see it.
      "referrer-policy": "no-referrer",
    },
    status: 200,
    title: "Redirecting…",
  });
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
  return renderMcpPage({
    bodyHtml: `    <p>The app is published at <strong>${escapeHtml(clientHost)}</strong>.</p>
    <h2>In ${escapeHtml(args.agentName)}, it can:</h2>
    <ul class="list">${scopeItems}</ul>
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
    return authorizationResponse({
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
  return authorizationResponse({
    issuer,
    params: { code },
    redirectUri: authorization.redirectUri,
    state: authorization.state,
  });
}
