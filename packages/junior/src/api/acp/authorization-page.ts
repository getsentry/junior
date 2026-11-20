/** Own the dashboard-authenticated ACP confirmation page. */
import type { User } from "@sentry/junior-plugin-api";
import { escapeHtml, renderHtmlPage, requestHasSameOrigin } from "@/api/html";
import { completeAcpAuthorization } from "./auth";
import type { AcpState } from "./state";

export const ACP_AUTHORIZATION_PATH = "/_junior/acp/auth/:transactionId";

const ACP_PAGE_HEADERS = {
  "content-security-policy": "frame-ancestors 'none'; form-action 'self'",
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function renderResult(
  agentName: string,
  result: "blocked" | "busy" | "completed" | "conflict" | "expired" | "invalid",
): Response {
  const content = {
    blocked: {
      status: 403,
      title: "Request blocked",
      message: "Open the sign-in link again and confirm the connection.",
    },
    busy: {
      status: 503,
      title: "Your ACP client has pending output",
      message: "Reconnect the client, then confirm this connection again.",
    },
    completed: {
      status: 200,
      title: `${agentName} is connected`,
      message: "You can close this window and return to your ACP client.",
    },
    conflict: {
      status: 409,
      title: "This connection uses another account",
      message: "Start a new connection in your ACP client and sign in again.",
    },
    expired: {
      status: 410,
      title: "This sign-in request expired",
      message: "Return to your ACP client and start sign-in again.",
    },
    invalid: {
      status: 403,
      title: "Verification code did not match",
      message: "Return to your ACP client and enter the code shown there.",
    },
  }[result];
  return renderHtmlPage({
    bodyHtml: `    <p>${escapeHtml(content.message)}</p>`,
    headers: ACP_PAGE_HEADERS,
    status: content.status,
    title: content.title,
  });
}

function renderConfirmation(agentName: string): Response {
  return renderHtmlPage({
    bodyHtml: `    <p>Enter the verification code shown by your ACP client.</p>
    <p class="warning" role="note">Only continue if you started sign-in from your ACP client.</p>
    <form method="post">
      <label>Verification code<input name="code" required autocomplete="one-time-code" inputmode="text"></label>
      <button type="submit" class="primary">Connect</button>
    </form>`,
    headers: ACP_PAGE_HEADERS,
    status: 200,
    title: `Connect ${agentName}`,
  });
}

function transactionIdFromRequest(request: Request): string | undefined {
  const transactionId = new URL(request.url).pathname.split("/").at(-1);
  return transactionId && UUID_PATTERN.test(transactionId)
    ? transactionId
    : undefined;
}

/** Complete one ACP browser authorization for a host-authenticated user. */
export async function handleAcpAuthorizationPage(args: {
  agentName: string;
  request: Request;
  state: AcpState;
  user: User;
}): Promise<Response> {
  const transactionId = transactionIdFromRequest(args.request);
  if (!transactionId) return renderResult(args.agentName, "expired");
  if (args.request.method === "GET") {
    return renderConfirmation(args.agentName);
  }
  if (args.request.method !== "POST" || !requestHasSameOrigin(args.request)) {
    return renderResult(args.agentName, "blocked");
  }

  let userCode: string | undefined;
  try {
    const value = (await args.request.formData()).get("code");
    userCode = typeof value === "string" ? value : undefined;
  } catch {
    // Invalid form input is handled as a rejected verification code.
  }
  if (!userCode?.trim()) return renderResult(args.agentName, "invalid");

  const result = await completeAcpAuthorization({
    state: args.state,
    transactionId,
    user: args.user,
    userCode,
  });
  return renderResult(args.agentName, result);
}
