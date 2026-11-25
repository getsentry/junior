import { escapeHtml, renderHtmlPage } from "@/api/html";

function page(status: number, title: string, bodyHtml: string): Response {
  return renderHtmlPage({
    bodyHtml,
    headers: {
      // The form posts here, and the reply redirects to the app's scheme.
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self' junior-ios:",
      // Not `no-referrer`: browsers then send `Origin: null` on the POST,
      // which fails the same-origin check.
      "referrer-policy": "same-origin",
    },
    status,
    title,
  });
}

/** Ask the signed-in person to confirm the iOS sign-in. */
export function renderIosSignInPage(args: {
  agentName: string;
  codeChallenge: string;
  email: string;
  state: string;
}): Response {
  return page(
    200,
    `Sign in to ${args.agentName} on iOS`,
    `    <p>You are signed in as <strong>${escapeHtml(args.email)}</strong>.</p>
    <p class="warning" role="note">Only continue if you started this sign-in in the ${escapeHtml(args.agentName)} app.</p>
    <form method="post" class="actions">
      <input type="hidden" name="code_challenge" value="${escapeHtml(args.codeChallenge)}">
      <input type="hidden" name="state" value="${escapeHtml(args.state)}">
      <button type="submit" class="primary">Continue</button>
    </form>`,
  );
}

/** Tell the person to start again from the app. */
export function renderIosSignInBlockedPage(): Response {
  return page(
    400,
    "Request blocked",
    "    <p>Return to the app and sign in again.</p>",
  );
}
