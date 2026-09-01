/** Own the dashboard-authenticated ACP confirmation page. */
import type { User } from "@sentry/junior-plugin-api";
import { completeAcpAuthorization } from "./auth";
import type { AcpState } from "./state";

export const ACP_AUTHORIZATION_PATH = "/_junior/acp/auth/:transactionId";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

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
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(content.title)}</title>
</head>
<body style="margin:0;background:#000;color:#fff;font-family:ui-sans-serif,system-ui,sans-serif">
  <main style="min-height:100vh;display:grid;place-items:center;padding:2rem">
    <section style="max-width:32rem;border-left:4px solid #a78bfa;padding-left:1rem">
      <h1 style="margin:0 0 .75rem;font-size:2rem">${escapeHtml(content.title)}</h1>
      <p style="margin:0;color:#b8b8b8;line-height:1.5">${escapeHtml(content.message)}</p>
    </section>
  </main>
</body>
</html>`,
    {
      status: content.status,
      headers: {
        "cache-control": "no-store",
        "content-security-policy": "frame-ancestors 'none'; form-action 'self'",
        "content-type": "text/html; charset=utf-8",
        "x-frame-options": "DENY",
      },
    },
  );
}

function renderConfirmation(agentName: string): Response {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connect ${escapeHtml(agentName)}</title>
</head>
<body style="margin:0;background:#000;color:#fff;font-family:ui-sans-serif,system-ui,sans-serif">
  <main style="min-height:100vh;display:grid;place-items:center;padding:2rem">
    <section style="max-width:32rem;border-left:4px solid #a78bfa;padding-left:1rem">
      <h1 style="margin:0 0 .75rem;font-size:2rem">Connect ${escapeHtml(agentName)}</h1>
      <p style="margin:0 0 1rem;color:#b8b8b8;line-height:1.5">Only continue if you started sign-in from your ACP client. Enter the verification code shown by the client.</p>
      <form method="post">
        <label style="display:block;margin:0 0 1rem">Verification code<br><input name="code" required autocomplete="one-time-code" inputmode="text" style="box-sizing:border-box;margin-top:.5rem;padding:.625rem;width:100%"></label>
        <button type="submit" style="border:0;border-radius:.375rem;background:#a78bfa;color:#000;cursor:pointer;font:inherit;font-weight:700;padding:.625rem 1rem">Connect</button>
      </form>
    </section>
  </main>
</body>
</html>`,
    {
      headers: {
        "cache-control": "no-store",
        "content-security-policy": "frame-ancestors 'none'; form-action 'self'",
        "content-type": "text/html; charset=utf-8",
        "x-frame-options": "DENY",
      },
    },
  );
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
