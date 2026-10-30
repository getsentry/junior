/**
 * Own the dashboard-authenticated MCP consent page.
 *
 * The dashboard verifies Google sign-in before it calls this page. A POST must
 * come from the same origin and carry the form token issued to the same user
 * on GET. Approve and deny each end the pending authorization.
 */
import { timingSafeEqual } from "node:crypto";
import type { User } from "@sentry/junior-plugin-api";
import { escapeHtml } from "@/api/html";
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
import { stateKeyHash, type McpState } from "./state";

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

function consentPage(args: {
  agentName: string;
  authorization: McpAuthorization;
  csrfToken: string;
}): Response {
  const clientHost = new URL(args.authorization.clientId).host;
  const clientName = args.authorization.clientName ?? clientHost;
  const button = (action: string, label: string, primary: boolean) =>
    `<button type="submit" name="action" value="${action}" style="border:0;border-radius:.375rem;cursor:pointer;font:inherit;font-weight:700;padding:.625rem 1rem;margin-right:.5rem;${primary ? "background:#a78bfa;color:#000" : "background:#333;color:#fff"}">${label}</button>`;
  return renderMcpPage({
    bodyHtml: `<p style="margin:0 0 1rem;color:#b8b8b8;line-height:1.5">The app is published at <strong style="color:#fff">${escapeHtml(clientHost)}</strong>. It can list your ${escapeHtml(args.agentName)} conversations.</p>
      <form method="post">
        <input type="hidden" name="csrf" value="${escapeHtml(args.csrfToken)}">
        ${button("approve", "Allow", true)}${button("deny", "Deny", false)}
      </form>`,
    formOrigin: new URL(args.authorization.redirectUri).origin,
    message: `${clientName} wants to connect to ${args.agentName}. Only continue if you started this connection.`,
    status: 200,
    title: `Connect ${clientName}`,
  });
}

function requestHasSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function csrfMatches(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(stateKeyHash(value), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readForm(
  request: Request,
): Promise<{ action?: string; csrf?: string }> {
  try {
    const form = await request.formData();
    const action = form.get("action");
    const csrf = form.get("csrf");
    return {
      ...(typeof action === "string" ? { action } : undefined),
      ...(typeof csrf === "string" ? { csrf } : undefined),
    };
  } catch {
    // Invalid form input is handled as a blocked request.
    return {};
  }
}

/** Show or complete MCP consent for one dashboard-authenticated user. */
export async function handleMcpConsentPage(args: {
  agentName: string;
  baseURL?: string;
  request: Request;
  state: McpState;
  user: User;
}): Promise<Response> {
  const requestId = new URL(args.request.url).pathname.split("/").at(-1) ?? "";
  const authorization = await readMcpAuthorization(args.state, requestId);
  if (!authorization) return expiredPage();

  if (args.request.method === "GET") {
    const csrfToken = await bindMcpConsent({
      authorization,
      requestId,
      state: args.state,
      userId: args.user.id,
    });
    if (!csrfToken) return blockedPage();
    return consentPage({ agentName: args.agentName, authorization, csrfToken });
  }

  const form = await readForm(args.request);
  if (
    !requestHasSameOrigin(args.request) ||
    authorization.consent?.userId !== args.user.id ||
    !form.csrf ||
    !csrfMatches(form.csrf, authorization.consent.csrfHash) ||
    (form.action !== "approve" && form.action !== "deny")
  ) {
    return blockedPage();
  }
  if (!(await claimMcpAuthorization(args.state, requestId))) {
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
    redirectUri: authorization.redirectUri,
    resource: authorization.resource,
    state: args.state,
    user: args.user,
  });
  return authorizationRedirect({
    issuer,
    params: { code },
    redirectUri: authorization.redirectUri,
    state: authorization.state,
  });
}
