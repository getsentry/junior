import { botConfig } from "@/chat/config";

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
  const statusClass = isSuccess ? "success" : "error";
  const statusIcon = isSuccess ? "" : "!";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${title}</title>
  <style>
    :root {
      color-scheme: light dark;
      --canvas: #f4f1fa;
      --surface: #ffffff;
      --text: #211a2c;
      --muted: #6e6479;
      --border: #ded7e8;
      --accent: #6c5fc7;
      --success: #16835c;
      --success-soft: #ddf5ea;
      --error: #bc3d50;
      --error-soft: #fce7eb;
      --shadow: 0 24px 64px rgba(45, 31, 63, 0.14);
    }

    * { box-sizing: border-box; }

    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      padding: 24px;
      background: var(--canvas);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    main {
      width: min(100%, 480px);
      padding: 48px 40px 40px;
      text-align: center;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 24px;
      box-shadow: var(--shadow);
    }

    .brand {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 32px;
      color: var(--muted);
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .brand-mark {
      width: 10px;
      height: 10px;
      background: var(--accent);
      border-radius: 3px;
      transform: rotate(12deg);
    }

    .status {
      width: 64px;
      height: 64px;
      margin: 0 auto 24px;
      display: grid;
      place-items: center;
      border-radius: 20px;
      font-size: 32px;
      font-weight: 750;
      line-height: 1;
    }

    .status.success { color: var(--success); background: var(--success-soft); }
    .status.success::before {
      content: "";
      width: 12px;
      height: 24px;
      margin-top: -5px;
      border-right: 4px solid currentColor;
      border-bottom: 4px solid currentColor;
      transform: rotate(45deg);
    }
    .status.error { color: var(--error); background: var(--error-soft); }

    h1 {
      margin: 0;
      font-size: clamp(28px, 7vw, 36px);
      line-height: 1.12;
      letter-spacing: -0.035em;
    }

    .message {
      margin: 16px auto 0;
      color: var(--muted);
      font-size: 17px;
      line-height: 1.6;
    }

    .footer {
      margin: 32px 0 0;
      padding-top: 24px;
      color: var(--muted);
      border-top: 1px solid var(--border);
      font-size: 14px;
      line-height: 1.5;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --canvas: #15121a;
        --surface: #211c28;
        --text: #f6f1fb;
        --muted: #b8adbf;
        --border: #3a3243;
        --accent: #a99af0;
        --success: #72d6ad;
        --success-soft: #193c30;
        --error: #ff9aaa;
        --error-soft: #48262e;
        --shadow: 0 24px 64px rgba(0, 0, 0, 0.36);
      }
    }

    @media (max-width: 520px) {
      body { padding: 16px; }
      main { padding: 40px 24px 32px; border-radius: 20px; }
    }
  </style>
</head>
<body>
  <main>
    <div class="brand"><span class="brand-mark" aria-hidden="true"></span>Junior</div>
    <div class="status ${statusClass}" aria-hidden="true">${statusIcon}</div>
    <h1>${title}</h1>
    <p class="message">${message}</p>
    <p class="footer">${footerMessage}</p>
  </main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
