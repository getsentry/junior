import { escapeHtml, renderHtmlPage } from "@/api/html";

/**
 * Render one MCP sign-in page. It loads no resources and sends no referrer to
 * other origins.
 */
export function renderMcpPage(page: {
  /** HTML that follows the message. Callers escape every value in it. */
  bodyHtml?: string;
  /**
   * Client origin that the consent form redirects to. Chrome checks
   * `form-action` on every redirect after a form POST, and a client callback
   * can redirect again to another origin that Junior cannot know. The page
   * then also allows every `https:` target. The only form is Junior's own, and
   * every value on the page is escaped.
   */
  formOrigin?: string;
  message: string;
  status: number;
  title: string;
}): Response {
  const formAction = [
    "'self'",
    ...(page.formOrigin ? [page.formOrigin, "https:"] : []),
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
