import { botConfig } from "@/chat/config";

/*
 * Core cannot import the dashboard package, so this page copies the dashboard
 * design tokens it uses. Keep these values in sync with the `@theme` block in
 * `packages/junior-dashboard/src/tailwind.css`. Status colors are the Tailwind
 * emerald and rose palette steps that dashboard status components use.
 */
const CALLBACK_PAGE_STYLES = `
    :root {
      color-scheme: dark;
      --font-display: "Outfit", "Avenir Next", Avenir, "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
      --font-sans: "Inter", -apple-system, "system-ui", "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif;
      --ink: #000000;
      --surface-raised: #101013;
      --text-solid: #ffffff;
      --text: #f4f4f5;
      --text-muted: #a1a1aa;
      --text-faint: #8a8a93;
      --border-subtle: rgb(255 255 255 / 0.06);
      --border-emphasis: rgb(255 255 255 / 0.15);
      --emerald-100: oklch(95% 0.052 163.051);
      --emerald-300: oklch(84.5% 0.143 164.978);
      --rose-100: oklch(94.1% 0.03 12.58);
      --rose-300: oklch(81% 0.117 11.638);
    }

    * { box-sizing: border-box; }

    html { text-rendering: geometricPrecision; }

    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      padding: 2rem 1rem;
      background: var(--ink);
      color: var(--text-solid);
      font-family: var(--font-sans);
    }

    main {
      width: 100%;
      max-width: 32rem;
      padding: 1.5rem;
      background: var(--surface-raised);
      border: 1px solid var(--border-emphasis);
      border-radius: 0.5rem;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      font-weight: 700;
    }

    .brand-mark {
      width: 2.25rem;
      height: 2.25rem;
      display: grid;
      flex-shrink: 0;
      place-items: center;
      background: var(--ink);
      color: var(--text-solid);
      font-size: 0.875rem;
      font-weight: 900;
      line-height: 1;
      user-select: none;
    }

    .result {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 0.75rem;
      margin-top: 1.5rem;
    }

    .status {
      width: 2rem;
      height: 2rem;
      display: grid;
      place-items: center;
      border-radius: 0.5rem;
    }

    .status.success {
      color: var(--emerald-100);
      background: color-mix(in oklab, var(--emerald-300) 15%, transparent);
    }

    .status.error {
      color: var(--rose-100);
      background: color-mix(in oklab, var(--rose-300) 15%, transparent);
    }

    h1 {
      margin: 0;
      color: var(--text);
      font-family: var(--font-display);
      font-size: 1.5rem;
      font-weight: 600;
      line-height: 1.25;
    }

    .message {
      margin: 0.5rem 0 0;
      color: var(--text-muted);
      font-size: 1rem;
      line-height: 1.5;
    }

    .footer {
      margin: 1.5rem 0 0;
      padding-top: 1rem;
      color: var(--text-faint);
      border-top: 1px solid var(--border-subtle);
      font-size: 0.875rem;
      line-height: 1.35;
    }
`;

const SUCCESS_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

const ERROR_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>';

/** Build pre-escaped callback HTML with the shared response security policy. */
export function htmlCallbackResponse(
  title: string,
  message: string,
  status: number,
  options: { footerMessage?: string } = {},
): Response {
  const footerMessage =
    options.footerMessage ??
    `You can close this tab and return to ${botConfig.userName}.`;
  const isSuccess = status >= 200 && status < 300;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="theme-color" content="#000000">
  <title>${title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@300;400;500;600;700&display=swap">
  <style>${CALLBACK_PAGE_STYLES}</style>
</head>
<body>
  <main>
    <div class="brand"><span class="brand-mark" aria-hidden="true">Jr</span>${botConfig.userName}</div>
    <div class="result" role="${isSuccess ? "status" : "alert"}">
      <div class="status ${isSuccess ? "success" : "error"}" aria-hidden="true">${isSuccess ? SUCCESS_ICON : ERROR_ICON}</div>
      <div>
        <h1>${title}</h1>
        <p class="message">${message}</p>
      </div>
    </div>
    <p class="footer">${footerMessage}</p>
  </main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
