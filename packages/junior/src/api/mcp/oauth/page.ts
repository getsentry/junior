import { escapeHtml, renderHtmlPage } from "@/api/html";

/**
 * Render one MCP sign-in page. It loads no resources and sends no referrer to
 * other origins.
 */
export function renderMcpPage(page: {
  /** HTML that follows the message. Callers escape every value in it. */
  bodyHtml?: string;
  /**
   * Extra origin that a form on the page may reach. The consent form
   * redirects to the client, and `form-action` also applies to that redirect.
   */
  formOrigin?: string;
  message: string;
  status: number;
  title: string;
}): Response {
  const formAction = ["'self'", ...(page.formOrigin ? [page.formOrigin] : [])];
  const message = `      <p style="margin:0 0 1rem;color:#b8b8b8;line-height:1.5">${escapeHtml(page.message)}</p>`;
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
