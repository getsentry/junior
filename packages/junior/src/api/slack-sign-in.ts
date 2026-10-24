/** Own the dashboard-authenticated page that lets Slack users use Junior. */
import type { User } from "@sentry/junior-plugin-api";
import { getSqlExecutor } from "@/chat/db";
import { markSlackIdentitiesSignedIn } from "@/chat/identities/sql";

export const SLACK_SIGN_IN_PATH = "/_junior/slack/sign-in";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderPage(status: number, title: string, message: string): Response {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;background:#000;color:#fff;font-family:ui-sans-serif,system-ui,sans-serif">
  <main style="min-height:100vh;display:grid;place-items:center;padding:2rem">
    <section style="max-width:32rem;border-left:4px solid #a78bfa;padding-left:1rem">
      <h1 style="margin:0 0 .75rem;font-size:2rem">${escapeHtml(title)}</h1>
      <p style="margin:0;color:#b8b8b8;line-height:1.5">${escapeHtml(message)}</p>
    </section>
  </main>
</body>
</html>`,
    {
      status,
      headers: {
        "cache-control": "no-store",
        "content-security-policy": "frame-ancestors 'none'",
        "content-type": "text/html; charset=utf-8",
        "x-frame-options": "DENY",
      },
    },
  );
}

/**
 * Mark the Slack accounts of one dashboard-authenticated user as signed in.
 *
 * The dashboard enforces its Google account allowlist before this runs. A
 * Slack account matches only when its verified Slack email links it to the
 * same user.
 */
export async function handleSlackSignInPage(args: {
  agentName: string;
  user: User;
}): Promise<Response> {
  const count = await markSlackIdentitiesSignedIn(
    getSqlExecutor(),
    args.user.id,
  );
  if (count === 0) {
    return renderPage(
      403,
      "No Slack account matches",
      `No Slack account uses ${args.user.email}. Sign in with the account that matches your Slack email.`,
    );
  }
  return renderPage(
    200,
    "You are signed in",
    `Return to Slack and send your message to ${args.agentName} again.`,
  );
}
