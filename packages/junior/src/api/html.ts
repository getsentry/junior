/** Escape text before it enters server-rendered HTML. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** Return true when a browser request comes from its own URL origin. */
export function requestHasSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return (
    origin !== null && URL.parse(origin)?.origin === new URL(request.url).origin
  );
}

/**
 * Render one sign-in page that browsers cannot frame or cache. `bodyHtml`
 * follows the heading, and the caller escapes every value in it.
 */
export function renderHtmlPage(page: {
  bodyHtml: string;
  /** Page headers, such as its `content-security-policy`. */
  headers: Record<string, string>;
  status: number;
  title: string;
}): Response {
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
${page.bodyHtml}
    </section>
  </main>
</body>
</html>`,
    {
      status: page.status,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
        "x-frame-options": "DENY",
        ...page.headers,
      },
    },
  );
}
