import { escapeHtml } from "@/api/html";

/** One server-rendered MCP sign-in page. */
type McpPage = {
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
};

/** Render one MCP sign-in page with headers that block framing and caching. */
export function renderMcpPage(page: McpPage): Response {
  const formAction = ["'self'", ...(page.formOrigin ? [page.formOrigin] : [])];
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(page.title)}</title>
</head>
<body style="margin:0;background:#000;color:#fff;font-family:ui-sans-serif,system-ui,sans-serif">
  <main style="min-height:100vh;display:grid;place-items:center;padding:2rem">
    <section style="max-width:32rem;border-left:4px solid #a78bfa;padding-left:1rem">
      <h1 style="margin:0 0 .75rem;font-size:2rem">${escapeHtml(page.title)}</h1>
      <p style="margin:0 0 1rem;color:#b8b8b8;line-height:1.5">${escapeHtml(page.message)}</p>
      ${page.bodyHtml ?? ""}
    </section>
  </main>
</body>
</html>`,
    {
      status: page.status,
      headers: {
        "cache-control": "no-store",
        "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action ${formAction.join(" ")}`,
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
      },
    },
  );
}
