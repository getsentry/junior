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

/*
 * Sign-in page styles. Colors and fonts follow the dashboard tokens in
 * `junior-dashboard/src/tailwind.css`. Pages load no resources, so the
 * dashboard fonts apply only when the system has them.
 */
const PAGE_STYLE = `
:root {
  color-scheme: dark;
  --bg: #060607;
  --panel: #0c0c0e;
  --raised: #101013;
  --hover: #17171a;
  --text: #f4f4f5;
  --muted: #a1a1aa;
  --faint: #8a8a93;
  --solid: #ffffff;
  --subtle: #c4c4cc;
  --inverse: #000000;
  --focus: #beaaff;
  --border: rgb(255 255 255 / 0.08);
  --border-emphasis: rgb(255 255 255 / 0.15);
  --border-heavy: rgb(255 255 255 / 0.3);
  --warning-bg: rgb(251 191 36 / 0.08);
  --warning-border: rgb(251 191 36 / 0.3);
  --warning-text: #fcd34d;
  --shadow: 0 16px 40px rgb(0 0 0 / 0.5);
}
@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --bg: #ffffff;
    --panel: #f9f9fa;
    --raised: #ffffff;
    --hover: #f1f1f3;
    --text: #18181b;
    --muted: #52525b;
    --faint: #71717a;
    --solid: #09090b;
    --subtle: #3f3f46;
    --inverse: #ffffff;
    --focus: #7553ff;
    --border: rgb(0 0 0 / 0.09);
    --border-emphasis: rgb(0 0 0 / 0.16);
    --border-heavy: rgb(0 0 0 / 0.32);
    --warning-bg: rgb(245 158 11 / 0.1);
    --warning-border: rgb(217 119 6 / 0.35);
    --warning-text: #92400e;
    --shadow: 0 16px 40px rgb(0 0 0 / 0.08);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px 16px;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.5 Inter, -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
}
main {
  width: 100%;
  max-width: 28rem;
  padding: 32px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  box-shadow: var(--shadow);
}
h1, h2 { font-family: Outfit, "Avenir Next", Avenir, "Segoe UI", system-ui, sans-serif; }
h1 { margin: 0 0 8px; font-size: 1.5rem; line-height: 1.25; font-weight: 600; text-wrap: balance; overflow-wrap: anywhere; }
h2 { margin: 24px 0 8px; font-size: 0.875rem; line-height: 1.35; font-weight: 600; color: var(--subtle); }
p { margin: 0 0 16px; color: var(--muted); text-wrap: pretty; }
p:last-child { margin-bottom: 0; }
strong { color: var(--text); font-weight: 600; }
code { font: 0.8125rem/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--faint); overflow-wrap: anywhere; }
.list { margin: 0 0 24px; padding: 0; list-style: none; border: 1px solid var(--border); border-radius: 8px; background: var(--raised); }
.list li { padding: 12px 16px; font-size: 0.875rem; line-height: 1.35; }
.list li + li { border-top: 1px solid var(--border); }
.list code { display: block; margin-top: 4px; }
.warning { margin: 0 0 24px; padding: 12px 16px; border: 1px solid var(--warning-border); border-radius: 8px; background: var(--warning-bg); color: var(--warning-text); font-size: 0.875rem; line-height: 1.35; }
.actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
label { display: block; margin: 0 0 16px; font-size: 0.875rem; font-weight: 600; color: var(--subtle); }
label input {
  display: block; width: 100%; min-height: 44px; margin-top: 8px; padding: 8px 12px;
  border: 1px solid var(--border-emphasis); border-radius: 6px; background: var(--raised);
  color: var(--text); font: 1rem/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
button {
  width: 100%; min-height: 44px; padding: 8px 16px; border: 1px solid var(--border-emphasis); border-radius: 6px;
  background: var(--raised); color: var(--text); cursor: pointer;
  font-family: inherit; font-size: 0.875rem; font-weight: 600; line-height: 1; transition: background-color 0.2s ease, border-color 0.2s ease;
}
button:hover { border-color: var(--border-heavy); background: var(--hover); }
button.primary { border-color: var(--solid); background: var(--solid); color: var(--inverse); }
button.primary:hover { border-color: var(--subtle); background: var(--subtle); }
button:focus-visible, label input:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
@media (max-width: 480px) { main { padding: 24px; } }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
`;

/**
 * Render one sign-in page that browsers cannot frame or cache. `bodyHtml`
 * follows the heading, and the caller escapes every value in it. Callers use
 * the `list`, `warning`, `actions`, and `primary` classes from `PAGE_STYLE`.
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
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <main>
    <h1>${escapeHtml(page.title)}</h1>
${page.bodyHtml}
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
