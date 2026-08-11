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
  const html = `<!DOCTYPE html>
<html>
<head><title>${title}</title></head>
<body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0;">
  <div style="text-align: center; max-width: 480px;">
    <h1>${title}</h1>
    <p>${message}</p>
    <p style="margin-top: 2rem; color: #666; font-size: 0.9em;">${footerMessage}</p>
  </div>
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
