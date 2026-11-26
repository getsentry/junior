import { escapeHtml, renderHtmlPage } from "@/api/html";

/**
 * Return the CSP `form-action` source of a client redirect. A custom-scheme
 * redirect, such as the iOS app's, has the origin "null", which matches
 * nothing in CSP, so its scheme is allowed instead.
 */
export function formActionSource(redirectUri: string): string {
  const url = new URL(redirectUri);
  return url.protocol === "https:" || url.protocol === "http:"
    ? url.origin
    : url.protocol;
}

/**
 * Read the action and form token of a consent form POST.
 */
export async function readConsentForm(
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

/**
 * Render one MCP sign-in page. It loads no resources and sends no referrer to
 * other origins.
 */
export function renderMcpPage(page: {
  /** HTML that follows the message. Callers escape every value in it. */
  bodyHtml?: string;
  /**
   * Extra CSP source, an origin or a scheme, that a form on the page may
   * reach. The consent form redirects to the client, and `form-action` also
   * applies to that redirect.
   */
  formActionSource?: string;
  message: string;
  status: number;
  title: string;
}): Response {
  const formAction = [
    "'self'",
    ...(page.formActionSource ? [page.formActionSource] : []),
  ];
  const message = `    <p>${escapeHtml(page.message)}</p>`;
  return renderHtmlPage({
    bodyHtml: page.bodyHtml ? `${message}\n${page.bodyHtml}` : message,
    headers: {
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action ${formAction.join(" ")}`,
      // Not `no-referrer`: browsers then send `Origin: null` on the consent
      // POST, which fails the same-origin check. The client redirect is
      // cross-origin, so it still gets no referrer.
      "referrer-policy": "same-origin",
    },
    status: page.status,
    title: page.title,
  });
}
