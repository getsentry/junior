import { resolveViewerUser } from "@sentry/junior/api";
import type { User } from "@sentry/junior-plugin-api";
import {
  dashboardSessionIsAuthorized,
  sanitizeDashboardSession,
  verifiedDashboardSessionEmail,
  type DashboardAuth,
  type DashboardSession,
} from "./auth";

export const ACP_AUTHORIZATION_PATH_PREFIX = "/api/acp/auth/";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface DashboardAcpAuthorization {
  complete(
    transactionId: string,
    user: User,
    userCode: string,
  ): Promise<"busy" | "completed" | "conflict" | "expired" | "invalid">;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function loginPath(basePath: string): string {
  return basePath === "/" ? "/auth/login" : `${basePath}/auth/login`;
}

function loginUrl(
  request: Request,
  basePath: string,
  canonicalBaseURL?: string,
): string {
  const requestUrl = new URL(request.url);
  const url = canonicalBaseURL
    ? new URL(canonicalBaseURL)
    : new URL(request.url);
  url.pathname = loginPath(basePath);
  url.search = "";
  url.searchParams.set("next", `${requestUrl.pathname}${requestUrl.search}`);
  return url.toString();
}

function canonicalAuthorizationUrl(
  request: Request,
  canonicalBaseURL?: string,
): string | undefined {
  if (!canonicalBaseURL) return undefined;
  const requestUrl = new URL(request.url);
  const canonicalUrl = new URL(canonicalBaseURL);
  if (requestUrl.origin === canonicalUrl.origin) return undefined;
  canonicalUrl.pathname = requestUrl.pathname;
  canonicalUrl.search = requestUrl.search;
  return canonicalUrl.toString();
}

function renderResult(
  agentName: string,
  result:
    | "blocked"
    | "busy"
    | "completed"
    | "conflict"
    | "expired"
    | "forbidden"
    | "invalid",
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
    forbidden: {
      status: 403,
      title: "Access denied",
      message: `This Google account is not allowed to use ${agentName}.`,
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

/** Return whether this path names one valid ACP authorization transaction. */
export function isAcpAuthorizationPath(pathname: string): boolean {
  if (!pathname.startsWith(ACP_AUTHORIZATION_PATH_PREFIX)) return false;
  return UUID_PATTERN.test(
    pathname.slice(ACP_AUTHORIZATION_PATH_PREFIX.length),
  );
}

/** Complete one ACP browser authorization through dashboard identity policy. */
export async function handleDashboardAcpAuthorization(args: {
  agentName: string;
  allowedDomains: string[];
  allowedEmails: string[];
  auth?: DashboardAuth;
  authRequired: boolean;
  authorization: DashboardAcpAuthorization;
  basePath: string;
  canonicalBaseURL?: string;
  localViewerEmail: string;
  request: Request;
  transactionId: string;
}): Promise<Response> {
  if (!UUID_PATTERN.test(args.transactionId)) {
    return renderResult(args.agentName, "expired");
  }
  const canonicalUrl = canonicalAuthorizationUrl(
    args.request,
    args.canonicalBaseURL,
  );
  if (canonicalUrl) return Response.redirect(canonicalUrl, 302);

  let session: DashboardSession;
  if (!args.authRequired) {
    session = {
      user: { email: args.localViewerEmail, emailVerified: true },
    };
  } else {
    if (!args.auth) {
      throw new Error("ACP authorization requires dashboard auth");
    }
    const browserSession = await args.auth.getSession(args.request);
    if (!browserSession) {
      return Response.redirect(
        loginUrl(args.request, args.basePath, args.canonicalBaseURL),
        302,
      );
    }
    if (
      !dashboardSessionIsAuthorized(
        browserSession,
        args.allowedDomains,
        args.allowedEmails,
      )
    ) {
      return renderResult(args.agentName, "forbidden");
    }
    session = sanitizeDashboardSession(browserSession);
  }

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

  const email = verifiedDashboardSessionEmail(session);
  if (!email) return renderResult(args.agentName, "forbidden");
  const user = await resolveViewerUser(email);
  if (!user) throw new Error("Authenticated ACP user could not be resolved");
  const result = await args.authorization.complete(
    args.transactionId,
    user,
    userCode,
  );
  return renderResult(args.agentName, result);
}
